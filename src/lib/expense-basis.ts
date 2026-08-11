// The three ways Ledgerly can answer "how much did you spend?", named once so
// no screen can pick one silently again.
//
// Before this module existed the dashboard, the transaction list and Insights
// each summed expenses differently and all three called the result "expense" —
// ₹77,719 / ₹81,459 / ₹52,487 for the same seeded 30 days. The numbers were
// individually defensible; presenting them under one word was not.
//
// Rule: any surface showing an expense total must pick a basis from here and
// render EXPENSE_BASIS[basis].label next to it. `personalShare` is canonical
// for "what did I spend" questions; the other two exist because balances and
// audits genuinely need them.

export type ExpenseBasis =
  /** Your share after splits. What you actually bear. CANONICAL. */
  | "personalShare"
  /** Full amount of rows you paid for. What left your accounts — balance math. */
  | "paidByYou"
  /** Full amount of every expense row, whoever paid. Literal sum of a list. */
  | "gross";

export interface ExpenseBasisMeta {
  /** Short label rendered beside the figure. */
  label: string;
  /** One-line explanation for tooltips / help text. */
  hint: string;
}

export const EXPENSE_BASIS: Record<ExpenseBasis, ExpenseBasisMeta> = {
  personalShare: {
    label: "your share",
    hint: "What you bear after splitting. Money you fronted for other people is not counted as your spending.",
  },
  paidByYou: {
    label: "paid by you",
    hint: "The full amount of everything you paid for, including other people's shares you fronted. This is what left your accounts.",
  },
  gross: {
    label: "gross",
    hint: "The full amount of every expense, including ones a friend paid. Use for auditing a list, not for judging your spending.",
  },
};

/** The basis every "how much did I spend" surface should use unless it has a documented reason not to. */
export const CANONICAL_EXPENSE_BASIS: ExpenseBasis = "personalShare";

// ── User preference ────────────────────────────────────────────────────────
//
// Cash and personal answer two different questions, so the app shows both and
// the preference only decides which one is the large figure. It is deliberately
// PRESENTATION ONLY: budgets, alerts, savings rate and exports stay on one
// fixed internal basis, so two users with different preferences still get the
// same budget warnings and the same exported data.
//
// Stored in a cookie rather than localStorage because the dashboard and
// transaction summaries are server components — the same reason the theme uses
// cookies (see lib/theme.ts). Server-rendered means no flash of the wrong
// figure, and no migration for a display-only choice.

export type ExpenseBasisPref = "cash" | "personal";

export const BASIS_COOKIE = "ledgerly-basis";

/** Cash matches the bank statement and the Accounts page, which is the least surprising first impression. */
export const DEFAULT_BASIS_PREF: ExpenseBasisPref = "cash";

export function parseBasisPref(raw: string | undefined | null): ExpenseBasisPref {
  return raw === "personal" || raw === "cash" ? raw : DEFAULT_BASIS_PREF;
}

/** Which internal basis a preference selects for the headline figure. */
export function basisFor(pref: ExpenseBasisPref): ExpenseBasis {
  return pref === "personal" ? "personalShare" : "paidByYou";
}

export interface BasisPrefMeta {
  label: string;
  description: string;
}

/** Settings copy. Phrased as the question each basis answers, not as jargon. */
export const BASIS_PREF: Record<ExpenseBasisPref, BasisPrefMeta> = {
  cash: {
    label: "Cash basis",
    description: "How much money actually left my accounts. Matches your bank statement and the Accounts page.",
  },
  personal: {
    label: "Personal basis",
    description: "How much of that spending is actually mine, after splitting with other people.",
  },
};

/** Headings used wherever both figures appear together, so they read identically on every screen. */
export const BASIS_FIGURE_LABEL: Record<ExpenseBasisPref, string> = {
  cash: "Cash outflow",
  personal: "Your share",
};

/** The minimum a row needs for its personal share to be derivable. */
export interface SplittableExpense {
  type: "EXPENSE" | "INCOME" | "TRANSFER";
  /** Full transaction amount in paise. */
  amount: number;
  /** The owner's own share in paise, or null when the row was never split. */
  ownShare: number | null;
}

/**
 * Your share of one row, in paise. Non-expenses contribute nothing.
 *
 * An unsplit expense is entirely yours. A split expense contributes only the
 * owner's own ExpenseSplit row — including when a friend paid, because your
 * share of a dinner someone else covered is still your expense (you owe it).
 */
export function personalShare(row: SplittableExpense): number {
  if (row.type !== "EXPENSE") return 0;
  return row.ownShare ?? row.amount;
}

/**
 * What you fronted for other people over a set of rows: the gap between what
 * you paid out and what you actually bear. Always >= 0.
 *
 * Drives the dashboard's "₹x owed back to you" sub-line, which is what stops
 * "your share" from looking like the app has lost money.
 */
export function frontedForOthers(paidByYou: number, personalShareTotal: number): number {
  return Math.max(0, paidByYou - personalShareTotal);
}
