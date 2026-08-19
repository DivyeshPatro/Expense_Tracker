// "₹65 not shared" — spend recorded in a group but charged to nobody.
//
// A group expense that is not split has no split rows, so its whole amount is
// unshared. That is a legitimate thing to record (a personal purchase made on
// the trip), but it makes the owner's own standing sit above the sum of what
// the members owe by exactly that amount. Without a label the page shows two
// numbers that look like they should agree and don't.

import { describe, expect, it } from "vitest";
import { computeMemberBalances, computeOverview, type GroupExpenseRow } from "./group-dashboard";

const r = (n: number) => Math.round(n * 100);
const A = "p-a", B = "p-b";
const expense = (id: string, amount: number, splits: [string | null, number][]): GroupExpenseRow => ({
  id, amount: r(amount), ymd: "2026-08-18", paidByParticipantId: null,
  categoryId: null, category: null, icon: "", color: "",
  splits: splits.map(([participantId, owed]) => ({ participantId, owedAmount: r(owed) })),
});

describe("unsharedSum", () => {
  it("is zero when every expense is fully split", () => {
    const o = computeOverview([expense("t1", 300, [[null, 100], [A, 100], [B, 100]])], []);
    expect(o.unsharedSum).toBe(0);
  });

  it("counts an expense that was not split at all", () => {
    const o = computeOverview([
      expense("shared", 300, [[null, 100], [A, 100], [B, 100]]),
      expense("personal", 65, []), // in the group, split with nobody
    ], []);
    expect(o.unsharedSum).toBe(r(65));
    expect(o.totalExpenseSum).toBe(r(365));
  });

  it("counts a partial split too", () => {
    const o = computeOverview([expense("t1", 100, [[null, 40], [A, 20]])], []);
    expect(o.unsharedSum).toBe(r(40));
  });

  it("never reports a negative, even if splits somehow exceed the amount", () => {
    expect(computeOverview([expense("t1", 100, [[null, 90], [A, 90]])], []).unsharedSum).toBe(0);
  });

  it("explains the gap between the owner's standing and what members owe", () => {
    // The reported case, in miniature: ₹65 of the group's spend is the owner's
    // own, so their net runs ₹65 ahead of everyone else's debts combined.
    const expenses = [
      expense("shared", 300, [[null, 100], [A, 100], [B, 100]]),
      expense("personal", 65, []),
    ];
    const { members, youNet } = computeMemberBalances(expenses, [], [A, B]);
    const membersOwe = members.filter((m) => m.participantId !== null).reduce((s, m) => s + m.net, 0);
    expect(youNet - membersOwe).toBe(computeOverview(expenses, []).unsharedSum);
    expect(youNet - membersOwe).toBe(r(65));
  });

  it("an empty group has nothing unshared", () => {
    expect(computeOverview([], []).unsharedSum).toBe(0);
  });
});
