import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BACKUP_FORMAT_VERSION,
  buildAccountIdMap,
  buildCategoryIdMap,
  classifyTransactions,
  parseBackup,
  previewBackupRestore,
  commitBackupRestore,
} from "./backup-restore";
import { DuplicateIndex } from "@/lib/import/dedupe";
import { prisma } from "../db";
import { undoImport } from "./import";

function makeBackup(overrides: Partial<Record<string, unknown>> & { transactions?: unknown[] } = {}) {
  return {
    formatVersion: 1,
    exportedAt: "2026-07-20T00:00:00.000Z",
    user: { name: "Test", email: "backup-test@ledgerly.app", currency: "INR" },
    accounts: [],
    categories: [],
    transactions: [],
    ...overrides,
  };
}

describe("parseBackup", () => {
  it("extracts accounts, categories, transactions and flags unknown top-level keys", () => {
    const json = makeBackup({
      accounts: [{ id: "a1", name: "HDFC", type: "DEBIT" }],
      categories: [{ id: "c1", name: "Food", kind: "EXPENSE" }],
      transactions: [{ id: "t1", type: "EXPENSE", amount: 420, merchant: "Swiggy", occurredAt: "2026-07-01" }],
      loanEntries: [{ id: "l1" }],
    });
    const parsed = parseBackup(json);
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.categories).toHaveLength(1);
    expect(parsed.transactions).toHaveLength(1);
    expect(parsed.unsupported).toEqual(["loanEntries"]);
  });

  it("rejects non-object input", () => {
    expect(() => parseBackup("nope")).toThrow();
    expect(() => parseBackup(null)).toThrow();
  });

  it("tolerates a backup with no formatVersion (treats as legacy)", () => {
    const parsed = parseBackup({ accounts: [], categories: [], transactions: [] });
    expect(parsed.formatVersion).toBeNull();
    expect(parsed.accounts).toEqual([]);
  });

  it("reports BACKUP_FORMAT_VERSION constant matches the version it writes/reads", () => {
    expect(BACKUP_FORMAT_VERSION).toBe(1);
  });
});

describe("classifyTransactions", () => {
  const accountIdMap = new Map([["a1", "acc-1"], ["a2", "acc-2"]]);
  const categoryIdMap = new Map([["c1", "cat-1"]]);
  const dupIndex = new DuplicateIndex([]);

  it("accepts a valid expense", () => {
    const [out] = classifyTransactions(
      [{ id: "t1", type: "EXPENSE", amount: 420, accountId: "a1", categoryId: "c1", merchant: "Swiggy", occurredAt: "2026-07-01" }],
      accountIdMap,
      categoryIdMap,
      dupIndex
    );
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    expect(out.ymd).toBe("2026-07-01");
    expect(out.amountPaise).toBe(420);
    expect(out.accountId).toBe("acc-1");
    expect(out.categoryId).toBe("cat-1");
    expect(out.toAccountId).toBeNull();
  });

  it("rejects missing type", () => {
    const [out] = classifyTransactions([{ amount: 420, merchant: "Swiggy", occurredAt: "2026-07-01" }], accountIdMap, categoryIdMap, new DuplicateIndex([]));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected reject");
    expect(out.reason).toBe("missing or unsupported type");
  });

  it("rejects zero and negative amounts", () => {
    const index = new DuplicateIndex([]);
    const [zero] = classifyTransactions([{ type: "EXPENSE", amount: 0, merchant: "A", occurredAt: "2026-07-01" }], accountIdMap, categoryIdMap, index);
    const [neg] = classifyTransactions([{ type: "EXPENSE", amount: -10, merchant: "B", occurredAt: "2026-07-02" }], accountIdMap, categoryIdMap, index);
    expect(zero.ok).toBe(false);
    expect((zero as { reason: string }).reason).toBe("amount missing or not a positive number");
    expect(neg.ok).toBe(false);
    expect((neg as { reason: string }).reason).toBe("amount missing or not a positive number");
  });

  it("rejects missing merchant or date", () => {
    const index = new DuplicateIndex([]);
    const [noMerchant] = classifyTransactions([{ type: "EXPENSE", amount: 100, occurredAt: "2026-07-01" }], accountIdMap, categoryIdMap, index);
    const [noDate] = classifyTransactions([{ type: "EXPENSE", amount: 100, merchant: "A" }], accountIdMap, categoryIdMap, index);
    expect(noMerchant.ok).toBe(false);
    expect((noMerchant as { reason: string }).reason).toBe("merchant missing");
    expect(noDate.ok).toBe(false);
    expect((noDate as { reason: string }).reason).toBe("date missing or invalid");
  });

  it("rejects transactions referencing accounts missing from the backup", () => {
    const [out] = classifyTransactions(
      [{ type: "EXPENSE", amount: 100, accountId: "missing", merchant: "A", occurredAt: "2026-07-01" }],
      accountIdMap,
      categoryIdMap,
      new DuplicateIndex([])
    );
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toBe("referenced account missing");
  });

  it("rejects transfers with missing destination or one missing side", () => {
    const index = new DuplicateIndex([]);
    const [noDest] = classifyTransactions(
      [{ type: "TRANSFER", amount: 100, accountId: "a1", toAccountId: "missing", merchant: "X", occurredAt: "2026-07-01" }],
      accountIdMap,
      categoryIdMap,
      index
    );
    const [noSource] = classifyTransactions(
      [{ type: "TRANSFER", amount: 100, toAccountId: "a2", merchant: "Y", occurredAt: "2026-07-02" }],
      accountIdMap,
      categoryIdMap,
      index
    );
    expect(noDest.ok).toBe(false);
    expect((noDest as { reason: string }).reason).toBe("transfer destination account missing");
    expect(noSource.ok).toBe(false);
    expect((noSource as { reason: string }).reason).toBe("transfer needs source and destination accounts");
  });

  it("accepts a valid transfer and resolves both accounts", () => {
    const [out] = classifyTransactions(
      [{ type: "TRANSFER", amount: 500, accountId: "a1", toAccountId: "a2", merchant: "Self", occurredAt: "2026-07-03" }],
      accountIdMap,
      categoryIdMap,
      new DuplicateIndex([])
    );
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    expect(out.accountId).toBe("acc-1");
    expect(out.toAccountId).toBe("acc-2");
  });

  it("detects duplicates within the backup", () => {
    const index = new DuplicateIndex([]);
    const txs = [
      { type: "EXPENSE", amount: 100, merchant: "Same", occurredAt: "2026-07-01" },
      { type: "EXPENSE", amount: 100, merchant: "Same", occurredAt: "2026-07-01" },
    ];
    const out = classifyTransactions(txs, accountIdMap, categoryIdMap, index);
    expect(out[0].ok).toBe(true);
    expect(out[1].ok).toBe(false);
    expect((out[1] as { reason: string }).reason).toBe("duplicate");
  });

  it("builds id maps from backup arrays", () => {
    expect([...buildAccountIdMap([{ id: "x" }]).entries()]).toEqual([["x", "x"]]);
    expect([...buildCategoryIdMap([{ id: "y" }]).entries()]).toEqual([["y", "y"]]);
  });
});

describe("previewBackupRestore integration", () => {
  let userId: string;

  beforeAll(async () => {
    const existing = await prisma.user.findUnique({ where: { email: "backup-test@ledgerly.app" } });
    if (existing) await prisma.user.delete({ where: { id: existing.id } });
    const user = await prisma.user.create({ data: { name: "Test", email: "backup-test@ledgerly.app", emailVerified: true } });
    userId = user.id;
    await prisma.account.create({ data: { userId, name: "HDFC Savings", type: "BANK", balance: 10_000, openingBalance: 10_000 } });
    await prisma.category.create({ data: { userId, name: "Food", kind: "EXPENSE" } });
  });

  beforeEach(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.importBatch.deleteMany({ where: { userId } });
  });

  it("summarizes accounts/categories and detects unsupported sections", async () => {
    const backup = makeBackup({
      accounts: [
        { id: "a1", name: "HDFC Savings", type: "BANK" },
        { id: "a2", name: "Cash Wallet", type: "CASH" },
      ],
      categories: [
        { id: "c1", name: "Food", kind: "EXPENSE" },
        { id: "c2", name: "Salary", kind: "INCOME" },
      ],
      budgets: [{ id: "b1" }],
    });
    const preview = await previewBackupRestore(userId, backup);
    expect(preview.formatVersion).toBe(1);
    expect(preview.transactions).toBe(0);
    expect(preview.validTransactions).toBe(0);
    expect(preview.newAccounts).toBe(1);
    expect(preview.matchedAccounts).toBe(1);
    expect(preview.newCategories).toBe(1);
    expect(preview.matchedCategories).toBe(1);
    expect(preview.unsupported).toEqual(["budgets"]);
  });

  it("validates, dedupes and counts invalid rows", async () => {
    await prisma.transaction.create({
      data: {
        userId,
        type: "EXPENSE",
        amount: 500,
        merchant: "Dup",
        occurredAt: new Date("2026-07-05T12:00:00+05:30"),
        accountId: null,
      },
    });
    const backup = makeBackup({
      transactions: [
        { type: "EXPENSE", amount: 500, merchant: "Dup", occurredAt: "2026-07-05" },
        { type: "INCOME", amount: 1200, merchant: "Salary", occurredAt: "2026-07-06" },
        { type: "EXPENSE", amount: -5, merchant: "Bad", occurredAt: "2026-07-07" },
        { type: "EXPENSE", amount: 100, accountId: "missing", merchant: "Nope", occurredAt: "2026-07-08" },
      ],
    });
    const preview = await previewBackupRestore(userId, backup);
    expect(preview.transactions).toBe(4);
    expect(preview.validTransactions).toBe(1);
    expect(preview.duplicateTransactions).toBe(1);
    expect(preview.invalidTransactions).toBe(2);
    expect(preview.invalidBreakdown["amount missing or not a positive number"]).toBe(1);
    expect(preview.invalidBreakdown["referenced account missing"]).toBe(1);
    expect(preview.sample).toHaveLength(1);
    expect(preview.sample[0].merchant).toBe("Salary");
  });
});

describe("commitBackupRestore integration", () => {
  let userId: string;
  let accountId: string;

  beforeAll(async () => {
    const existing = await prisma.user.findUnique({ where: { email: "backup-test@ledgerly.app" } });
    if (existing) await prisma.user.delete({ where: { id: existing.id } });
    const user = await prisma.user.create({ data: { name: "Test", email: "backup-test@ledgerly.app", emailVerified: true } });
    userId = user.id;
    const acc = await prisma.account.create({ data: { userId, name: "HDFC Savings", type: "BANK", balance: 10_000, openingBalance: 10_000 } });
    accountId = acc.id;
  });

  beforeEach(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.importBatch.deleteMany({ where: { userId } });
  });

  it("restores transactions and creates missing accounts/categories", async () => {
    const backup = makeBackup({
      accounts: [
        { id: "a1", name: "HDFC Savings", type: "BANK" },
        { id: "a2", name: "Cash Wallet", type: "CASH", balance: 2_000, openingBalance: 2_000 },
      ],
      categories: [
        { id: "c1", name: "Food", kind: "EXPENSE" },
        { id: "c2", name: "Salary", kind: "INCOME" },
      ],
      transactions: [
        { id: "t1", type: "EXPENSE", amount: 500, accountId: "a1", categoryId: "c1", merchant: "Lunch", occurredAt: "2026-07-10" },
        { id: "t2", type: "INCOME", amount: 10_000, accountId: "a1", categoryId: "c2", merchant: "Salary", occurredAt: "2026-07-11" },
        { id: "t3", type: "TRANSFER", amount: 1_000, accountId: "a1", toAccountId: "a2", merchant: "Self", occurredAt: "2026-07-12" },
      ],
    });
    const result = await commitBackupRestore(userId, backup);
    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);

    const created = await prisma.transaction.findMany({ where: { userId, deletedAt: null }, orderBy: { occurredAt: "asc" } });
    expect(created).toHaveLength(3);
    const [expense, income, transfer] = created;
    expect(expense.type + ":" + expense.merchant + ":" + Number(expense.amount)).toBe("EXPENSE:Lunch:500");
    expect(income.type + ":" + income.merchant + ":" + Number(income.amount)).toBe("INCOME:Salary:10000");

    expect(transfer.type + ":" + transfer.merchant + ":" + Number(transfer.amount)).toBe("TRANSFER:Self:1000");
    expect(transfer.accountId).toBeTruthy();
    expect(transfer.toAccountId).toBeTruthy();
    expect(transfer.accountId).not.toBe(transfer.toAccountId);

    const accounts = await prisma.account.findMany({ where: { userId } });
    expect(accounts).toHaveLength(2);

    const batch = await prisma.importBatch.findUnique({ where: { id: result.batchId } });
    expect(batch?.importedCount).toBe(3);
    expect(batch?.status).toBe("COMMITTED");
  });

  it("remaps duplicate backup IDs and respects name matching", async () => {
    const backup = makeBackup({
      accounts: [{ id: "a1", name: "HDFC Savings", type: "BANK" }],
      transactions: [{ id: "t1", type: "EXPENSE", amount: 300, accountId: "a1", merchant: "Coffee", occurredAt: "2026-07-13" }],
    });
    const result = await commitBackupRestore(userId, backup);
    const tx = await prisma.transaction.findFirstOrThrow({ where: { importBatchId: result.batchId } });
    expect(tx.accountId).toBe(accountId);
  });

  it(" skips invalid rows and reports counts", async () => {
    const backup = makeBackup({
      transactions: [
        { type: "EXPENSE", amount: 100, merchant: "OK", occurredAt: "2026-07-14" },
        { type: "EXPENSE", amount: 0, merchant: "Bad", occurredAt: "2026-07-15" },
      ],
    });
    const result = await commitBackupRestore(userId, backup);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("undo removes restored transactions and reverses balances", async () => {
    const before = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    const backup = makeBackup({
      accounts: [{ id: "a1", name: "HDFC Savings", type: "BANK" }],
      transactions: [{ type: "INCOME", amount: 2_000, accountId: "a1", merchant: "Refund", occurredAt: "2026-07-16" }],
    });
    const { batchId } = await commitBackupRestore(userId, backup);
    const after = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(Number(after.balance) - Number(before.balance)).toBe(2_000);

    await undoImport(userId, batchId);
    const undone = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(Number(undone.balance)).toBe(Number(before.balance));

    const remaining = await prisma.transaction.count({ where: { userId, deletedAt: null } });
    expect(remaining).toBe(0);
    const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
    expect(batch?.status).toBe("UNDONE");
  });

  it("rejects malformed JSON in actions by propagating parseBackup error", async () => {
    await expect(previewBackupRestore(userId, "not-object")).rejects.toThrow(/Not a valid Ledgerly backup file/);
    await expect(commitBackupRestore(userId, null)).rejects.toThrow(/Not a valid Ledgerly backup file/);
  });
});
