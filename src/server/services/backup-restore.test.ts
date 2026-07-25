// Pure unit tests — no database. Anything that needs Postgres lives in
// backup-restore.integration.test.ts so `npm run test` stays runnable (and
// CI-runnable) without a database.

import { describe, expect, it } from "vitest";
import {
  BACKUP_FORMAT_VERSION,
  buildAccountIdMap,
  buildCategoryIdMap,
  classifyTransactions,
  parseBackup,
} from "./backup-restore";
import { DuplicateIndex } from "@/lib/import/dedupe";

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
