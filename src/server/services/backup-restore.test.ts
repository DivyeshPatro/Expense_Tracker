// Pure unit tests — no database. Anything that needs Postgres lives in
// backup-restore.integration.test.ts so `npm run test` stays runnable (and
// CI-runnable) without a database.

import { describe, expect, it } from "vitest";
import {
  BACKUP_FORMAT_VERSION,
  classifyTransactions,
  parseBackup,
  planRestore,
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

});

describe("planRestore", () => {
  it("matches existing accounts/categories case-insensitively by name and type", () => {
    const plan = planRestore(
      [{ id: "a1", name: "hdfc savings", type: "BANK" }],
      [{ id: "c1", name: "FOOD", kind: "EXPENSE" }],
      [{ id: "real-acc", name: "HDFC Savings", type: "BANK" }],
      [{ id: "real-cat", name: "Food", kind: "EXPENSE" }]
    );
    expect(plan.accountIdMap.get("a1")).toBe("real-acc");
    expect(plan.categoryIdMap.get("c1")).toBe("real-cat");
    expect(plan.matchedAccounts).toBe(1);
    expect(plan.matchedCategories).toBe(1);
    expect(plan.accountsToCreate).toHaveLength(0);
    expect(plan.categoriesToCreate).toHaveLength(0);
  });

  it("queues unmatched entities for creation with a resolvable placeholder id", () => {
    const plan = planRestore(
      [{ id: "a1", name: "Cash Wallet", type: "CASH" }],
      [{ id: "c1", name: "Travel", kind: "EXPENSE" }],
      [],
      []
    );
    expect(plan.accountsToCreate).toHaveLength(1);
    expect(plan.categoriesToCreate).toHaveLength(1);
    // Resolvable in preview even though the row doesn't exist yet — commit
    // overwrites the placeholder with the real id.
    expect(plan.accountIdMap.get("a1")).toBe("a1");
    expect(plan.categoryIdMap.get("c1")).toBe("c1");
  });

  // The divergence this planner exists to prevent: preview used to map every
  // account carrying an id, while commit skipped name/type-less ones, so preview
  // counted rows valid that commit then rejected as "referenced account missing".
  it("excludes rows too incomplete to match or create, so preview cannot over-promise", () => {
    const plan = planRestore(
      [{ id: "a1" }, { id: "a2", name: "No Type" }],
      [{ id: "c1" }],
      [],
      []
    );
    expect(plan.accountIdMap.has("a1")).toBe(false);
    expect(plan.accountIdMap.has("a2")).toBe(false);
    expect(plan.categoryIdMap.has("c1")).toBe(false);
    expect(plan.unusableAccounts).toBe(2);
    expect(plan.unusableCategories).toBe(1);
    expect(plan.accountsToCreate).toHaveLength(0);

    // A transaction pointing at the unusable account is rejected identically in
    // both paths, because both read this same map.
    const [out] = classifyTransactions(
      [{ type: "EXPENSE", amount: 100, accountId: "a1", merchant: "X", occurredAt: "2026-07-01" }],
      plan.accountIdMap,
      plan.categoryIdMap,
      new DuplicateIndex([])
    );
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toBe("referenced account missing");
  });

  it("collapses duplicate (name,type) rows within the backup onto one creation", () => {
    const plan = planRestore(
      [
        { id: "a1", name: "Cash", type: "CASH" },
        { id: "a2", name: "cash", type: "CASH" },
      ],
      [],
      [],
      []
    );
    expect(plan.accountsToCreate).toHaveLength(1);
    expect(plan.accountIdMap.get("a1")).toBe("a1");
    expect(plan.accountIdMap.get("a2")).toBe("a1");
  });

  it("treats the same name under a different kind as a separate category", () => {
    const plan = planRestore(
      [],
      [
        { id: "c1", name: "Bonus", kind: "INCOME" },
        { id: "c2", name: "Bonus", kind: "EXPENSE" },
      ],
      [],
      [{ id: "real", name: "Bonus", kind: "INCOME" }]
    );
    expect(plan.categoryIdMap.get("c1")).toBe("real");
    expect(plan.matchedCategories).toBe(1);
    expect(plan.categoriesToCreate).toHaveLength(1);
    expect(plan.categoriesToCreate[0].kind).toBe("EXPENSE");
  });
});
