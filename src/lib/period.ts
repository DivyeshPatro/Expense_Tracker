// Shared "selected period" concept driving Dashboard, Transactions, Accounts
// and Analytics off the same URL search params (?p=YYYY-MM | ?p=all | ?from&to),
// so switching sections keeps the same window instead of each page defaulting
// to its own notion of "current".

import { addDaysYMD, currentMonthKey, friendlyDay, istMidnight, monthName, monthRange, todayYMD } from "./dates";

// "recent" (issue #186) is the DEFAULT: a rolling last-30-days window rather
// than the calendar month. A calendar-month default meant that on the 3rd of a
// month you saw almost nothing — measured 1 of 71 transactions on a real
// account, i.e. 98.6% of the ledger hidden behind a picker most people never
// open. A rolling window always has something in it.
export type PeriodMode = "recent" | "month" | "custom" | "all";

/** How many days the default rolling window covers, inclusive of today. */
export const RECENT_DAYS = 30;

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

export interface Period {
  mode: PeriodMode;
  currentMonthKey: string;
  periodKey: string; // "YYYY-MM" — meaningful when mode === "month"
  from: string; // "YYYY-MM-DD"
  to: string; // "YYYY-MM-DD"
  range: { start: Date | undefined; end: Date | undefined }; // [start, end)
  label: string; // "JULY 2026" / "TO DATE" / "11 JUL – 20 JUL"
}

export function parsePeriod(sp: Record<string, string | undefined>, now = new Date()): Period {
  const key = currentMonthKey(now);
  const today = todayYMD(now);
  // no params ⇒ the rolling default, not the calendar month
  let mode: PeriodMode = "recent";
  let periodKey = key;
  let from = addDaysYMD(today, -(RECENT_DAYS - 1));
  let to = today;
  if (sp.p === "all") {
    mode = "all";
  } else if (sp.p && MONTH_RE.test(sp.p) && sp.p <= key) {
    mode = "month";
    periodKey = sp.p;
    from = `${sp.p}-01`;
  } else if (sp.from && sp.to && YMD_RE.test(sp.from) && YMD_RE.test(sp.to) && sp.from <= sp.to) {
    mode = "custom";
    from = sp.from;
    to = sp.to;
  }
  const range =
    mode === "all"
      ? { start: undefined, end: undefined }
      : mode === "month"
        ? monthRange(periodKey)
        : // recent and custom are both plain inclusive [from, to] windows
          { start: istMidnight(from), end: istMidnight(addDaysYMD(to, 1)) };
  const label =
    mode === "all"
      ? "TO DATE"
      : mode === "recent"
        ? `LAST ${RECENT_DAYS} DAYS`
        : mode === "custom"
          ? `${friendlyDay(from, now).toUpperCase()} – ${friendlyDay(to, now).toUpperCase()}`
          : `${monthName(periodKey).toUpperCase()} ${periodKey.slice(0, 4)}`;
  return { mode, currentMonthKey: key, periodKey, from, to, range, label };
}

/** The query string (sans leading "?") that reproduces this period — "" for the
 *  default (last 30 days). Month mode always emits `p=`, including the current
 *  month: since #186 an empty query string means "recent", not "this month". */
export function periodQueryParams(p: Pick<Period, "mode" | "periodKey" | "from" | "to" | "currentMonthKey">): string {
  if (p.mode === "all") return "p=all";
  if (p.mode === "custom") return `from=${p.from}&to=${p.to}`;
  if (p.mode === "month") return `p=${p.periodKey}`;
  return "";
}
