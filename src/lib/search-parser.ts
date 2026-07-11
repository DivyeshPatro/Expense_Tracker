// Deterministic natural-language search parser (PRD §4.7 — zero AI, standing rule).
// Tokenizes the query and matches against the user's own merchants, categories,
// accounts and date/amount phrases, compiling to a structured filter. Unparseable
// queries fall back to plain full-text search — never an error state.

import { MONTH_NAMES, currentMonthKey, shiftMonthKey } from "./dates";

export interface ParserContext {
  merchants: string[];
  categories: { name: string; kind: "EXPENSE" | "INCOME" }[];
  accounts: { id: string; name: string; type: string }[];
  now?: Date;
}

export interface ParsedQuery {
  type: "EXPENSE" | "INCOME";
  monthKey: string | null;
  /** a bare year with no month ("expenses in 2023") — mutually exclusive with monthKey */
  yearKey: string | null;
  /** true when the user explicitly typed a year ("march 2023") — controls whether the year is echoed back */
  yearIsExplicit: boolean;
  merchant: string | null;
  category: string | null;
  accountId: string | null;
  accountType: string | null; // e.g. WALLET when the user says "upi"
  minPaise: number | null;
  maxPaise: number | null;
  /** true when at least one structured signal matched (else caller should full-text search) */
  matched: boolean;
}

const INCOME_WORDS = ["income", "earn", "earned", "received", "salary credited"];
const MONTH_FULL = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function parseQuery(q: string, ctx: ParserContext): ParsedQuery {
  const ql = q.toLowerCase().trim();
  const now = ctx.now ?? new Date();
  const thisMonth = currentMonthKey(now);
  const year = Number(thisMonth.slice(0, 4));

  // explicit 4-digit year anywhere in the query ("march 2023", "expenses in 2023")
  const yearMatch = ql.match(/\b(19|20)\d{2}\b/);
  const explicitYear = yearMatch ? Number(yearMatch[0]) : null;

  // month phrases
  let monthKey: string | null = null;
  let yearKey: string | null = null;
  if (ql.includes("this month")) monthKey = thisMonth;
  else if (ql.includes("last month")) monthKey = shiftMonthKey(thisMonth, -1);
  else {
    const idx = MONTH_FULL.findIndex((m, i) => ql.includes(m) || wordIn(ql, MONTH_NAMES[i].toLowerCase()));
    if (idx >= 0) {
      if (explicitYear) {
        monthKey = `${explicitYear}-${String(idx + 1).padStart(2, "0")}`;
      } else {
        const key = `${year}-${String(idx + 1).padStart(2, "0")}`;
        // months in the future refer to last year (no explicit year given)
        monthKey = key <= thisMonth ? key : `${year - 1}-${String(idx + 1).padStart(2, "0")}`;
      }
    } else if (explicitYear) {
      yearKey = String(explicitYear);
    }
  }

  // type
  const type: "EXPENSE" | "INCOME" = INCOME_WORDS.some((w) => ql.includes(w)) ? "INCOME" : "EXPENSE";

  // category (skip Misc/Other so "misc" noise doesn't over-match)
  const category =
    ctx.categories.find(
      (c) => !["misc", "other"].includes(c.name.toLowerCase()) && c.kind === type && wordIn(ql, c.name.toLowerCase())
    )?.name ?? null;

  // merchant: any word (>2 chars) of a known merchant appearing in the query
  const merchant =
    ctx.merchants.find((m) =>
      m
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .some((w) => w.length > 2 && wordIn(ql, w))
    ) ?? null;

  // account by name word (>3 chars), or account type keywords
  let accountId: string | null = null;
  let accountType: string | null = null;
  const acc = ctx.accounts.find((a) =>
    a.name
      .toLowerCase()
      .split(/\s+/)
      .some((w) => w.length > 3 && wordIn(ql, w))
  );
  if (acc) accountId = acc.id;
  else if (/\bupi\b|\bwallet\b/.test(ql)) accountType = "WALLET";
  else if (/\bcredit card\b|\bcard\b/.test(ql)) accountType = "CREDIT_CARD";
  else if (/\bcash\b/.test(ql)) accountType = "CASH";

  // amount ranges: "above ₹500", "over 1000", "under ₹2,000", "below 300"
  let minPaise: number | null = null;
  let maxPaise: number | null = null;
  const above = ql.match(/(?:above|over|more than|>)\s*₹?\s*([\d,]+)/);
  const below = ql.match(/(?:under|below|less than|<)\s*₹?\s*([\d,]+)/);
  if (above) minPaise = Number(above[1].replace(/,/g, "")) * 100;
  if (below) maxPaise = Number(below[1].replace(/,/g, "")) * 100;

  const matched = !!(
    monthKey || yearKey || category || merchant || accountId || accountType || minPaise !== null || maxPaise !== null || type === "INCOME"
  );

  return { type, monthKey, yearKey, yearIsExplicit: !!explicitYear, merchant, category, accountId, accountType, minPaise, maxPaise, matched };
}

/** Human answer prefix, e.g. "You spent ₹1,240 on Swiggy in March · 3 transactions". */
export function describeQuery(p: ParsedQuery, totalF: string, count: number): string {
  const bits: string[] = [];
  if (p.merchant) bits.push(`on ${p.merchant}`);
  else if (p.category) bits.push(`on ${p.category}`);
  if (p.accountType === "WALLET") bits.push("via UPI");
  else if (p.accountType) bits.push(`via ${p.accountType.toLowerCase().replace("_", " ")}`);
  const monthFull = p.monthKey ? MONTH_FULL[Number(p.monthKey.slice(5)) - 1] : "";
  const yearSuffix = p.monthKey && p.yearIsExplicit ? ` ${p.monthKey.slice(0, 4)}` : "";
  const when = p.monthKey ? `in ${monthFull[0].toUpperCase()}${monthFull.slice(1)}${yearSuffix}` : p.yearKey ? `in ${p.yearKey}` : "overall";
  const verb = p.type === "INCOME" ? "You received" : "You spent";
  return `${verb} ${totalF}${bits.length ? " " + bits.join(" ") : ""} ${when} · ${count} transaction${count === 1 ? "" : "s"}`;
}

function wordIn(haystack: string, word: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${escapeRe(word)}(?:$|[^a-z0-9])`).test(haystack);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
