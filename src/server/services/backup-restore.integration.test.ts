// Database-backed tests for the backup restore engine.
//
// These need a live Postgres (DATABASE_URL) and are NOT part of `npm run test`.
// Run them with `npm run test:integration`; CI runs them in a job with a
// Postgres service container. Keeping them out of the unit run is what lets the
// unit suite stay green on a machine (or CI job) with no database.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { commitBackupRestore, previewBackupRestore } from "./backup-restore";
import { createCreditCard, listCreditCards, revealCreditCard } from "./credit-cards";
import { exportFullJson } from "./export";
import { prisma } from "../db";
import { undoImport } from "./import";

const EMAIL = "backup-test@ledgerly.app";

function makeBackup(overrides: Partial<Record<string, unknown>> & { transactions?: unknown[] } = {}) {
  return {
    formatVersion: 1,
    exportedAt: "2026-07-20T00:00:00.000Z",
    user: { name: "Test", email: EMAIL, currency: "INR" },
    accounts: [],
    categories: [],
    transactions: [],
    ...overrides,
  };
}

async function freshUser() {
  const existing = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (existing) await prisma.user.delete({ where: { id: existing.id } });
  const user = await prisma.user.create({ data: { name: "Test", email: EMAIL, emailVerified: true } });
  return user.id;
}

describe("previewBackupRestore integration", () => {
  let userId: string;

  beforeAll(async () => {
    userId = await freshUser();
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
    userId = await freshUser();
    const acc = await prisma.account.create({ data: { userId, name: "HDFC Savings", type: "BANK", balance: 10_000, openingBalance: 10_000 } });
    accountId = acc.id;
  });

  beforeEach(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.importBatch.deleteMany({ where: { userId } });
    await prisma.account.deleteMany({ where: { userId, id: { not: accountId } } });
    await prisma.category.deleteMany({ where: { userId } });
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
    expect(result.createdAccounts).toBe(1);
    expect(result.createdCategories).toBe(2);

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

  it("skips invalid rows and reports counts", async () => {
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

  // Regression: a newly created account was seeded with the backup's exported
  // CLOSING balance and then had every restored transaction replayed onto it,
  // counting each one twice. balance must equal openingBalance + Σ restored ledger.
  it("does not double-count the exported balance on a newly created account", async () => {
    const backup = makeBackup({
      accounts: [{ id: "a1", name: "Fresh Wallet", type: "CASH", openingBalance: 10_000, balance: 9_000 }],
      transactions: [{ type: "EXPENSE", amount: 1_000, accountId: "a1", merchant: "Snacks", occurredAt: "2026-07-17" }],
    });
    await commitBackupRestore(userId, backup);
    const acct = await prisma.account.findFirstOrThrow({ where: { userId, name: "Fresh Wallet" } });
    expect(Number(acct.openingBalance)).toBe(10_000);
    expect(Number(acct.balance)).toBe(9_000);
  });

  // A backup taken after archiving must restore an archived account, not
  // resurrect it into every picker.
  it("preserves the archived state of a restored account", async () => {
    const backup = makeBackup({
      accounts: [
        { id: "a1", name: "Closed Wallet", type: "CASH", openingBalance: 0, isArchived: true },
        { id: "a2", name: "Open Wallet", type: "CASH", openingBalance: 0 },
      ],
    });
    await commitBackupRestore(userId, backup);

    const closed = await prisma.account.findFirstOrThrow({ where: { userId, name: "Closed Wallet" } });
    const open = await prisma.account.findFirstOrThrow({ where: { userId, name: "Open Wallet" } });
    expect(closed.isArchived).toBe(true);
    expect(open.isArchived).toBe(false);
  });

  it("preserves a negative opening balance (credit card carrying a debt)", async () => {
    const backup = makeBackup({
      accounts: [{ id: "a1", name: "Amex Card", type: "CREDIT_CARD", openingBalance: -25_000, balance: -25_000 }],
    });
    await commitBackupRestore(userId, backup);
    const acct = await prisma.account.findFirstOrThrow({ where: { userId, name: "Amex Card" } });
    expect(Number(acct.openingBalance)).toBe(-25_000);
    expect(Number(acct.balance)).toBe(-25_000);
  });

  // Parity: whatever preview promises as restorable, commit must actually import.
  it("imports exactly the count preview promised, including unusable-entity rows", async () => {
    const backup = makeBackup({
      // a2 has an id but no name/type — neither matchable nor creatable.
      accounts: [
        { id: "a1", name: "HDFC Savings", type: "BANK" },
        { id: "a2" },
      ],
      transactions: [
        { type: "EXPENSE", amount: 700, accountId: "a1", merchant: "Parity A", occurredAt: "2026-07-18" },
        { type: "EXPENSE", amount: 800, accountId: "a2", merchant: "Parity B", occurredAt: "2026-07-19" },
      ],
    });
    const preview = await previewBackupRestore(userId, backup);
    const result = await commitBackupRestore(userId, backup);
    expect(preview.unusableAccounts).toBe(1);
    expect(preview.validTransactions).toBe(1);
    expect(result.imported).toBe(preview.validTransactions);
    expect(result.skipped).toBe(preview.duplicateTransactions + preview.invalidTransactions);
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

  // Regression: accounts/categories a restore created used to survive undo, so
  // a restore permanently grew both lists even after being "fully" undone.
  it("undo also removes the accounts and categories the restore created", async () => {
    const backup = makeBackup({
      accounts: [{ id: "a1", name: "Undo Wallet", type: "CASH", openingBalance: 0 }],
      categories: [{ id: "c1", name: "Undo Category", kind: "EXPENSE" }],
      transactions: [
        { type: "EXPENSE", amount: 400, accountId: "a1", categoryId: "c1", merchant: "Undo Me", occurredAt: "2026-07-20" },
      ],
    });
    const { batchId, createdAccounts, createdCategories } = await commitBackupRestore(userId, backup);
    expect(createdAccounts).toBe(1);
    expect(createdCategories).toBe(1);

    const undo = await undoImport(userId, batchId);
    expect(undo.removedAccounts).toBe(1);
    expect(undo.removedCategories).toBe(1);
    expect(undo.retainedAccounts).toEqual([]);
    expect(undo.retainedCategories).toEqual([]);

    expect(await prisma.account.count({ where: { userId, name: "Undo Wallet" } })).toBe(0);
    expect(await prisma.category.count({ where: { userId, name: "Undo Category" } })).toBe(0);
  });

  // The deliberate limit on that reversal: once the user's own data depends on a
  // restored entity, undo keeps it rather than cascading their data away.
  it("undo keeps a created account the user has since transacted against, and reports it", async () => {
    const backup = makeBackup({
      accounts: [{ id: "a1", name: "Kept Wallet", type: "CASH", openingBalance: 0 }],
      categories: [{ id: "c1", name: "Kept Category", kind: "EXPENSE" }],
      transactions: [
        { type: "EXPENSE", amount: 400, accountId: "a1", categoryId: "c1", merchant: "Restored Row", occurredAt: "2026-07-21" },
      ],
    });
    const { batchId } = await commitBackupRestore(userId, backup);
    const wallet = await prisma.account.findFirstOrThrow({ where: { userId, name: "Kept Wallet" } });
    const category = await prisma.category.findFirstOrThrow({ where: { userId, name: "Kept Category" } });

    // The user's own spending on the restored account, outside the batch.
    await prisma.transaction.create({
      data: {
        userId,
        type: "EXPENSE",
        amount: 150,
        accountId: wallet.id,
        categoryId: category.id,
        merchant: "My Own Spend",
        occurredAt: new Date("2026-07-22T12:00:00+05:30"),
      },
    });

    const undo = await undoImport(userId, batchId);
    expect(undo.removedAccounts).toBe(0);
    expect(undo.removedCategories).toBe(0);
    expect(undo.retainedAccounts).toEqual(["Kept Wallet"]);
    expect(undo.retainedCategories).toEqual(["Kept Category"]);

    // The user's transaction survives untouched.
    const mine = await prisma.transaction.findFirstOrThrow({ where: { userId, merchant: "My Own Spend" } });
    expect(mine.deletedAt).toBeNull();
    expect(mine.accountId).toBe(wallet.id);
  });

  it("rejects malformed JSON in actions by propagating parseBackup error", async () => {
    await expect(previewBackupRestore(userId, "not-object")).rejects.toThrow(/Not a valid Ledgerly backup file/);
    await expect(commitBackupRestore(userId, null)).rejects.toThrow(/Not a valid Ledgerly backup file/);
  });
});

// The card path through backup: sealed on the way out, sealed on the way in,
// and readable again at the end without the key ever leaving the server.
describe("credit cards in a backup", () => {
  const SOURCE = "cards-backup-source@ledgerly.app";
  const TARGET = "cards-backup-target@ledgerly.app";
  const PAN = "4111111111111111";
  const CVV = "123";
  let sourceId: string;
  let targetId: string;

  async function user(email: string) {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) await prisma.user.delete({ where: { id: existing.id } });
    return (await prisma.user.create({ data: { name: "Cards Backup", email, emailVerified: true } })).id;
  }

  beforeEach(async () => {
    sourceId = await user(SOURCE);
    targetId = await user(TARGET);
    await createCreditCard(sourceId, {
      nickname: "Amazon Card",
      bank: "HDFC Bank",
      cardholderName: "DIVYESH PATRO",
      cardNumber: PAN,
      expiryMonth: 9,
      expiryYear: 2029,
      cvv: CVV,
      notes: "Groceries 5%",
    });
  });

  it("exports cards without the plaintext appearing anywhere in the file", async () => {
    const backup = await exportFullJson(sourceId);
    const text = JSON.stringify(backup);

    expect(text).not.toContain(PAN);
    expect(text).not.toContain("DIVYESH PATRO");
    expect(text).not.toContain("Groceries 5%");

    // The metadata is there by design — that's what makes the file useful.
    expect(text).toContain("Amazon Card");
    expect(text).toContain("1111");
  });

  it("restores into another account and the card reads back correctly", async () => {
    const backup = await exportFullJson(sourceId);

    const preview = await previewBackupRestore(targetId, backup);
    expect(preview.newCreditCards).toBe(1);
    expect(preview.matchedCreditCards).toBe(0);

    const result = await commitBackupRestore(targetId, backup);
    expect(result.createdCreditCards).toBe(1);

    const [restored] = await listCreditCards(targetId);
    expect(restored.nickname).toBe("Amazon Card");
    expect(restored.last4).toBe("1111");
    expect(restored.keyMatches).toBe(true);

    // Same key, so the sealed bytes that travelled through JSON still decrypt.
    const revealed = await revealCreditCard(targetId, restored.id);
    expect(revealed.cardNumber).toBe(PAN);
    expect(revealed.cvv).toBe(CVV);
    expect(revealed.notes).toBe("Groceries 5%");
  });

  it("does not duplicate cards when the same backup is restored twice", async () => {
    const backup = await exportFullJson(sourceId);
    await commitBackupRestore(targetId, backup);

    const second = await previewBackupRestore(targetId, backup);
    expect(second.newCreditCards).toBe(0);
    expect(second.matchedCreditCards).toBe(1);

    const result = await commitBackupRestore(targetId, backup);
    expect(result.createdCreditCards).toBe(0);
    expect(await prisma.creditCard.count({ where: { userId: targetId } })).toBe(1);
  });

  it("undo removes the cards the restore created", async () => {
    const backup = await exportFullJson(sourceId);
    const { batchId } = await commitBackupRestore(targetId, backup);
    expect(await prisma.creditCard.count({ where: { userId: targetId } })).toBe(1);

    const undo = await undoImport(targetId, batchId);

    expect(undo.removedCreditCards).toBe(1);
    expect(await prisma.creditCard.count({ where: { userId: targetId } })).toBe(0);
  });

  it("leaves a card the user already had alone when undoing", async () => {
    await createCreditCard(targetId, {
      nickname: "My Own Card",
      bank: "Axis Bank",
      cardholderName: "SOMEONE ELSE",
      cardNumber: "5555555555554444",
      expiryMonth: 4,
      expiryYear: 2030,
      cvv: "321",
    });
    const backup = await exportFullJson(sourceId);
    const { batchId } = await commitBackupRestore(targetId, backup);

    await undoImport(targetId, batchId);

    const remaining = await listCreditCards(targetId);
    expect(remaining.map((c) => c.nickname)).toEqual(["My Own Card"]);
  });

  // A restore shouldn't quietly change which card the checkout flow reaches for.
  it("does not let a restored card steal the default from an existing one", async () => {
    await createCreditCard(targetId, {
      nickname: "My Own Card",
      bank: "Axis Bank",
      cardholderName: "SOMEONE ELSE",
      cardNumber: "5555555555554444",
      expiryMonth: 4,
      expiryYear: 2030,
      cvv: "321",
      isDefault: true,
    });
    const backup = await exportFullJson(sourceId);
    await commitBackupRestore(targetId, backup);

    const cards = await listCreditCards(targetId);
    expect(cards.filter((c) => c.isDefault).map((c) => c.nickname)).toEqual(["My Own Card"]);
  });

  it("restores a v1 backup that has no cards at all", async () => {
    const legacy = {
      formatVersion: 1,
      exportedAt: "2026-07-20T00:00:00.000Z",
      accounts: [],
      categories: [],
      transactions: [],
    };
    const result = await commitBackupRestore(targetId, legacy);
    expect(result.createdCreditCards).toBe(0);
  });
});
