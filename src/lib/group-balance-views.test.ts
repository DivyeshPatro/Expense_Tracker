// v2.1 — the two Balances views on a group page.
//
// The UI shows raw obligations, a simplified plan behind a toggle, and a
// receive-only view. All three are DERIVED from the existing engine — per-member
// nets from computeMemberBalances, and minimizeSettlements for the plan. These
// tests pin that relationship: the views must agree with the engine, and the
// simplified plan must never invent or lose money.

import { describe, expect, it } from "vitest";
import {
  computeDetailedObligations,
  computeMemberBalances,
  computeSuggestions,
  OWNER_SENTINEL,
  SETTLED_THRESHOLD,
  viewerPosition,
  viewerPositionTotals,
  type GroupExpenseRow,
} from "./group-dashboard";

const ALEX = "p-alex";
const BLAKE = "p-blake";
const CASEY = "p-casey";

const expense = (id: string, amount: number, paidBy: string | null, splits: [string | null, number][]): GroupExpenseRow => ({
  id,
  amount,
  ymd: "2026-08-05",
  paidByParticipantId: paidBy,
  categoryId: null,
  category: null,
  icon: "📦",
  color: "",
  splits: splits.map(([participantId, owedAmount]) => ({ participantId, owedAmount })),
});

/** What the "All payments" list shows with Simplify OFF: one row per person. */
const rawRows = (members: { participantId: string | null; net: number; name: string }[]) =>
  members
    .filter((m) => m.participantId !== null && Math.abs(m.net) > SETTLED_THRESHOLD)
    .map((m) => ({ name: m.name, amount: Math.abs(m.net), youReceive: m.net > 0 }));

describe("raw payment obligations", () => {
  it("lists one payment per person, in the direction the net says", () => {
    // ₹300 paid by you, split 3 ways → each of the two others owes you ₹100.
    const { members } = computeMemberBalances([expense("t1", 30_000, null, [[null, 10_000], [ALEX, 10_000], [BLAKE, 10_000]])], [], [ALEX, BLAKE]);
    const named = members.map((m) => ({ ...m, name: m.participantId ?? "You" }));
    const rows = rawRows(named);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.youReceive && r.amount === 10_000)).toBe(true);
  });

  it("shows a payment you owe when someone else paid", () => {
    // Alex paid ₹300, split 3 ways. He consumed ₹100, so he is owed ₹200 —
    // ₹100 from you and ₹100 from Blake. The old rule credited him only your
    // ₹100 and never charged Blake at all.
    const { members } = computeMemberBalances([expense("t1", 30_000, ALEX, [[null, 10_000], [ALEX, 10_000], [BLAKE, 10_000]])], [], [ALEX, BLAKE]);
    const named = members.map((m) => ({ ...m, name: m.participantId ?? "You" }));
    const rows = rawRows(named);
    expect(rows).toEqual([
      { name: ALEX, amount: 20_000, youReceive: false },
      { name: BLAKE, amount: 10_000, youReceive: true },
    ]);
  });

  it("hides anyone within the settled threshold", () => {
    const { members } = computeMemberBalances([expense("t1", 300, null, [[null, 100], [ALEX, 100], [BLAKE, 100]])], [], [ALEX, BLAKE]);
    const named = members.map((m) => ({ ...m, name: m.participantId ?? "You" }));
    expect(rawRows(named)).toEqual([]); // ₹1 each — below SETTLED_THRESHOLD
  });

  it("is empty when the group is fully settled", () => {
    const { members } = computeMemberBalances([], [], [ALEX, BLAKE]);
    const named = members.map((m) => ({ ...m, name: m.participantId ?? "You" }));
    expect(rawRows(named)).toEqual([]);
  });
});

describe("simplified plan (minimizeSettlements, via computeSuggestions)", () => {
  it("reduces the number of payments when it can", () => {
    // You paid ₹300 split 3 ways (Alex, Blake owe you ₹100 each);
    // Blake paid ₹300 split 3 ways (you and Alex owe Blake ₹100 each).
    // Raw: Alex→You ₹100, You→Blake... nets: Alex +200? Let's compute.
    const expenses = [
      expense("t1", 30_000, null, [[null, 10_000], [ALEX, 10_000], [BLAKE, 10_000]]),
      expense("t2", 30_000, BLAKE, [[null, 10_000], [ALEX, 10_000], [BLAKE, 10_000]]),
    ];
    const { members } = computeMemberBalances(expenses, [], [ALEX, BLAKE]);
    const named = members.map((m) => ({ participantId: m.participantId, net: m.net, name: m.participantId ?? "You" }));
    const raw = rawRows(named);
    const plan = computeSuggestions(named);

    // Whatever the shape, the plan must not be longer than the raw list...
    expect(plan.length).toBeLessThanOrEqual(raw.length);

    // ...and executing it must leave everyone square. Comparing totals is the
    // wrong check: Σ|net| counts each debt twice (once for the debtor, once for
    // the creditor), whereas the plan only moves money once.
    const ledger = new Map<string, number>();
    // minimizeSettlements' convention: positive = is owed.
    ledger.set("me", named.find((m) => m.participantId === null)!.net);
    for (const m of named) if (m.participantId) ledger.set(m.participantId, -m.net);
    for (const t of plan) {
      ledger.set(t.fromId, (ledger.get(t.fromId) ?? 0) + t.amount);
      ledger.set(t.toId, (ledger.get(t.toId) ?? 0) - t.amount);
    }
    for (const [, v] of ledger) expect(v).toBe(0);
  });

  it("routes a payment between two members, which is why the numbers can move", () => {
    // You +200 owed to you; Alex owes 300; Blake is owed 100.
    // The optimal plan sends Alex→You and Alex→Blake rather than everything
    // passing through you — the case the "Simplify payments" copy explains.
    const named = [
      { participantId: null, net: 20_000, name: "You" },
      { participantId: ALEX, net: 30_000, name: "Alex" },
      { participantId: BLAKE, net: -10_000, name: "Blake" },
    ];
    const plan = computeSuggestions(named);
    expect(plan.length).toBeGreaterThan(0);
    // every transfer is positive and the plan balances out
    expect(plan.every((p) => p.amount > 0)).toBe(true);
    expect(plan.some((p) => !p.involvesYou)).toBe(true); // a member-to-member hop exists
  });

  it("produces nothing when everyone is square", () => {
    expect(computeSuggestions([{ participantId: null, net: 0, name: "You" }, { participantId: ALEX, net: 0, name: "Alex" }])).toEqual([]);
  });

  it("cannot be simplified when there is only one obligation", () => {
    const named = [
      { participantId: null, net: 10_000, name: "You" },
      { participantId: ALEX, net: 10_000, name: "Alex" },
    ];
    const raw = rawRows(named);
    const plan = computeSuggestions(named);
    expect(raw).toHaveLength(1);
    expect(plan).toHaveLength(1); // nothing to collapse — the toggle says so
  });
});

describe("what I'll receive", () => {
  it("keeps only what comes to you, and totals it", () => {
    const named = [
      { participantId: null, net: 25_000, name: "You" },
      { participantId: ALEX, net: 20_000, name: "Alex" },
      { participantId: BLAKE, net: 5_000, name: "Blake" },
      { participantId: CASEY, net: -8_000, name: "Casey" }, // you owe Casey — excluded
    ];
    const receive = rawRows(named).filter((r) => r.youReceive);
    expect(receive.map((r) => r.name)).toEqual(["Alex", "Blake"]);
    expect(receive.reduce((s, r) => s + r.amount, 0)).toBe(25_000);
  });

  it("is empty when you are only paying out", () => {
    const named = [
      { participantId: null, net: -8_000, name: "You" },
      { participantId: CASEY, net: -8_000, name: "Casey" },
    ];
    expect(rawRows(named).filter((r) => r.youReceive)).toEqual([]);
  });
});

describe("detailed obligations (Simplify OFF) — the un-minimised list", () => {
  /** Sum of what `who` owes minus what is owed to them. */
  const position = (rows: { fromId: string; toId: string; amount: number }[], who: string) =>
    rows.reduce((t, r) => t + (r.fromId === who ? r.amount : 0) - (r.toId === who ? r.amount : 0), 0);

  it("addresses obligations to the member who PAID, not to the owner", () => {
    // Blake fronts ₹744 split three ways. The other two each owe Blake ₹248 —
    // the owner is on the hook for their OWN ₹248 only, not the whole ₹496.
    const rows = computeDetailedObligations(
      [expense("t2", 74_400, BLAKE, [[null, 24_800], [ALEX, 24_800], [BLAKE, 24_800]])],
      [],
      [ALEX, BLAKE]
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.toId === BLAKE)).toBe(true);
    expect(rows.every((r) => r.amount === 24_800)).toBe(true);
    expect(rows.map((r) => r.fromId).sort()).toEqual([ALEX, OWNER_SENTINEL].sort());
    // the payer's own share is not an obligation to anybody
    expect(rows.some((r) => r.fromId === BLAKE)).toBe(false);
  });

  it("shows BOTH directions for someone who paid AND owes", () => {
    const expenses = [
      expense("t1", 240_000, null, [[null, 80_000], [ALEX, 80_000], [BLAKE, 80_000]]),
      expense("t2", 74_400, BLAKE, [[null, 24_800], [ALEX, 24_800], [BLAKE, 24_800]]),
    ];
    const rows = computeDetailedObligations(expenses, [], [ALEX, BLAKE]);
    expect(rows.find((r) => r.fromId === BLAKE && r.toId === OWNER_SENTINEL)!.amount).toBe(80_000);
    expect(rows.find((r) => r.fromId === OWNER_SENTINEL && r.toId === BLAKE)!.amount).toBe(24_800);
    // and Alex owes Blake directly — a row the owner-centric shape could not express
    expect(rows.find((r) => r.fromId === ALEX && r.toId === BLAKE)!.amount).toBe(24_800);
  });

  it("reconciles exactly with the engine: each person's position === their net", () => {
    const expenses = [
      // Amounts equal the sum of their splits, as splitEqual/splitByWeights/
      // splitExact all guarantee. computeDetailedObligations reads the splits
      // alone, so a fixture where the two disagree cannot reconcile — and
      // real data never can.
      expense("t1", 320_000, null, [[null, 80_000], [ALEX, 80_000], [BLAKE, 80_000], [CASEY, 80_000]]),
      expense("t2", 99_200, BLAKE, [[null, 24_800], [ALEX, 24_800], [BLAKE, 24_800], [CASEY, 24_800]]),
      expense("t3", 128_000, null, [[null, 32_000], [ALEX, 32_000], [BLAKE, 32_000], [CASEY, 32_000]]),
    ];
    const ids = [ALEX, BLAKE, CASEY];
    const { members, youNet } = computeMemberBalances(expenses, [], ids);
    const rows = computeDetailedObligations(expenses, [], ids);
    for (const id of ids) {
      expect(position(rows, id)).toBe(members.find((m) => m.participantId === id)!.net);
    }
    // the owner too, with their sign flipped (their net is reported owner-side)
    expect(position(rows, OWNER_SENTINEL)).toBe(-youNet);
  });

  it("keeps reconciling after a settlement", () => {
    const expenses = [expense("t1", 30_000, null, [[null, 10_000], [ALEX, 10_000], [BLAKE, 10_000]])];
    const settlements = [{ id: "s1", participantId: ALEX, direction: "TO_OWNER" as const, amount: 4_000, settledAt: "2026-08-06T00:00:00Z" }];
    const { members } = computeMemberBalances(expenses, settlements, [ALEX, BLAKE]);
    const rows = computeDetailedObligations(expenses, settlements, [ALEX, BLAKE]);
    for (const id of [ALEX, BLAKE]) {
      expect(position(rows, id)).toBe(members.find((m) => m.participantId === id)!.net);
    }
    expect(rows.find((r) => r.fromId === ALEX)!.amount).toBe(6_000); // 10,000 − 4,000 settled
  });

  it("never reports a negative amount, even when over-settled", () => {
    const expenses = [expense("t1", 30_000, null, [[null, 10_000], [ALEX, 10_000], [BLAKE, 10_000]])];
    const settlements = [{ id: "s1", participantId: ALEX, direction: "TO_OWNER" as const, amount: 25_000, settledAt: "2026-08-06T00:00:00Z" }];
    const rows = computeDetailedObligations(expenses, settlements, [ALEX, BLAKE]);
    expect(rows.every((r) => r.amount > 0)).toBe(true);
    // Alex handed over ₹250 against a ₹100 debt. The extra ₹150 first covers
    // what the owner was still owed by someone else — Blake's ₹100, which
    // becomes a debt to Alex rather than to the owner — and only the last ₹50
    // is the owner holding Alex's money. Before payments were charged against
    // the debts they discharge, the whole ₹150 became a reverse debt on the
    // pair, which is what left settle-through-the-organiser groups in a loop.
    expect(rows.find((r) => r.fromId === BLAKE && r.toId === ALEX)!.amount).toBe(10_000);
    expect(rows.find((r) => r.fromId === OWNER_SENTINEL && r.toId === ALEX)!.amount).toBe(5_000);
    expect(rows.some((r) => r.fromId === ALEX)).toBe(false);
    const { members } = computeMemberBalances(expenses, settlements, [ALEX, BLAKE]);
    expect(position(rows, ALEX)).toBe(members.find((m) => m.participantId === ALEX)!.net);
  });

  it("gives one row per person when everyone only ever owed the owner", () => {
    const rows = computeDetailedObligations(
      [expense("t1", 30_000, null, [[null, 10_000], [ALEX, 10_000], [BLAKE, 10_000]])],
      [],
      [ALEX, BLAKE]
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.toId === OWNER_SENTINEL)).toBe(true);
  });
});

describe("Your position nets each person, while the raw list does not", () => {
  // Reported from a real group: the same member appeared on both sides of one
  // position, and the totals counted them twice.
  //
  //     You'll receive  992      Srikant → you   992
  //     You'll pay      992      you → Srikant   248
  //                              you → Abhisekh  248  (+ two more)
  //
  // Both Srikant rows are genuine — each of them fronted a bill the other
  // shared — but between two people that is ONE standing of 744. The raw list
  // keeps both, because with Simplify off every row traces back to the bill
  // that created it (pinned by "shows BOTH directions for someone who paid AND
  // owes", above). "Where do I stand with Srikant" has a single answer, so the
  // position collapses them.
  const bothWays = [
    expense("t1", 99_200, null, [[null, 0], [BLAKE, 99_200]]), // Blake owes the owner 992
    expense("t2", 24_800, BLAKE, [[null, 24_800], [BLAKE, 0]]), // the owner owes Blake 248
  ];

  it("the raw obligations still show both legs", () => {
    const rows = computeDetailedObligations(bothWays, [], [BLAKE]);
    expect(rows).toHaveLength(2);
  });

  it("but the position states one figure per person", () => {
    const rows = computeDetailedObligations(bothWays, [], [BLAKE]);
    expect(viewerPositionTotals(rows, null)).toEqual({ receive: 74_400, pay: 0 });
    const { receive, pay } = viewerPosition(rows, null);
    expect(pay).toHaveLength(0);
    expect(receive).toHaveLength(1);
    expect(receive[0]).toMatchObject({ fromId: BLAKE, toId: OWNER_SENTINEL, amount: 74_400 });
  });

  it("receive − pay is still the viewer's standing", () => {
    const rows = computeDetailedObligations(bothWays, [], [BLAKE]);
    const { members } = computeMemberBalances(bothWays, [], [BLAKE]);
    const { receive, pay } = viewerPositionTotals(rows, null);
    // The owner's standing is the negative of the members' sum.
    expect(receive - pay).toBe(-members.reduce((t, m) => t + (m.participantId === null ? 0 : -m.net), 0));
  });

  it("two people who owe each other the same amount leave no row", () => {
    const even = [
      expense("t1", 30_000, null, [[null, 0], [BLAKE, 30_000]]),
      expense("t2", 30_000, BLAKE, [[null, 30_000], [BLAKE, 0]]),
    ];
    const rows = computeDetailedObligations(even, [], [BLAKE]);
    expect(rows).toHaveLength(2);
    expect(viewerPositionTotals(rows, null)).toEqual({ receive: 0, pay: 0 });
    const { receive, pay } = viewerPosition(rows, null);
    expect([...receive, ...pay]).toHaveLength(0);
  });

  it("nets from a member's point of view too, not just the owner's", () => {
    const rows = computeDetailedObligations(bothWays, [], [BLAKE]);
    expect(viewerPositionTotals(rows, BLAKE)).toEqual({ receive: 0, pay: 74_400 });
    const { pay } = viewerPosition(rows, BLAKE);
    expect(pay).toHaveLength(1);
    expect(pay[0]).toMatchObject({ fromId: BLAKE, toId: OWNER_SENTINEL, amount: 74_400 });
  });

  it("leaves a third party's obligations alone", () => {
    const withCasey = [...bothWays, expense("t3", 10_000, null, [[null, 0], [CASEY, 10_000]])];
    const rows = computeDetailedObligations(withCasey, [], [BLAKE, CASEY]);
    expect(viewerPositionTotals(rows, null)).toEqual({ receive: 84_400, pay: 0 });
    const { receive } = viewerPosition(rows, null);
    expect(receive.map((r) => r.fromId).sort()).toEqual([BLAKE, CASEY].sort());
  });

  it("nets before applying the threshold, so opposing dust cancels", () => {
    // 140 each way is two rows the raw list would show; the standing is zero.
    const dust = [
      expense("t1", 140, null, [[null, 0], [BLAKE, 140]]),
      expense("t2", 140, BLAKE, [[null, 140], [BLAKE, 0]]),
    ];
    const rows = computeDetailedObligations(dust, [], [BLAKE]);
    expect(rows).toHaveLength(2);
    expect(viewerPositionTotals(rows, null)).toEqual({ receive: 0, pay: 0 });
  });

  it("a netted standing under the threshold keeps its money in the totals", () => {
    // 300 owed one way, 240 the other: a standing of 60, below SETTLED_THRESHOLD.
    const nearlyEven = [
      expense("t1", 300, null, [[null, 0], [BLAKE, 300]]),
      expense("t2", 240, BLAKE, [[null, 240], [BLAKE, 0]]),
    ];
    const rows = computeDetailedObligations(nearlyEven, [], [BLAKE]);
    const totals = viewerPositionTotals(rows, null);
    expect(totals).toEqual({ receive: 60, pay: 0 });
    expect(totals.receive).toBeLessThan(SETTLED_THRESHOLD);
    // Not worth a row, still counted — the rule the Srisailam card broke.
    const { receive } = viewerPosition(rows, null);
    expect(receive).toHaveLength(0);
  });
});
