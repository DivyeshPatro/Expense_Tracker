import { describe, expect, it } from "vitest";
import {
  balanceState,
  computeMemberBalances,
  computeOverview,
  computeSuggestions,
  groupCategoryTotals,
  groupMonthlyTrend,
  sumSpent,
  ymdInRange,
  type GroupExpenseRow,
  type GroupSettlementRow,
} from "./group-dashboard";

// Group: You + Karan + Priya.
// E1: You paid ₹900, split 3 ways equal (₹300 each).
// E2: Karan paid ₹600, split 3 ways equal (₹200 each).
// Settlement: Priya paid you ₹100.
const expenses: GroupExpenseRow[] = [
  {
    id: "e1",
    amount: 90000,
    ymd: "2026-07-10",
    paidByParticipantId: null, // You
    categoryId: "cat-food",
    category: "Food",
    icon: "🍔",
    color: "#f00",
    splits: [
      { participantId: null, owedAmount: 30000 },
      { participantId: "karan", owedAmount: 30000 },
      { participantId: "priya", owedAmount: 30000 },
    ],
  },
  {
    id: "e2",
    amount: 60000,
    ymd: "2026-06-20",
    paidByParticipantId: "karan",
    categoryId: "cat-travel",
    category: "Travel",
    icon: "🚕",
    color: "#00f",
    splits: [
      { participantId: null, owedAmount: 20000 },
      { participantId: "karan", owedAmount: 20000 },
      { participantId: "priya", owedAmount: 20000 },
    ],
  },
];
const settlements: GroupSettlementRow[] = [
  { id: "s1", participantId: "priya", direction: "TO_OWNER", amount: 10000, settledAt: "2026-07-12T09:00:00.000Z" },
];
const memberIds = ["karan", "priya"];

describe("computeMemberBalances", () => {
  const { members, youNet, youAreOwed, youOwe, totalSpend } = computeMemberBalances(expenses, settlements, memberIds);
  const by = (pid: string | null) => members.find((m) => m.participantId === pid)!;

  it("You lead the list and carry the overall net", () => {
    expect(members[0].participantId).toBeNull();
    // Unchanged by the symmetric-balance correction: the owner's total was
    // always right, because Σ(paid − share) is zero however the credit is
    // attributed. Only the split between Karan and Priya moved.
    expect(youNet).toBe(30000);
    // These two DID move. Karan fronted ₹600 and consumed ₹500, so you owe him
    // ₹100 — the old engine reported him as owing YOU ₹100 instead.
    expect(youAreOwed).toBe(40000);
    expect(youOwe).toBe(10000);
    expect(youAreOwed - youOwe).toBe(youNet);
    expect(totalSpend).toBe(150000);
  });

  it("paid / owes / contribution% are correct per member", () => {
    expect(by(null)).toMatchObject({ paid: 90000, owes: 50000, contributionPct: 60 });
    expect(by("karan")).toMatchObject({ paid: 60000, owes: 50000, contributionPct: 40 });
    expect(by("priya")).toMatchObject({ paid: 0, owes: 50000, contributionPct: 0 });
  });

  it("nets each person's spend against their share, then settlements", () => {
    // Every balance is paid − share, from that person's own side.
    //   You    paid 90000, share 50000 → +40000, less Priya's 10000 settlement
    //   Karan  paid 60000, share 50000 → he is up 10000, i.e. YOU OWE HIM
    //   Priya  paid     0, share 50000 → owes 50000, less 10000 settled
    //
    // The old rule credited Karan only for YOUR ₹200 share of the bill he
    // fronted, never the ₹200 Priya owed him, and reported him as owing you
    // ₹100 when the money ran the other way.
    expect(by("karan").net).toBe(-10000);
    expect(by("priya").net).toBe(40000);
    // and the group still sums to zero
    expect(by("karan").net + by("priya").net).toBe(youNet);
  });

  it("a member who has left but still owes is kept", () => {
    const res = computeMemberBalances(expenses, settlements, []); // empty roster
    expect(res.members.some((m) => m.participantId === "karan")).toBe(true);
    expect(res.members.some((m) => m.participantId === "priya")).toBe(true);
  });
});

describe("computeOverview", () => {
  it("counts, sums and the latest activity date", () => {
    const o = computeOverview(expenses, settlements);
    expect(o).toMatchObject({ totalExpenseCount: 2, totalExpenseSum: 150000, totalSettlementCount: 1, totalSettlementSum: 10000 });
    expect(o.lastActivity).toBe("2026-07-12"); // settlement is newest
  });

  it("no data → zeros and null last activity", () => {
    expect(computeOverview([], [])).toEqual({
      totalExpenseCount: 0,
      totalExpenseSum: 0,
      totalSettlementCount: 0,
      totalSettlementSum: 0,
      lastActivity: null,
    });
  });
});

describe("spending aggregations", () => {
  it("category totals use the full amount, highest first", () => {
    const cats = groupCategoryTotals(expenses);
    expect(cats.map((c) => [c.name, c.total])).toEqual([
      ["Food", 90000],
      ["Travel", 60000],
    ]);
  });

  it("sumSpent totals full amounts", () => {
    expect(sumSpent(expenses)).toBe(150000);
    expect(sumSpent(expenses.filter((e) => e.ymd.startsWith("2026-07")))).toBe(90000);
  });

  it("monthly trend fills every requested month, zero where empty", () => {
    const trend = groupMonthlyTrend(expenses, ["2026-05", "2026-06", "2026-07"]);
    expect(trend).toEqual([
      { key: "2026-05", total: 0 },
      { key: "2026-06", total: 60000 },
      { key: "2026-07", total: 90000 },
    ]);
  });
});

describe("helpers", () => {
  it("balanceState respects the ₹1 settled threshold", () => {
    expect(balanceState(0)).toBe("settled");
    expect(balanceState(100)).toBe("settled");
    expect(balanceState(101)).toBe("owes-you");
    expect(balanceState(-101)).toBe("you-owe");
  });

  it("ymdInRange handles open-ended bounds", () => {
    expect(ymdInRange("2026-07-10", "2026-07-01", "2026-07-31")).toBe(true);
    expect(ymdInRange("2026-08-01", "2026-07-01", "2026-07-31")).toBe(false);
    expect(ymdInRange("2026-07-10", null, null)).toBe(true);
  });
});

describe("computeSuggestions (reuses the settlement engine)", () => {
  it("routes members' debts to the owner when You are the sole creditor", () => {
    // You owed +₹300; Karan owes you ₹100; Priya owes you ₹200.
    const s = computeSuggestions([
      { participantId: null, net: 30000, name: "You" },
      { participantId: "karan", net: 10000, name: "Karan" },
      { participantId: "priya", net: 20000, name: "Priya" },
    ]);
    expect(s).toHaveLength(2);
    expect(s.every((x) => x.involvesYou)).toBe(true);
    expect(s.every((x) => x.toId === "me" && x.toName === "You")).toBe(true);
    expect(s.map((x) => [x.fromName, x.amount]).sort()).toEqual([["Karan", 10000], ["Priya", 20000]]);
  });

  it("produces member-to-member hops in the optimal plan (Splitwise-style)", () => {
    // You owe overall −₹1200; you owe Rohan ₹3400; Karan/Priya owe you ₹1300/₹900.
    const s = computeSuggestions([
      { participantId: null, net: -120000, name: "You" },
      { participantId: "rohan", net: -340000, name: "Rohan" },
      { participantId: "karan", net: 130000, name: "Karan" },
      { participantId: "priya", net: 90000, name: "Priya" },
    ]);
    // Everyone pays the single creditor (Rohan): Karan→Rohan, You→Rohan, Priya→Rohan.
    expect(s).toHaveLength(3);
    expect(s.every((x) => x.toName === "Rohan")).toBe(true);
    expect(s.filter((x) => x.involvesYou)).toHaveLength(1); // only You→Rohan is recordable
    expect(s.filter((x) => !x.involvesYou)).toHaveLength(2); // Karan→Rohan, Priya→Rohan
    expect(s.reduce((t, x) => t + x.amount, 0)).toBe(340000); // clears Rohan exactly
  });

  it("no suggestions when everyone is within the settled threshold", () => {
    expect(
      computeSuggestions([
        { participantId: null, net: 50, name: "You" },
        { participantId: "karan", net: -50, name: "Karan" },
      ])
    ).toEqual([]);
  });
});
