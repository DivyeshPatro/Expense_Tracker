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
