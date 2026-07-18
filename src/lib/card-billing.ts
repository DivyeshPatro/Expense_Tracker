// Card Billing Intelligence (Lending Phase 2, Priority 3) — pure date math
// over a credit card's statement/due day-of-month, no database. Reuses
// dates.ts's month-arithmetic helpers rather than reinventing them.

import { addDaysYMD, daysBetweenYMD, MONTH_NAMES, shiftMonthKey, todayYMD } from "./dates";

function daysInMonth(y: number, m: number): number {
  // day 0 of month m+1 === the last day of month m (m is 1-12)
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function clampDay(y: number, m: number, day: number): number {
  return Math.min(day, daysInMonth(y, m));
}

function ymdOf(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseYmd(ymd: string): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.split("-").map(Number);
  return { y, m, d };
}

export interface CardCycle {
  cycleStart: string; // YYYY-MM-DD, inclusive
  statementDate: string; // YYYY-MM-DD — the cycle's statement-cut date
  dueDate: string; // YYYY-MM-DD — payment due date for this cycle
}

/**
 * Which billing cycle a spend date falls into, and when that cycle's
 * payment is due. One rule handles every edge case (leap years, variable
 * month lengths, statement-day-after-due-day, December → January rollover)
 * uniformly, with no special-casing per case:
 *
 *  - a date belongs to the cycle whose statement day (clamped to that
 *    month's real length) is the next one on or after it — a spend exactly
 *    ON the statement day is treated as included in that day's cut.
 *  - the due date is the smallest date *after* the statement date carrying
 *    day-of-month `dueDay` (also clamped) — this alone produces the right
 *    answer whether dueDay is numerically before or after statementDay,
 *    with no separate branch needed: due dates always land in the
 *    statement's own month when dueDay > statementDay, and roll into the
 *    next month otherwise (a due date can never precede its own statement).
 */
export function cardCycleForDate(occurredYmd: string, statementDay: number, dueDay: number): CardCycle {
  const { y, m, d } = parseYmd(occurredYmd);

  const thisMonthStatementDay = clampDay(y, m, statementDay);
  let cycleEndKey = `${y}-${String(m).padStart(2, "0")}`;
  if (d > thisMonthStatementDay) {
    cycleEndKey = shiftMonthKey(cycleEndKey, 1);
  }
  const { y: cy, m: cm } = parseYmd(`${cycleEndKey}-01`);
  const statementDateDay = clampDay(cy, cm, statementDay);
  const statementDate = ymdOf(cy, cm, statementDateDay);

  const dueDayInStatementMonth = clampDay(cy, cm, dueDay);
  let dueDate: string;
  if (dueDayInStatementMonth > statementDateDay) {
    dueDate = ymdOf(cy, cm, dueDayInStatementMonth);
  } else {
    const nextKey = shiftMonthKey(cycleEndKey, 1);
    const { y: ny, m: nm } = parseYmd(`${nextKey}-01`);
    dueDate = ymdOf(ny, nm, clampDay(ny, nm, dueDay));
  }

  const prevKey = shiftMonthKey(cycleEndKey, -1);
  const { y: py, m: pm } = parseYmd(`${prevKey}-01`);
  const cycleStart = addDaysYMD(ymdOf(py, pm, clampDay(py, pm, statementDay)), 1);

  return { cycleStart, statementDate, dueDate };
}

function shortDateLabel(ymd: string): string {
  const { m, d } = parseYmd(ymd);
  return `${d} ${MONTH_NAMES[m - 1]}`;
}

/** "Recover before 18 Aug to avoid interest" style guidance, with urgency
 * copy for the last week and an explicit overdue phrasing once it's passed. */
export function formatCardGuidance(dueYmd: string, now: Date = new Date()): string {
  const days = daysBetweenYMD(todayYMD(now), dueYmd);
  const label = shortDateLabel(dueYmd);
  if (days < 0) return `Overdue since ${label}`;
  if (days === 0) return `Due today (${label}) — recover now to avoid interest`;
  if (days === 1) return `Recover before ${label} — 1 day left`;
  if (days <= 7) return `Recover before ${label} — ${days} days left`;
  return `Recover before ${label} to avoid interest`;
}
