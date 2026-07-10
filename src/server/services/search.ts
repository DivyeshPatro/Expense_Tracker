// "Ask Ledgerly": run the deterministic parser over the user's own data and
// answer inline with total + count (PRD §4.7). Unmatched queries return null
// so the palette falls back to plain text search — never an error state.

import { formatPaise } from "@/lib/money";
import { describeQuery, parseQuery, type ParsedQuery } from "@/lib/search-parser";
import { prisma } from "../db";
import { loadLedger, type LedgerRow } from "./ledger";

export interface NLAnswer {
  answer: string;
  /** filter to hand to the transactions screen */
  filter: { q: string; tab: "EXPENSE" | "INCOME"; monthKey: string | null };
}

export async function askLedgerly(userId: string, query: string, now = new Date()): Promise<NLAnswer | null> {
  if (!query.trim()) return null;
  const [categories, accounts, rows] = await Promise.all([
    prisma.category.findMany({ where: { userId }, select: { name: true, kind: true } }),
    prisma.account.findMany({ where: { userId }, select: { id: true, name: true, type: true } }),
    loadLedger(userId, 12, now),
  ]);
  const merchants = [...new Set(rows.map((r) => r.merchant))];
  const parsed = parseQuery(query, {
    merchants,
    categories: categories.filter((c) => c.kind !== "TRANSFER") as { name: string; kind: "EXPENSE" | "INCOME" }[],
    accounts,
    now,
  });
  if (!parsed.matched) return null;

  const list = rows.filter((r) => matches(r, parsed));
  const total = list.reduce((s, r) => s + (parsed.type === "INCOME" ? r.amount : r.myExpense), 0);
  return {
    answer: describeQuery(parsed, formatPaise(total), list.length),
    filter: { q: parsed.merchant ?? parsed.category ?? "", tab: parsed.type, monthKey: parsed.monthKey },
  };
}

function matches(r: LedgerRow, p: ParsedQuery): boolean {
  if (r.type !== p.type) return false;
  if (p.monthKey && !r.ymd.startsWith(p.monthKey)) return false;
  if (p.merchant) {
    if (r.merchant !== p.merchant) return false;
  } else if (p.category && r.category !== p.category) return false;
  if (p.accountId && r.accountId !== p.accountId) return false;
  if (p.accountType && r.accountType !== p.accountType) return false;
  const val = p.type === "INCOME" ? r.amount : r.myExpense;
  if (p.minPaise !== null && val < p.minPaise) return false;
  if (p.maxPaise !== null && val > p.maxPaise) return false;
  return true;
}
