// Date helpers pinned to Asia/Kolkata (PRD §2) regardless of server timezone.

const IST = "Asia/Kolkata";

const ymdFmt = new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" });

/** "2026-07-10" for a Date, in IST. */
export function toYMD(d: Date): string {
  return ymdFmt.format(d);
}

/** Today's "YYYY-MM-DD" in IST. */
export function todayYMD(now = new Date()): string {
  return toYMD(now);
}

/** "2026-07" month key in IST. */
export function monthKey(d: Date): string {
  return toYMD(d).slice(0, 7);
}

export function currentMonthKey(now = new Date()): string {
  return monthKey(now);
}

/** Month key shifted by `delta` months from the current one. */
export function shiftMonthKey(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

/** UTC Date range [start, end) covering an IST month key, for DB queries on occurredAt. */
export function monthRange(key: string): { start: Date; end: Date } {
  return { start: istMidnight(`${key}-01`), end: istMidnight(`${shiftMonthKey(key, 1)}-01`) };
}

/** UTC instant of IST midnight for a "YYYY-MM-DD". */
export function istMidnight(ymd: string): Date {
  return new Date(`${ymd}T00:00:00+05:30`);
}

/** Noon IST for a "YYYY-MM-DD" — safe representative instant for date-only values. */
export function istNoon(ymd: string): Date {
  return new Date(`${ymd}T12:00:00+05:30`);
}

/** Whole days from today (IST) to the given date; negative ⇒ past. */
export function daysFromToday(d: Date, now = new Date()): number {
  const a = istNoon(todayYMD(now)).getTime();
  const b = istNoon(toYMD(d)).getTime();
  return Math.round((b - a) / 86_400_000);
}

export function addDaysYMD(ymd: string, days: number): string {
  const d = istNoon(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return toYMD(d);
}

/** Roll a date forward by one cadence step (for bills / recurring rules). */
export function advance(ymd: string, cadence: "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY", interval = 1): string {
  const [y, m, d] = ymd.split("-").map(Number);
  switch (cadence) {
    case "DAILY":
      return addDaysYMD(ymd, interval);
    case "WEEKLY":
      return addDaysYMD(ymd, 7 * interval);
    case "MONTHLY":
    case "QUARTERLY":
    case "YEARLY": {
      const months = cadence === "MONTHLY" ? interval : cadence === "QUARTERLY" ? 3 * interval : 12 * interval;
      const total = y * 12 + (m - 1) + months;
      const ny = Math.floor(total / 12);
      const nm = (total % 12) + 1;
      const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
      return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
    }
  }
}

export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function monthName(key: string): string {
  return MONTH_NAMES[Number(key.slice(5)) - 1];
}

/** "Today" / "Yesterday" / "Jul 8" / "Dec 30 2025" for grouping lists. */
export function friendlyDay(ymd: string, now = new Date()): string {
  const today = todayYMD(now);
  if (ymd === today) return "Today";
  if (ymd === addDaysYMD(today, -1)) return "Yesterday";
  const [y, m, d] = ymd.split("-").map(Number);
  const label = `${MONTH_NAMES[m - 1]} ${d}`;
  return y === Number(today.slice(0, 4)) ? label : `${label} ${y}`;
}

/** Full heading like "Thursday, July 10 2026" (IST). */
export function fullToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: IST,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  })
    .format(now)
    .replace(/(\d+), (\d{4})/, "$1 $2");
}

/** IST hour (0–23) for greeting. */
export function istHour(now = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: IST, hour: "2-digit", hour12: false }).format(now));
}

export function greeting(now = new Date()): string {
  const h = istHour(now);
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}
