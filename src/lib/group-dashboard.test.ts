import { describe, expect, it } from "vitest";
import {
  balanceState,
  computeMemberBalances,
  computeOverview,
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
    expect(youNet).toBe(30000);
    expect(youAreOwed).toBe(30000);
    expect(youOwe).toBe(0);
    expect(totalSpend).toBe(150000);
  });

  it("paid / owes / contribution% are correct per member", () => {
    expect(by(null)).toMatchObject({ paid: 90000, owes: 50000, contributionPct: 60 });
    expect(by("karan")).toMatchObject({ paid: 60000, owes: 50000, contributionPct: 40 });
    expect(by("priya")).toMatchObject({ paid: 0, owes: 50000, contributionPct: 0 });
  });

  it("owner-centric net nets out payments AND settlements", () => {
    // Karan: owed you 30000, then paid 20000 of your share back → +10000
    expect(by("karan").net).toBe(10000);
    // Priya: owed you 30000, settled 10000 → +20000
    expect(by("priya").net).toBe(20000);
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
