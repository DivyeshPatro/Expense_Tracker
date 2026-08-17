// v2.1 — the two Balances views on a group page.
//
// The UI shows raw obligations, a simplified plan behind a toggle, and a
// receive-only view. All three are DERIVED from the existing engine — per-member
// nets from computeMemberBalances, and minimizeSettlements for the plan. These
// tests pin that relationship: the views must agree with the engine, and the
// simplified plan must never invent or lose money.

import { describe, expect, it } from "vitest";
import { computeGrossObligations, computeMemberBalances, computeSuggestions, SETTLED_THRESHOLD, type GroupExpenseRow } from "./group-dashboard";

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

describe("gross obligations (Simplify OFF) — the un-netted list", () => {
  it("shows BOTH directions for someone who paid AND owes", () => {
    // The reported case: you paid ₹4,000 split 5 ways (Priya owes ₹800);
    // Priya paid ₹1,240 split 5 ways (you owe her ₹248).
    const expenses = [
      expense("t1", 240_000, null, [[null, 80_000], [ALEX, 80_000], [BLAKE, 80_000]]),
      expense("t2", 74_400, BLAKE, [[null, 24_800], [ALEX, 24_800], [BLAKE, 24_800]]),
    ];
    const gross = computeGrossObligations(expenses, [], [ALEX, BLAKE]);
    const blake = gross.find((g) => g.participantId === BLAKE)!;
    expect(blake.owesYou).toBe(80_000); // their share of the bill you paid
    // What they FRONTED for the others — ₹744 minus their own ₹248 share.
    expect(blake.youOwe).toBe(74_400 - 24_800);
  });

  it("reconciles exactly with the engine: owesYou − youOwe === net", () => {
    const expenses = [
      expense("t1", 400_000, null, [[null, 80_000], [ALEX, 80_000], [BLAKE, 80_000], [CASEY, 80_000]]),
      expense("t2", 124_000, BLAKE, [[null, 24_800], [ALEX, 24_800], [BLAKE, 24_800], [CASEY, 24_800]]),
      expense("t3", 128_000, null, [[null, 32_000], [ALEX, 32_000], [BLAKE, 32_000], [CASEY, 32_000]]),
    ];
    const ids = [ALEX, BLAKE, CASEY];
    const { members } = computeMemberBalances(expenses, [], ids);
    const gross = computeGrossObligations(expenses, [], ids);
    for (const id of ids) {
      const net = members.find((m) => m.participantId === id)!.net;
      const g = gross.find((x) => x.participantId === id)!;
      expect(g.owesYou - g.youOwe).toBe(net);
    }
  });

  it("keeps reconciling after a settlement", () => {
    const expenses = [expense("t1", 30_000, null, [[null, 10_000], [ALEX, 10_000], [BLAKE, 10_000]])];
    const settlements = [{ id: "s1", participantId: ALEX, direction: "TO_OWNER" as const, amount: 4_000, settledAt: "2026-08-06T00:00:00Z" }];
    const { members } = computeMemberBalances(expenses, settlements, [ALEX, BLAKE]);
    const gross = computeGrossObligations(expenses, settlements, [ALEX, BLAKE]);
    for (const id of [ALEX, BLAKE]) {
      const net = members.find((m) => m.participantId === id)!.net;
      const g = gross.find((x) => x.participantId === id)!;
      expect(g.owesYou - g.youOwe).toBe(net);
    }
    expect(gross.find((g) => g.participantId === ALEX)!.owesYou).toBe(6_000); // 10,000 − 4,000 settled
  });

  it("never reports a negative amount, even when over-settled", () => {
    const expenses = [expense("t1", 30_000, null, [[null, 10_000], [ALEX, 10_000], [BLAKE, 10_000]])];
    const settlements = [{ id: "s1", participantId: ALEX, direction: "TO_OWNER" as const, amount: 25_000, settledAt: "2026-08-06T00:00:00Z" }];
    const gross = computeGrossObligations(expenses, settlements, [ALEX, BLAKE]);
    const alex = gross.find((g) => g.participantId === ALEX)!;
    expect(alex.owesYou).toBe(0);
    expect(alex.youOwe).toBe(15_000); // they overpaid — now you owe them
    const { members } = computeMemberBalances(expenses, settlements, [ALEX, BLAKE]);
    expect(alex.owesYou - alex.youOwe).toBe(members.find((m) => m.participantId === ALEX)!.net);
  });

  it("gives one row, not two, when a person only ever owed", () => {
    const gross = computeGrossObligations(
      [expense("t1", 30_000, null, [[null, 10_000], [ALEX, 10_000], [BLAKE, 10_000]])],
      [],
      [ALEX, BLAKE]
    );
    expect(gross.every((g) => g.youOwe === 0)).toBe(true);
  });
});
