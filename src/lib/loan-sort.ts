// How the Lending history is ORDERED ON SCREEN.
//
// This is presentation only and must stay that way. Money allocation has its
// own fixed rule — FIFO_ORDER in loan-settlement.ts, oldest date then oldest
// entry — and nothing here is ever passed to it. Choosing "Highest amount"
// changes what you look at first; it must never change which loan a repayment
// pays down.

export type LoanSort = "recent" | "oldest" | "highest" | "lowest";

export const LOAN_SORTS: { value: LoanSort; label: string }[] = [
  { value: "recent", label: "Recent" },
  { value: "oldest", label: "Oldest" },
  { value: "highest", label: "Highest amount" },
  { value: "lowest", label: "Lowest amount" },
];

export const DEFAULT_LOAN_SORT: LoanSort = "recent";

export function parseLoanSort(raw: string | null | undefined): LoanSort {
  return LOAN_SORTS.some((s) => s.value === raw) ? (raw as LoanSort) : DEFAULT_LOAN_SORT;
}

/** The minimum a row needs to be ordered. */
export interface SortableLoanEntry {
  amount: number;
  ymd: string; // "YYYY-MM-DD"
  createdAt: string; // ISO instant
}

/** Newest first: by date, then by which was entered later that day. */
const byRecency = (a: SortableLoanEntry, b: SortableLoanEntry) =>
  b.ymd.localeCompare(a.ymd) || b.createdAt.localeCompare(a.createdAt);

/**
 * A copy of `entries` in the chosen order. Never mutates its input — the caller
 * holds the same array the summary and running-balance figures are computed
 * from, and reordering those in place would change numbers that are supposed to
 * be chronological.
 *
 * The amount sorts fall back to recency so equal amounts have a defined order
 * rather than inheriting whatever the caller passed.
 */
export function sortLoanEntries<T extends SortableLoanEntry>(entries: T[], sort: LoanSort): T[] {
  const rows = [...entries];
  switch (sort) {
    case "oldest":
      return rows.sort((a, b) => -byRecency(a, b));
    case "highest":
      return rows.sort((a, b) => b.amount - a.amount || byRecency(a, b));
    case "lowest":
      return rows.sort((a, b) => a.amount - b.amount || byRecency(a, b));
    case "recent":
    default:
      return rows.sort(byRecency);
  }
}

/** Month headings only make sense while the list runs in date order. */
export function groupsByMonth(sort: LoanSort): boolean {
  return sort === "recent" || sort === "oldest";
}

// ── Contacts list (the Lending dashboard) ───────────────────────────────────
//
// A sibling of the history sort above, not a reuse of it: a contact row is a
// different thing from a ledger entry. It carries a SIGNED net balance rather
// than an amount, a last-activity date rather than its own date, and a name
// worth ordering by. Same rule though — presentation only, never near FIFO.

export type ContactSort = "recent" | "oldest" | "highest" | "lowest" | "name";

export const CONTACT_SORTS: { value: ContactSort; label: string }[] = [
  { value: "recent", label: "Recent" },
  { value: "oldest", label: "Oldest" },
  { value: "highest", label: "Highest amount" },
  { value: "lowest", label: "Lowest amount" },
  { value: "name", label: "Person" },
];

export const DEFAULT_CONTACT_SORT: ContactSort = "recent";

export function parseContactSort(raw: string | null | undefined): ContactSort {
  return CONTACT_SORTS.some((s) => s.value === raw) ? (raw as ContactSort) : DEFAULT_CONTACT_SORT;
}

export interface SortableContact {
  name: string;
  /** Signed paise: positive ⇒ they owe you, negative ⇒ you owe them. */
  net: number;
  /** null when the contact has no transactions yet. */
  lastTransactionYmd: string | null;
}

const byName = (a: SortableContact, b: SortableContact) => a.name.localeCompare(b.name);

/** Newest activity first. Contacts with no transactions sort last, whichever
 *  direction the dates run — an empty contact is not "the oldest". */
function byActivity(a: SortableContact, b: SortableContact, oldestFirst: boolean): number {
  if (!a.lastTransactionYmd && !b.lastTransactionYmd) return byName(a, b);
  if (!a.lastTransactionYmd) return 1;
  if (!b.lastTransactionYmd) return -1;
  const cmp = oldestFirst
    ? a.lastTransactionYmd.localeCompare(b.lastTransactionYmd)
    : b.lastTransactionYmd.localeCompare(a.lastTransactionYmd);
  return cmp || byName(a, b);
}

/**
 * A copy of `contacts` in the chosen order. Never mutates its input.
 *
 * "Amount" means the SIZE of the balance regardless of direction: the list
 * mixes people who owe you with people you owe, and the useful question is
 * "where is the most money", not "who is furthest into the positive".
 *
 * Every comparison falls back to name so the order is total — two contacts with
 * equal balances, or the same last-activity date, can never swap between
 * renders.
 */
export function sortLendingContacts<T extends SortableContact>(contacts: T[], sort: ContactSort): T[] {
  const rows = [...contacts];
  switch (sort) {
    case "oldest":
      return rows.sort((a, b) => byActivity(a, b, true));
    case "highest":
      return rows.sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || byName(a, b));
    case "lowest":
      return rows.sort((a, b) => Math.abs(a.net) - Math.abs(b.net) || byName(a, b));
    case "name":
      return rows.sort(byName);
    case "recent":
    default:
      return rows.sort((a, b) => byActivity(a, b, false));
  }
}
