import { describe, expect, it } from "vitest";
import { formatDiffRow, presentAuditRow, type AuditRowInput, type LabelMaps } from "./activity";

const maps: LabelMaps = {
  categories: new Map([
    ["cat-food", { name: "Food", icon: "🍔" }],
    ["cat-dining", { name: "Dining", icon: "🍽" }],
  ]),
  accounts: new Map([
    ["acc-hdfc", "HDFC Savings"],
    ["acc-cash", "Cash Wallet"],
  ]),
  participants: new Map([["par-karan", "Karan"]]),
};

const row = (partial: Partial<AuditRowInput>): AuditRowInput => ({
  id: "audit1",
  action: "create",
  entity: "Transaction",
  entityId: "tx1",
  before: undefined,
  after: undefined,
  at: "2026-07-16T10:42:00.000Z",
  ...partial,
});

describe("transaction events", () => {
  it("expense create: summary, label, effect debits the account (paise-exact)", () => {
    const ev = presentAuditRow(
      row({ after: { type: "EXPENSE", amount: 42000, accountId: "acc-hdfc", categoryId: "cat-food", merchant: "Swiggy" } }),
      maps
    )!;
    expect(ev.activityId).toBe("ACT_audit1");
    expect(ev.summary).toBe("Added expense");
    expect(ev.entityLabel).toBe("Swiggy");
    expect(ev.detail).toContain("₹420");
    expect(ev.effects).toEqual([{ accountId: "acc-hdfc", accountLabel: "HDFC Savings", deltaPaise: -42000 }]);
  });

  it("friend-paid expense (accountId null) moves no account money", () => {
    const ev = presentAuditRow(
      row({ after: { type: "EXPENSE", amount: 90000, accountId: null, paidByParticipantId: "par-karan", merchant: "Dinner" } }),
      maps
    )!;
    expect(ev.effects).toEqual([]);
  });

  it("income create credits the account", () => {
    const ev = presentAuditRow(
      row({ after: { type: "INCOME", amount: 2500000, accountId: "acc-hdfc", merchant: "Salary" } }),
      maps
    )!;
    expect(ev.summary).toBe("Added income");
    expect(ev.effects).toEqual([{ accountId: "acc-hdfc", accountLabel: "HDFC Savings", deltaPaise: 2500000 }]);
  });

  it("transfer create debits from and credits to", () => {
    const ev = presentAuditRow(
      row({ after: { type: "TRANSFER", amount: 100000, accountId: "acc-hdfc", toAccountId: "acc-cash", merchant: "HDFC Savings → Cash Wallet" } }),
      maps
    )!;
    expect(ev.summary).toBe("Transferred money");
    expect(ev.entityType).toBe("transfer");
    expect(ev.effects).toContainEqual({ accountId: "acc-hdfc", accountLabel: "HDFC Savings", deltaPaise: -100000 });
    expect(ev.effects).toContainEqual({ accountId: "acc-cash", accountLabel: "Cash Wallet", deltaPaise: 100000 });
  });

  it("edit: amount diff carries signed delta; net effect = reverse old + apply new", () => {
    const before = { type: "EXPENSE", amount: 42000, accountId: "acc-hdfc", categoryId: "cat-food", merchant: "Swiggy" };
    const after = { ...before, amount: 52000, categoryId: "cat-dining" };
    const ev = presentAuditRow(row({ action: "update", before, after }), maps)!;
    expect(ev.summary).toBe("Edited expense");
    const amount = ev.diff.find((d) => d.field === "amount")!;
    expect(amount.formattedBefore).toBe("₹420");
    expect(amount.formattedAfter).toBe("₹520");
    expect(amount.delta).toBe(10000);
    expect(formatDiffRow(amount)).toBe("₹420 → ₹520 (+₹100)");
    const category = ev.diff.find((d) => d.field === "categoryId")!;
    expect(category.formattedBefore).toBe("🍔 Food");
    expect(category.formattedAfter).toBe("🍽 Dining");
    expect(ev.effects).toEqual([{ accountId: "acc-hdfc", accountLabel: "HDFC Savings", deltaPaise: -10000 }]);
  });

  it("edit that moves an expense between accounts produces one effect per account", () => {
    const before = { type: "EXPENSE", amount: 42000, accountId: "acc-hdfc", merchant: "Swiggy" };
    const after = { ...before, accountId: "acc-cash" };
    const ev = presentAuditRow(row({ action: "update", before, after }), maps)!;
    expect(ev.effects).toContainEqual({ accountId: "acc-hdfc", accountLabel: "HDFC Savings", deltaPaise: 42000 });
    expect(ev.effects).toContainEqual({ accountId: "acc-cash", accountLabel: "Cash Wallet", deltaPaise: -42000 });
  });

  it("no-op edit produces no event", () => {
    const p = { type: "EXPENSE", amount: 42000, accountId: "acc-hdfc", merchant: "Swiggy" };
    expect(presentAuditRow(row({ action: "update", before: p, after: { ...p } }), maps)).toBeNull();
  });

  it("delete reverses the balance effect; snapshot keeps the label", () => {
    const ev = presentAuditRow(
      row({ action: "soft-delete", before: { type: "EXPENSE", amount: 42000, accountId: "acc-hdfc", merchant: "Swiggy" }, after: undefined }),
      maps
    )!;
    expect(ev.summary).toBe("Deleted expense");
    expect(ev.entityLabel).toBe("Swiggy");
    expect(ev.effects).toEqual([{ accountId: "acc-hdfc", accountLabel: "HDFC Savings", deltaPaise: 42000 }]);
  });

  it("restore re-applies the effect", () => {
    const ev = presentAuditRow(
      row({ action: "restore", after: { type: "EXPENSE", amount: 42000, accountId: "acc-hdfc", merchant: "Swiggy" } }),
      maps
    )!;
    expect(ev.summary).toBe("Restored expense");
    expect(ev.effects).toEqual([{ accountId: "acc-hdfc", accountLabel: "HDFC Savings", deltaPaise: -42000 }]);
  });

  it("deleted references degrade to snapshot fallbacks, never crash", () => {
    const ev = presentAuditRow(
      row({ after: { type: "EXPENSE", amount: 1000, accountId: "acc-gone", categoryId: "cat-gone", merchant: "Ghost" } }),
      maps
    )!;
    expect(ev.effects[0].accountLabel).toBe("(deleted account)");
    expect(ev.detail).toContain("(deleted category)");
  });
});

describe("other entity kinds", () => {
  it("settlement: direction copy + no account effects", () => {
    const ev = presentAuditRow(
      row({ entity: "Settlement", after: { participantId: "par-karan", direction: "TO_OWNER", amount: 45000, method: "UPI" } }),
      maps
    )!;
    expect(ev.summary).toBe("Settled up");
    expect(ev.entityLabel).toBe("Karan paid you");
    expect(ev.detail).toBe("₹450");
    expect(ev.effects).toEqual([]);
  });

  it("category rename diffs the name", () => {
    const ev = presentAuditRow(
      row({ entity: "Category", action: "rename", before: { name: "Snacks" }, after: { name: "Street food" } }),
      maps
    )!;
    expect(ev.summary).toBe("Renamed category");
    expect(formatDiffRow(ev.diff[0])).toBe("Snacks → Street food");
  });

  it("category kind change renders friendly type words", () => {
    const ev = presentAuditRow(
      row({ entity: "Category", action: "kind-change", before: { name: "Refunds", kind: "EXPENSE" }, after: { name: "Refunds", kind: "INCOME" } }),
      maps
    )!;
    expect(formatDiffRow(ev.diff[0])).toBe("Expense → Income");
  });

  it("account create shows opening balance", () => {
    const ev = presentAuditRow(row({ entity: "Account", after: { name: "SBI", openingBalance: 500000 } }), maps)!;
    expect(ev.summary).toBe("Added account");
    expect(ev.detail).toBe("opening balance ₹5,000");
  });

  it("budget update diffs the limit with delta", () => {
    const ev = presentAuditRow(
      row({ entity: "Budget", action: "update", before: { categoryId: "cat-food", limit: 800000 }, after: { categoryId: "cat-food", limit: 600000 } }),
      maps
    )!;
    expect(ev.entityLabel).toBe("🍔 Food");
    expect(formatDiffRow(ev.diff[0])).toBe("₹8,000 → ₹6,000 (−₹2,000)");
  });

  it("bill paid uses enriched payload for the account effect", () => {
    const ev = presentAuditRow(
      row({
        entity: "Bill",
        action: "bill-paid",
        before: { name: "ACT Fibernet", amount: 118000 },
        after: { paidTxId: "t9", accountId: "acc-hdfc", accountName: "HDFC Savings", amount: 118000, name: "ACT Fibernet" },
      }),
      maps
    )!;
    expect(ev.summary).toBe("Paid bill");
    expect(ev.effects).toEqual([{ accountId: "acc-hdfc", accountLabel: "HDFC Savings", deltaPaise: -118000 }]);
  });

  it("legacy bill-paid rows (no account info) omit effects rather than guess", () => {
    const ev = presentAuditRow(
      row({ entity: "Bill", action: "bill-paid", before: { name: "ACT Fibernet", amount: 118000 }, after: { paidTxId: "t9" } }),
      maps
    )!;
    expect(ev.effects).toEqual([]);
  });

  it("import + undo summarize the batch", () => {
    const imp = presentAuditRow(row({ entity: "ImportBatch", action: "import", after: { imported: 74, skipped: 2 } }), maps)!;
    expect(imp.summary).toBe("Imported 74 transactions");
    expect(imp.detail).toBe("2 duplicates skipped");
    const undo = presentAuditRow(row({ entity: "ImportBatch", action: "undo-import", after: { reversed: 74 } }), maps)!;
    expect(undo.summary).toBe("Undid import");
  });

  it("unknown kinds and malformed payloads are skipped, never thrown", () => {
    expect(presentAuditRow(row({ entity: "User", action: "clear-transactions" }), maps)).toBeNull();
    expect(presentAuditRow(row({ entity: "Transaction", action: "update", before: "garbage", after: 42 }), maps)).toBeNull();
  });
});
