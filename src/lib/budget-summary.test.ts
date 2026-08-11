import { describe, expect, it } from "vitest";
import { summarizeBudgets, type BudgetLike } from "./budget-summary";

// The exact seeded shape that produced the reported bug: five budgets,
// Shopping ₹150 over, header claiming ₹13,871 left against ₹22,500 − ₹8,779.
const SEEDED: BudgetLike[] = [
  { limit: 800000, spent: 269900 }, // Food      ₹5,301 left
  { limit: 600000, spent: 124000 }, // Groceries ₹4,760 left
  { limit: 300000, spent: 315000 }, // Shopping  ₹150 OVER
  { limit: 300000, spent: 100000 }, // ₹2,000 left
  { limit: 250000, spent: 69000 }, //  ₹1,810 left
];

describe("summarizeBudgets — the identity that was broken", () => {
  it("leftInBudget = budgeted − spent + overAmount, always", () => {
    const s = summarizeBudgets(SEEDED);
    expect(s.leftInBudget).toBe(s.netRemaining + s.overAmount);
  });

  it("reproduces the reported figures and explains the ₹150 gap", () => {
    const s = summarizeBudgets(SEEDED);
    expect(s.budgeted).toBe(2250000); // ₹22,500
    expect(s.spent).toBe(877900); // ₹8,779
    expect(s.netRemaining).toBe(1372100); // ₹13,721 — what subtraction gives
    expect(s.leftInBudget).toBe(1387100); // ₹13,871 — what the header showed
    expect(s.overAmount).toBe(15000); // ₹150 — the difference, now surfaced
    expect(s.overCount).toBe(1);
  });

  it("the two remaining figures agree exactly when nothing is over", () => {
    const s = summarizeBudgets(SEEDED.filter((b) => b.spent <= b.limit));
    expect(s.overAmount).toBe(0);
    expect(s.leftInBudget).toBe(s.netRemaining);
  });

  it("handles every category being over", () => {
    const s = summarizeBudgets([
      { limit: 1000, spent: 1500 },
      { limit: 2000, spent: 2200 },
    ]);
    expect(s.leftInBudget).toBe(0);
    expect(s.overAmount).toBe(700);
    expect(s.netRemaining).toBe(-700);
    expect(s.overCount).toBe(2);
    expect(s.leftInBudget).toBe(s.netRemaining + s.overAmount);
  });

  it("treats spending exactly to the limit as not over", () => {
    const s = summarizeBudgets([{ limit: 5000, spent: 5000 }]);
    expect(s.overCount).toBe(0);
    expect(s.overAmount).toBe(0);
    expect(s.leftInBudget).toBe(0);
  });

  it("returns zeroes for no budgets rather than NaN", () => {
    expect(summarizeBudgets([])).toEqual({
      budgeted: 0,
      spent: 0,
      leftInBudget: 0,
      overAmount: 0,
      netRemaining: 0,
      overCount: 0,
    });
  });
});
