// Budget header arithmetic, kept pure so the numbers on the screen can be
// asserted in a test rather than trusted.
//
// The bug this replaces: the header showed "Left to spend ₹13,871" beside
// "Spent ₹8,779" and "Budgeted ₹22,500", and 22,500 − 8,779 is 13,721. The
// ₹150 gap was Shopping being over limit — "left" floored each category at
// zero while the other two were true totals. Both models are defensible; a
// user subtracting the two numbers in front of them was not wrong to expect
// them to agree.
//
// Resolution: keep the floored figure (it is the actionable one — headroom in
// an overspent category is not headroom) and expose `overAmount` so the
// relationship is visible instead of inferred:
//
//     leftInBudget = budgeted − spent + overAmount

export interface BudgetLike {
  limit: number; // paise
  spent: number; // paise
}

export interface BudgetSummary {
  /** Σ limit */
  budgeted: number;
  /** Σ spent */
  spent: number;
  /** Σ max(0, limit − spent) — headroom you can actually still use. */
  leftInBudget: number;
  /** Σ max(0, spent − limit) — how far past the line the over-limit categories are. */
  overAmount: number;
  /** budgeted − spent. Can be negative. The figure a user gets by subtracting. */
  netRemaining: number;
  /** How many categories are over. */
  overCount: number;
}

export function summarizeBudgets(budgets: BudgetLike[]): BudgetSummary {
  let budgeted = 0;
  let spent = 0;
  let leftInBudget = 0;
  let overAmount = 0;
  let overCount = 0;

  for (const b of budgets) {
    budgeted += b.limit;
    spent += b.spent;
    const delta = b.limit - b.spent;
    if (delta >= 0) {
      leftInBudget += delta;
    } else {
      overAmount += -delta;
      overCount += 1;
    }
  }

  return { budgeted, spent, leftInBudget, overAmount, netRemaining: budgeted - spent, overCount };
}
