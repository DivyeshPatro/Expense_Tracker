// Flexible, deterministic parsing of date/amount cells from real-world
// spreadsheet exports (Indian bank statements, Monito, generic CSV). No AI —
// pattern matching and format heuristics only.

const MONTH_ABBR: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30); // Excel serial date 0

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function ymd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000 || y > 9999) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Parses a date cell (Date object from xlsx cellDates, Excel serial number, or string) to "YYYY-MM-DD". */
export function parseFlexibleDate(raw: unknown): string | null {
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    return ymd(raw.getUTCFullYear(), raw.getUTCMonth() + 1, raw.getUTCDate());
  }
  if (typeof raw === "number") {
    if (raw < 1 || raw > 100000) return null;
    const ms = EXCEL_EPOCH_MS + raw * 86400000;
    const d = new Date(ms);
    return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const s = String(raw ?? "").trim();
  if (!s) return null;

  // ISO: 2026-07-10
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return ymd(+m[1], +m[2], +m[3]);

  // DD/MM/YYYY or DD-MM-YYYY (default Indian day-first; swap if day component > 12 and month doesn't fit)
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    const [, a, b, y] = m;
    let year = +y;
    if (year < 100) year += year < 50 ? 2000 : 1900;
    let day = +a;
    let month = +b;
    if (day > 12 && month <= 12) {
      // unambiguous day-first
    } else if (month > 12 && day <= 12) {
      [day, month] = [month, day]; // was actually MM/DD/YYYY
    }
    return ymd(year, month, day);
  }

  // "10 Jul 2026" / "10-Jul-2026" / "Jul 10, 2026"
  m = s.match(/^(\d{1,2})[\s-]([a-zA-Z]{3,})[\s,-]+(\d{4})$/);
  if (m) {
    const mon = MONTH_ABBR[m[2].slice(0, 3).toLowerCase()];
    if (mon) return ymd(+m[3], mon, +m[1]);
  }
  m = s.match(/^([a-zA-Z]{3,})[\s-]+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mon = MONTH_ABBR[m[1].slice(0, 3).toLowerCase()];
    if (mon) return ymd(+m[3], mon, +m[2]);
  }

  const native = Date.parse(s);
  if (!isNaN(native)) {
    const d = new Date(native);
    return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  return null;
}

export interface ParsedAmount {
  paise: number; // always non-negative magnitude
  negative: boolean; // sign as written (parentheses, leading -, or Dr suffix)
}

/** Parses an amount cell, handling ₹/Rs/INR symbols, thousands separators, parentheses and Dr/Cr suffixes. */
export function parseFlexibleAmount(raw: unknown): ParsedAmount | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return { paise: Math.round(Math.abs(raw) * 100), negative: raw < 0 };
  }
  let s = String(raw ?? "").trim();
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }

  const drCr = s.match(/\b(dr|cr)\b\.?\s*$/i);
  if (drCr) {
    negative = drCr[1].toLowerCase() === "dr";
    s = s.slice(0, drCr.index).trim();
  }

  s = s.replace(/[₹$]|rs\.?|inr/gi, "").trim();
  if (/^-/.test(s)) {
    negative = true;
    s = s.slice(1);
  } else if (/^\+/.test(s)) {
    s = s.slice(1);
  }
  s = s.replace(/,/g, "").trim();

  if (!s || !/^\d+(\.\d+)?$/.test(s)) return null;
  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  return { paise: Math.round(value * 100), negative };
}
