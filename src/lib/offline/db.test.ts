import { describe, expect, it } from "vitest";
import { nextSeq, pendingDeltaPaise, pendingTotalDelta } from "./db";

// The spec's hard boundary (§8): client-side money math is bounded, labeled
// paise addition — these tests pin its exactness.
describe("provisional display deltas", () => {
  it("expense create counts against the total, rupees→paise exact", () => {
    expect(pendingDeltaPaise({ kind: "expense.create", payload: { amount: "423.50" } })).toBe(-42350);
  });

  it("income create counts toward the total", () => {
    expect(pendingDeltaPaise({ kind: "income.create", payload: { amount: "25000" } })).toBe(2500000);
  });

  it("transfer nets to zero at the total-balance level", () => {
    expect(pendingDeltaPaise({ kind: "transfer.create", payload: { amount: "1000" } })).toBe(0);
  });

  it("garbage amounts contribute nothing rather than NaN-poisoning the balance", () => {
    expect(pendingDeltaPaise({ kind: "expense.create", payload: { amount: "abc" } })).toBe(0);
    expect(pendingDeltaPaise({ kind: "expense.create", payload: {} })).toBe(0);
    expect(pendingDeltaPaise({ kind: "expense.create", payload: undefined as unknown as object })).toBe(0);
  });

  it("totals sum across mixed kinds", () => {
    expect(
      pendingTotalDelta([
        { kind: "expense.create", payload: { amount: "100" } },
        { kind: "income.create", payload: { amount: "250.25" } },
        { kind: "transfer.create", payload: { amount: "999" } },
      ])
    ).toBe(-10000 + 25025);
  });
});

describe("outbox FIFO seq", () => {
  it("is strictly increasing within a session", () => {
    const a = nextSeq();
    const b = nextSeq();
    const c = nextSeq();
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});
