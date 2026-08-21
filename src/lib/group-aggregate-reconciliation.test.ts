// The three numbers on a group card must add up.
//
// Srisailam reported "You'll get ₹1.33 · You'll pay ₹0 · Net +₹0.31" — figures
// no reader can reconcile. The group's four members sat at +₹1.33, −₹0.34,
// −₹0.34 and −₹0.34: the pair of sums skipped every balance inside
// SETTLED_THRESHOLD, so ₹1.02 of rounding dust existed in the net and nowhere
// else. No balance was wrong; the summary was unreadable.
//
// Σ(member nets) = youNet always holds — Σowes = Σpaid = total spend, and every
// settlement is zero-sum — so summing all balances makes
// `youAreOwed − youOwe === youNet` an invariant. That identity is what these
// tests defend, in the general case and in the shapes that broke it.

import { describe, expect, it } from "vitest";
import { computeMemberBalances, SETTLED_THRESHOLD, type GroupExpenseRow, type GroupSettlementRow } from "./group-dashboard";

const [A, B, C, D] = ["p-a", "p-b", "p-c", "p-d"];

/** An expense whose splits are given outright, so a test can state the exact
 *  paise it means rather than working backwards from a split rule. */
function expense(id: string, amount: number, paidBy: string | null, splits: [string | null, number][]): GroupExpenseRow {
  return {
    id,
    amount,
    ymd: "2026-08-19",
    paidByParticipantId: paidBy,
    categoryId: null,
    category: null,
    icon: "",
    color: "",
    splits: splits.map(([participantId, owedAmount]) => ({ participantId, owedAmount })),
  };
}

/**
 * Build a group whose members land on exactly the nets asked for.
 *
 * The owner fronts one bill covering everyone's share, then each member settles
 * the difference between their share and the target — the ordinary shape of a
 * group that has been mostly paid off and is carrying residue.
 */
function groupWithNets(targets: Record<string, number>) {
  const ids = Object.keys(targets);
  const SHARE = 100_000; // ₹1,000 each, comfortably above any target
  const total = SHARE * (ids.length + 1);
  const expenses = [expense("e1", total, null, [[null, SHARE], ...ids.map((id) => [id, SHARE] as [string, number])])];
  const settlements: GroupSettlementRow[] = ids.map((id, i) => ({
    id: `s${i}`,
    participantId: id,
    direction: "TO_OWNER" as const,
    amount: SHARE - targets[id], // net = SHARE − (SHARE − target) = target
    settledAt: "2026-08-19T12:00:00.000Z",
  }));
  return computeMemberBalances(expenses, settlements, ids);
}

/** Every member except the owner's own summary row. */
const realMembers = (r: ReturnType<typeof computeMemberBalances>) => r.members.filter((m) => m.participantId !== null);
/** The rule the card, the detail page and the settle list all share. */
const isSettled = (r: ReturnType<typeof computeMemberBalances>) => realMembers(r).every((m) => Math.abs(m.net) <= SETTLED_THRESHOLD);

describe("the group card's three numbers reconcile", () => {
  it("Srisailam: dust no longer vanishes between You'll pay and Net", () => {
    const r = groupWithNets({ [A]: 133, [B]: -34, [C]: -34, [D]: -34 });
    expect(realMembers(r).map((m) => m.net).sort((x, y) => x - y)).toEqual([-34, -34, -34, 133]);
    expect(r.youAreOwed).toBe(133); // ₹1.33
    expect(r.youOwe).toBe(102); // ₹1.02 — was ₹0, the whole bug
    expect(r.youNet).toBe(31); // +₹0.31, unchanged
    expect(r.youAreOwed - r.youOwe).toBe(r.youNet);
  });

  it("exact zero", () => {
    const r = groupWithNets({ [A]: 0, [B]: 0 });
    expect(r.youAreOwed).toBe(0);
    expect(r.youOwe).toBe(0);
    expect(r.youNet).toBe(0);
    expect(r.youAreOwed - r.youOwe).toBe(r.youNet);
  });

  it("a normal positive balance", () => {
    const r = groupWithNets({ [A]: 60_000, [B]: 40_000 });
    expect(r.youAreOwed).toBe(100_000);
    expect(r.youOwe).toBe(0);
    expect(r.youNet).toBe(100_000);
    expect(r.youAreOwed - r.youOwe).toBe(r.youNet);
  });

  it("a normal negative balance", () => {
    const r = groupWithNets({ [A]: -60_000, [B]: -40_000 });
    expect(r.youAreOwed).toBe(0);
    expect(r.youOwe).toBe(100_000);
    expect(r.youNet).toBe(-100_000);
    expect(r.youAreOwed - r.youOwe).toBe(r.youNet);
  });

  it("several sub-₹1 balances, none of which used to be counted", () => {
    const r = groupWithNets({ [A]: 40, [B]: 40, [C]: 40, [D]: -20 });
    expect(r.youAreOwed).toBe(120);
    expect(r.youOwe).toBe(20);
    expect(r.youNet).toBe(100);
    expect(r.youAreOwed - r.youOwe).toBe(r.youNet);
  });

  it("holds when the two sides cancel exactly", () => {
    const r = groupWithNets({ [A]: 60_000, [B]: -60_000 });
    expect(r.youAreOwed).toBe(60_000);
    expect(r.youOwe).toBe(60_000);
    expect(r.youNet).toBe(0);
    expect(r.youAreOwed - r.youOwe).toBe(r.youNet);
  });
});

describe("settled state asks about people, not totals", () => {
  it("₹600 owed to you and ₹600 owed by you is NOT settled", () => {
    // The reason |youNet| is the wrong test: these cancel to zero while ₹1,200
    // is still waiting to move. Calling this settled would hide real money.
    const r = groupWithNets({ [A]: 60_000, [B]: -60_000 });
    expect(r.youNet).toBe(0);
    expect(isSettled(r)).toBe(false);
  });

  it("±₹0.40 of dust IS settled", () => {
    const r = groupWithNets({ [A]: 40, [B]: -40 });
    expect(isSettled(r)).toBe(true);
  });

  it("one real balance alongside dust is not settled", () => {
    const r = groupWithNets({ [A]: 25_000, [B]: -34, [C]: 12 });
    expect(isSettled(r)).toBe(false);
  });

  it("a balance exactly on the threshold is still settled", () => {
    const r = groupWithNets({ [A]: SETTLED_THRESHOLD, [B]: -SETTLED_THRESHOLD });
    expect(isSettled(r)).toBe(true);
  });

  it("dust that sums past ₹1 stays settled — the owner's row is not a person", () => {
    // Σ member nets = youNet = 120 paise, over the threshold. Judging the
    // owner's summary row would call this unsettled and leave the group
    // flagged forever, which is the behaviour being removed.
    const r = groupWithNets({ [A]: 40, [B]: 40, [C]: 40 });
    expect(r.youNet).toBe(120);
    expect(isSettled(r)).toBe(true);
  });

  it("an empty group is settled", () => {
    const r = computeMemberBalances([], [], [A, B]);
    expect(isSettled(r)).toBe(true);
    expect(r.youAreOwed - r.youOwe).toBe(r.youNet);
  });
});

describe("settlements of both shapes keep the identity", () => {
  const bill = expense("e1", 300_000, null, [
    [null, 100_000],
    [A, 100_000],
    [B, 100_000],
  ]);

  it("an owner↔member settlement", () => {
    const settlements: GroupSettlementRow[] = [
      { id: "s1", participantId: A, direction: "TO_OWNER", amount: 100_000, settledAt: "2026-08-19T12:00:00.000Z" },
    ];
    const r = computeMemberBalances([bill], settlements, [A, B]);
    expect(r.members.find((m) => m.participantId === A)!.net).toBe(0);
    expect(r.youAreOwed).toBe(100_000); // only B still owes
    expect(r.youOwe).toBe(0);
    expect(r.youAreOwed - r.youOwe).toBe(r.youNet);
  });

  it("a member↔member settlement leaves the owner's position alone", () => {
    const settlements: GroupSettlementRow[] = [
      { id: "s1", participantId: null, direction: null, fromParticipantId: B, toParticipantId: A, amount: 30_000, settledAt: "2026-08-19T12:00:00.000Z" },
    ];
    const before = computeMemberBalances([bill], [], [A, B]);
    const after = computeMemberBalances([bill], settlements, [A, B]);
    expect(after.youNet).toBe(before.youNet);
    // B paid A, so B owes the group less and A is owed less.
    expect(after.members.find((m) => m.participantId === B)!.net).toBe(70_000);
    expect(after.members.find((m) => m.participantId === A)!.net).toBe(130_000);
    expect(after.youAreOwed - after.youOwe).toBe(after.youNet);
  });

  it("the identity survives a member↔member settlement that flips a sign", () => {
    const settlements: GroupSettlementRow[] = [
      { id: "s1", participantId: null, direction: null, fromParticipantId: B, toParticipantId: A, amount: 150_000, settledAt: "2026-08-19T12:00:00.000Z" },
    ];
    const r = computeMemberBalances([bill], settlements, [A, B]);
    expect(r.members.find((m) => m.participantId === B)!.net).toBe(-50_000);
    expect(r.youOwe).toBe(50_000);
    expect(r.youAreOwed).toBe(250_000);
    expect(r.youAreOwed - r.youOwe).toBe(r.youNet);
  });
});
