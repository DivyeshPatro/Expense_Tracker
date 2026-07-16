import { describe, expect, it } from "vitest";
import {
  formatDiffRow,
  groupUpdateChains,
  presentAuditRow,
  presentChain,
  presentNotificationRow,
  type AuditRowInput,
  type LabelMaps,
} from "./activity";

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

describe("related links (RFC §7 — deterministic, from snapshots only)", () => {
  it("transaction events link their category and account", () => {
    const ev = presentAuditRow(
      row({ after: { type: "EXPENSE", amount: 42000, accountId: "acc-hdfc", categoryId: "cat-food", merchant: "Swiggy" } }),
      maps
    )!;
    expect(ev.related).toContainEqual({ label: "🍔 Food", href: "/transactions?category=cat-food&tab=EXPENSE" });
    expect(ev.related).toContainEqual({ label: "🏦 HDFC Savings", href: "/accounts" });
  });

  it("import events link the batch tap-through", () => {
    const ev = presentAuditRow(row({ entity: "ImportBatch", action: "import", entityId: "batch7", after: { imported: 74, skipped: 0 } }), maps)!;
    expect(ev.related).toEqual([{ label: "View 74 transactions", href: "/transactions?batch=batch7&p=all" }]);
  });

  it("deleted references produce no dead links", () => {
    const ev = presentAuditRow(
      row({ after: { type: "EXPENSE", amount: 1000, accountId: "acc-gone", categoryId: "cat-gone", merchant: "Ghost" } }),
      maps
    )!;
    expect(ev.related).toEqual([]);
  });
});

describe("10-minute edit-chain collapse (RFC §3)", () => {
  const upd = (id: string, minAgo: number, entityId = "tx1", amount = 42000): AuditRowInput =>
    row({
      id,
      action: "update",
      entityId,
      before: { type: "EXPENSE", amount: 42000, accountId: "acc-hdfc", merchant: "Swiggy" },
      after: { type: "EXPENSE", amount, accountId: "acc-hdfc", merchant: "Swiggy" },
      at: new Date(Date.UTC(2026, 6, 16, 12, 0) - minAgo * 60_000).toISOString(),
    });

  it("three edits within the window collapse into one chain at the newest position", () => {
    const rows = [upd("e3", 0, "tx1", 37000), upd("e2", 5, "tx1", 36000), upd("e1", 9, "tx1", 35000)];
    const out = groupUpdateChains(rows);
    expect(out).toHaveLength(1);
    expect(Array.isArray(out[0])).toBe(true);
    expect((out[0] as AuditRowInput[]).map((r) => r.id)).toEqual(["e3", "e2", "e1"]);
  });

  it("a gap over 10 minutes splits the chain", () => {
    const out = groupUpdateChains([upd("e3", 0), upd("e2", 5), upd("e1", 40)]);
    expect(out).toHaveLength(2);
    expect((out[0] as AuditRowInput[]).map((r) => r.id)).toEqual(["e3", "e2"]);
    expect((out[1] as AuditRowInput).id).toBe("e1");
  });

  it("a same-entity non-update event breaks the chain", () => {
    const del = row({ id: "d1", action: "soft-delete", entityId: "tx1", before: { type: "EXPENSE", amount: 1, merchant: "x" }, at: upd("e2", 3).at });
    const out = groupUpdateChains([upd("e3", 0), del, upd("e1", 6)]);
    expect(out).toHaveLength(3); // no grouping across the delete
  });

  it("other entities interleaving do not break the chain", () => {
    const other = row({ id: "o1", action: "create", entityId: "tx-other", after: { type: "EXPENSE", amount: 1, merchant: "y" }, at: upd("x", 3).at });
    const out = groupUpdateChains([upd("e3", 0), other, upd("e2", 6)]);
    expect(out).toHaveLength(2);
    expect((out[0] as AuditRowInput[]).map((r) => r.id)).toEqual(["e3", "e2"]);
  });

  it("presentChain emits the NET diff with step-through members", () => {
    const chain = [
      row({ id: "e3", action: "update", before: { type: "EXPENSE", amount: 36000, merchant: "Swiggy" }, after: { type: "EXPENSE", amount: 37000, merchant: "Swiggy" } }),
      row({ id: "e2", action: "update", before: { type: "EXPENSE", amount: 35000, merchant: "Swiggy" }, after: { type: "EXPENSE", amount: 36000, merchant: "Swiggy" } }),
      row({ id: "e1", action: "update", before: { type: "EXPENSE", amount: 25000, merchant: "Swiggy" }, after: { type: "EXPENSE", amount: 35000, merchant: "Swiggy" } }),
    ] as AuditRowInput[];
    const ev = presentChain(chain, maps)!;
    expect(ev.activityId).toBe("ACT_e3"); // group id = newest member (RFC §5)
    expect(ev.collapsed).toMatchObject({ count: 3 });
    expect(ev.collapsed!.members).toHaveLength(3);
    expect(formatDiffRow(ev.diff.find((d) => d.field === "amount")!)).toBe("₹250 → ₹370 (+₹120)");
    expect(formatDiffRow(ev.collapsed!.members[1].diff[0])).toBe("₹350 → ₹360 (+₹10)");
  });

  it("a chain that nets to no change produces no event (A→B→A)", () => {
    const a = { type: "EXPENSE", amount: 42000, merchant: "Swiggy" };
    const b = { type: "EXPENSE", amount: 50000, merchant: "Swiggy" };
    const chain = [
      row({ id: "e2", action: "update", before: b, after: a }),
      row({ id: "e1", action: "update", before: a, after: b }),
    ] as AuditRowInput[];
    expect(presentChain(chain, maps)).toBeNull();
  });
});

describe("budget-exceeded notification events", () => {
  it("presents the catalog copy with over-by amount", () => {
    const ev = presentNotificationRow({
      id: "n1",
      kind: "BUDGET_EXCEEDED",
      payload: { budgetId: "b1", category: "Food", spent: 815000, limit: 800000, monthKey: "2026-07" },
      createdAt: "2026-07-16T10:00:00.000Z",
    })!;
    expect(ev.activityId).toBe("ACT_Nn1");
    expect(ev.summary).toBe("Food budget exceeded");
    expect(ev.detail).toBe("over by ₹150");
    expect(ev.effects).toEqual([]);
  });

  it("other kinds and malformed payloads are skipped", () => {
    expect(presentNotificationRow({ id: "n2", kind: "BUDGET_WARNING", payload: {}, createdAt: "2026-07-16T10:00:00.000Z" })).toBeNull();
    expect(presentNotificationRow({ id: "n3", kind: "BUDGET_EXCEEDED", payload: "garbage", createdAt: "2026-07-16T10:00:00.000Z" })).not.toThrow;
  });
});
