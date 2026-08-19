// FIFO must be a property of the data, not of the query plan.
//
// `occurredAt` is a date only, so two loans made on the same day compare equal.
// Array.prototype.sort is stable, so that tie silently inherited whatever order
// the caller passed — and the caller's query had no ORDER BY. Two runs could
// allocate the same repayment to different loans.
//
// These cases assert WHICH loan received the money, never just the total
// outstanding: a wrong allocation with a right total is exactly the failure
// mode that was possible.

import { describe, expect, it } from "vitest";
import { allocateFifo, FIFO_ORDER, type OpenLoan } from "./loan-settlement";

const loan = (id: string, amount: number, occurredAt: string, createdAt: string, settledAmount = 0): OpenLoan =>
  ({ id, amount, settledAmount, occurredAt, createdAt });

/** Remaining balance per loan after applying an allocation result. */
function remaining(loans: OpenLoan[], result: { gaveEntryId: string; amount: number }[]) {
  const applied = new Map<string, number>();
  for (const r of result) applied.set(r.gaveEntryId, (applied.get(r.gaveEntryId) ?? 0) + r.amount);
  return Object.fromEntries(loans.map((l) => [l.id, l.amount - l.settledAmount - (applied.get(l.id) ?? 0)]));
}

// The brief's worked example.
const A = loan("A", 100_000, "2026-01-10", "2026-01-10T09:00:00.000Z"); // entered first
const B = loan("B", 50_000, "2026-01-10", "2026-01-10T15:00:00.000Z"); // entered second

describe("A — same-day loans are deterministic", () => {
  it("gives the same answer whatever order the rows arrive in", () => {
    const forwards = allocateFifo(70_000, [A, B]);
    const backwards = allocateFifo(70_000, [B, A]);
    expect(backwards).toEqual(forwards);
  });

  it("is stable across repeated calls", () => {
    const runs = Array.from({ length: 10 }, () => JSON.stringify(allocateFifo(70_000, [B, A])));
    expect(new Set(runs).size).toBe(1);
  });
});

describe("B — same-day loans consume the oldest-created first", () => {
  it("₹700 against A(₹1,000, first) and B(₹500, second) goes entirely to A", () => {
    const result = allocateFifo(70_000, [A, B]);
    expect(result).toEqual([{ gaveEntryId: "A", amount: 70_000 }]);
    expect(remaining([A, B], result)).toEqual({ A: 30_000, B: 50_000 });
  });

  it("holds even when the rows are handed over newest-first", () => {
    const result = allocateFifo(70_000, [B, A]);
    expect(result).toEqual([{ gaveEntryId: "A", amount: 70_000 }]);
    expect(remaining([A, B], result)).toEqual({ A: 30_000, B: 50_000 });
  });
});

describe("C — partial repayment", () => {
  it("touches only the oldest loan and leaves it partly open", () => {
    const result = allocateFifo(40_000, [B, A]);
    expect(result).toEqual([{ gaveEntryId: "A", amount: 40_000 }]);
    expect(remaining([A, B], result)).toEqual({ A: 60_000, B: 50_000 });
  });
});

describe("D — full repayment", () => {
  it("clears the oldest exactly, without spilling into the newer one", () => {
    const result = allocateFifo(100_000, [B, A]);
    expect(result).toEqual([{ gaveEntryId: "A", amount: 100_000 }]);
    expect(remaining([A, B], result)).toEqual({ A: 0, B: 50_000 });
  });

  it("spills into the next loan only once the first is fully covered", () => {
    const result = allocateFifo(120_000, [B, A]);
    expect(result).toEqual([
      { gaveEntryId: "A", amount: 100_000 },
      { gaveEntryId: "B", amount: 20_000 },
    ]);
    expect(remaining([A, B], result)).toEqual({ A: 0, B: 30_000 });
  });

  it("clears both and leaves the excess unallocated", () => {
    const result = allocateFifo(200_000, [B, A]);
    expect(result.reduce((s, r) => s + r.amount, 0)).toBe(150_000); // ₹500 over
    expect(remaining([A, B], result)).toEqual({ A: 0, B: 0 });
  });
});

describe("E — several loans on one day", () => {
  const day = ["c", "b", "a", "d"].map((k, i) =>
    loan(k, 10_000, "2026-02-01", `2026-02-01T0${i}:00:00.000Z`)
  ); // entry order: c, b, a, d

  it("consumes them in entry order, not id order or query order", () => {
    const result = allocateFifo(25_000, [...day].reverse());
    expect(result).toEqual([
      { gaveEntryId: "c", amount: 10_000 },
      { gaveEntryId: "b", amount: 10_000 },
      { gaveEntryId: "a", amount: 5_000 },
    ]);
    expect(remaining(day, result)).toEqual({ c: 0, b: 0, a: 5_000, d: 10_000 });
  });
});

describe("F — several repayments in sequence", () => {
  it("each one continues where the last stopped", () => {
    let loans = [A, B];
    const first = allocateFifo(40_000, loans);
    expect(first).toEqual([{ gaveEntryId: "A", amount: 40_000 }]);
    // apply it, then repay again
    loans = loans.map((l) => ({ ...l, settledAmount: l.settledAmount + (first.find((r) => r.gaveEntryId === l.id)?.amount ?? 0) }));
    const second = allocateFifo(80_000, loans);
    expect(second).toEqual([
      { gaveEntryId: "A", amount: 60_000 }, // finishes A
      { gaveEntryId: "B", amount: 20_000 }, // then starts B
    ]);
    expect(remaining(loans, second)).toEqual({ A: 0, B: 30_000 });
  });
});

describe("G — different dates still follow the calendar", () => {
  it("an older date wins even when it was entered later", () => {
    const older = loan("older", 30_000, "2026-01-05", "2026-03-01T00:00:00.000Z"); // entered last
    const newer = loan("newer", 30_000, "2026-02-05", "2026-01-01T00:00:00.000Z"); // entered first
    const result = allocateFifo(30_000, [newer, older]);
    expect(result).toEqual([{ gaveEntryId: "older", amount: 30_000 }]);
  });

  it("fully-settled loans are skipped entirely", () => {
    const done = loan("done", 50_000, "2026-01-01", "2026-01-01T00:00:00.000Z", 50_000);
    const result = allocateFifo(20_000, [done, A]);
    expect(result).toEqual([{ gaveEntryId: "A", amount: 20_000 }]);
  });
});

describe("H — the algorithm itself is unchanged", () => {
  it("still caps each allocation at that loan's own remaining balance", () => {
    const partly = loan("p", 100_000, "2026-01-01", "2026-01-01T00:00:00.000Z", 70_000); // ₹300 left
    const result = allocateFifo(100_000, [partly, A]);
    expect(result).toEqual([
      { gaveEntryId: "p", amount: 30_000 },
      { gaveEntryId: "A", amount: 70_000 },
    ]);
  });

  it("allocates nothing when there is nothing open", () => {
    expect(allocateFifo(50_000, [])).toEqual([]);
  });

  it("never allocates more than the repayment", () => {
    const result = allocateFifo(10_000, [A, B]);
    expect(result.reduce((s, r) => s + r.amount, 0)).toBe(10_000);
  });
});

describe("FIFO_ORDER is the one definition of the order", () => {
  it("date first, entry time second", () => {
    expect(FIFO_ORDER(A, B)).toBeLessThan(0);
    expect(FIFO_ORDER(B, A)).toBeGreaterThan(0);
    expect(FIFO_ORDER(A, A)).toBe(0);
  });

  it("sorting by it reproduces the allocation order", () => {
    const shuffled = [B, A];
    expect([...shuffled].sort(FIFO_ORDER).map((l) => l.id)).toEqual(["A", "B"]);
  });
});
