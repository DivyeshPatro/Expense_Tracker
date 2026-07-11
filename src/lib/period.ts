// Shared "selected period" concept driving Dashboard, Transactions, Accounts
// and Analytics off the same URL search params (?p=YYYY-MM | ?p=all | ?from&to),
// so switching sections keeps the same window instead of each page defaulting
// to its own notion of "current".

import { addDaysYMD, currentMonthKey, friendlyDay, istMidnight, monthName, monthRange, todayYMD } from "./dates";

export type PeriodMode = "month" | "custom" | "all";

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
  let mode: PeriodMode = "month";
  let periodKey = key;
  let from = `${key}-01`;
  let to = today;
  if (sp.p === "all") {
    mode = "all";
  } else if (sp.p && MONTH_RE.test(sp.p) && sp.p <= key) {
    periodKey = sp.p;
  } else if (sp.from && sp.to && YMD_RE.test(sp.from) && YMD_RE.test(sp.to) && sp.from <= sp.to) {
    mode = "custom";
    from = sp.from;
    to = sp.to;
  }
  const range =
    mode === "all"
      ? { start: undefined, end: undefined }
      : mode === "custom"
        ? { start: istMidnight(from), end: istMidnight(addDaysYMD(to, 1)) } // `to` is inclusive
        : monthRange(periodKey);
  const label =
    mode === "all"
      ? "TO DATE"
      : mode === "custom"
        ? `${friendlyDay(from, now).toUpperCase()} – ${friendlyDay(to, now).toUpperCase()}`
        : `${monthName(periodKey).toUpperCase()} ${periodKey.slice(0, 4)}`;
  return { mode, currentMonthKey: key, periodKey, from, to, range, label };
}

/** The query string (sans leading "?") that reproduces this period — "" for the default (this month). */
export function periodQueryParams(p: Pick<Period, "mode" | "periodKey" | "from" | "to" | "currentMonthKey">): string {
  if (p.mode === "all") return "p=all";
  if (p.mode === "custom") return `from=${p.from}&to=${p.to}`;
  if (p.periodKey !== p.currentMonthKey) return `p=${p.periodKey}`;
  return "";
}
