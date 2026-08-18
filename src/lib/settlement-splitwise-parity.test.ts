// Splitwise parity for the settle-up plan.
//
// Ledgerly and Splitwise use the same published heuristic — greedy largest
// debtor against largest creditor — so the pairing logic was never the
// difference. What differed was the tolerance: minimizeSettlements was being
// handed a ₹1 epsilon, and it drops any debtor, creditor or transfer at or
// below that epsilon *while still decrementing the balances*. A group carrying
// sub-rupee amounts therefore got a plan that silently failed to clear
// everyone. Splitwise settles to the cent; the plan now settles to the paisa.
//
// These cases pin the properties Splitwise's settle-up guarantees, so the
// tolerance cannot creep back in.

import { describe, expect, it } from "vitest";
import { computeSuggestions } from "./group-dashboard";
import { minimizeSettlements, type NetBalance } from "./settlement";

/** Applies a plan and returns whatever balance is left on each person. */
function residue(balances: NetBalance[], plan: { fromId: string; toId: string; amount: number }[]) {
  const left = new Map(balances.map((b) => [b.id, b.net]));
  for (const t of plan) {
    left.set(t.fromId, (left.get(t.fromId) ?? 0) + t.amount);
    left.set(t.toId, (left.get(t.toId) ?? 0) - t.amount);
  }
  return [...left.values()];
}

/** A deterministic PRNG, so a failure is always reproducible. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** Random balances in paise that sum to exactly zero. */
function randomBalances(rand: () => number, n: number): NetBalance[] {
  const out: NetBalance[] = [];
  let running = 0;
  for (let i = 0; i < n - 1; i++) {
    const v = Math.round((rand() - 0.5) * 200_000); // ±₹1,000, whole paise
    out.push({ id: `p${i}`, net: v });
    running += v;
  }
  out.push({ id: `p${n - 1}`, net: -running });
  return out;
}

describe("the plan settles to the paisa, like Splitwise settles to the cent", () => {
  it("clears every participant exactly, across 500 random groups", () => {
    const rand = rng(20260818);
    for (let i = 0; i < 500; i++) {
      const balances = randomBalances(rand, 2 + Math.floor(rand() * 7));
      const plan = minimizeSettlements(balances, 0);
      expect(residue(balances, plan).every((v) => v === 0)).toBe(true);
    }
  });

  it("never moves more than someone owes, or more than someone is owed", () => {
    const rand = rng(7);
    for (let i = 0; i < 200; i++) {
      const balances = randomBalances(rand, 2 + Math.floor(rand() * 6));
      const plan = minimizeSettlements(balances, 0);
      const paid = new Map<string, number>();
      const got = new Map<string, number>();
      for (const t of plan) {
        expect(t.amount).toBeGreaterThan(0);
        paid.set(t.fromId, (paid.get(t.fromId) ?? 0) + t.amount);
        got.set(t.toId, (got.get(t.toId) ?? 0) + t.amount);
      }
      for (const b of balances) {
        if (b.net < 0) expect(paid.get(b.id) ?? 0).toBe(-b.net);
        if (b.net > 0) expect(got.get(b.id) ?? 0).toBe(b.net);
        // Nobody both pays and receives in a minimised plan.
        if (b.net < 0) expect(got.get(b.id) ?? 0).toBe(0);
        if (b.net > 0) expect(paid.get(b.id) ?? 0).toBe(0);
      }
    }
  });

  it("uses at most n−1 payments, the bound the greedy heuristic guarantees", () => {
    const rand = rng(99);
    for (let i = 0; i < 200; i++) {
      const n = 2 + Math.floor(rand() * 7);
      const balances = randomBalances(rand, n);
      expect(minimizeSettlements(balances, 0).length).toBeLessThanOrEqual(n - 1);
    }
  });

  it("pairs the largest debtor with the largest creditor first", () => {
    // The documented Splitwise heuristic, asserted directly on an unambiguous case.
    const plan = minimizeSettlements(
      [
        { id: "bigCreditor", net: 700_00 },
        { id: "smallCreditor", net: 100_00 },
        { id: "bigDebtor", net: -500_00 },
        { id: "smallDebtor", net: -300_00 },
      ],
      0
    );
    expect(plan[0]).toEqual({ fromId: "bigDebtor", toId: "bigCreditor", amount: 500_00 });
  });

  it("a ₹1 epsilon would strand money — the regression this guards", () => {
    const balances: NetBalance[] = [
      { id: "me", net: 500_075 },
      { id: "a", net: -300_000 },
      { id: "b", net: -200_000 },
      { id: "c", net: -75 },
    ];
    // What the old call produced: c's 75 paise had no row and stayed unsettled.
    expect(residue(balances, minimizeSettlements(balances, 100)).some((v) => v !== 0)).toBe(true);
    // What it produces now.
    expect(residue(balances, minimizeSettlements(balances, 0)).every((v) => v === 0)).toBe(true);
  });
});

describe("computeSuggestions inherits the exact settlement", () => {
  it("emits a row for a sub-rupee debt rather than dropping it", () => {
    const s = computeSuggestions([
      { participantId: null, net: 75, name: "You" },
      { participantId: "c", net: 75, name: "Cara" },
    ]);
    expect(s).toHaveLength(1);
    expect(s[0].amount).toBe(75);
  });

  it("clears the group even when the split left odd paise behind", () => {
    // ₹1,000 three ways: 333.34 / 333.33 / 333.33.
    const members = [
      { participantId: null, net: 66_666, name: "You" },
      { participantId: "a", net: 33_333, name: "A" },
      { participantId: "b", net: 33_333, name: "B" },
    ];
    const plan = computeSuggestions(members);
    const ledger = new Map<string, number>();
    for (const m of members) ledger.set(m.participantId ?? "me", m.participantId === null ? m.net : -m.net);
    for (const t of plan) {
      ledger.set(t.fromId, (ledger.get(t.fromId) ?? 0) + t.amount);
      ledger.set(t.toId, (ledger.get(t.toId) ?? 0) - t.amount);
    }
    for (const [, v] of ledger) expect(v).toBe(0);
  });
});
