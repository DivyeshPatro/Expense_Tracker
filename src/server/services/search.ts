// "Ask Ledgerly": run the deterministic parser over the user's own data and
// answer inline with total + count (PRD §4.7). Unmatched queries return null
// so the palette falls back to plain text search — never an error state.
//
// Performance note: this pushes date/merchant/category/account/amount filters
// into the DB query (via a Prisma `where`) rather than loading the whole
// ledger into JS and filtering there — the latter gets slower with every
// imported transaction. Only the (much smaller) matching subset is pulled
// back for split-aware total computation.

import type { AccountType, Prisma } from "@prisma/client";
import { istMidnight, monthRange } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { describeQuery, parseQuery } from "@/lib/search-parser";
import { prisma } from "../db";

export interface NLAnswer {
  answer: string;
  /** filter to hand to the transactions screen */
  filter: { q: string; tab: "EXPENSE" | "INCOME"; monthKey: string | null };
}

/** On-demand merchant suggestions for the ⌘K palette — indexed ILIKE query, not a full-table scan. */
export async function searchMerchants(userId: string, query: string): Promise<string[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const rows = await prisma.transaction.findMany({
    where: { userId, deletedAt: null, merchant: { contains: q, mode: "insensitive" } },
    select: { merchant: true },
    distinct: ["merchant"],
    take: 5,
    orderBy: { occurredAt: "desc" },
  });
  return rows.map((r) => r.merchant);
}

export async function askLedgerly(userId: string, query: string, now = new Date()): Promise<NLAnswer | null> {
  if (!query.trim()) return null;
  const [categories, accounts, merchantRows] = await Promise.all([
    prisma.category.findMany({ where: { userId }, select: { name: true, kind: true } }),
    prisma.account.findMany({ where: { userId }, select: { id: true, name: true, type: true } }),
    // distinct merchant *names* only — far cheaper than loading full rows,
    // and this is the one place the parser genuinely needs the whole list
    // (to recognize a merchant mentioned anywhere in free text).
    prisma.transaction.findMany({ where: { userId, deletedAt: null }, select: { merchant: true }, distinct: ["merchant"] }),
  ]);
  const parsed = parseQuery(query, {
    merchants: merchantRows.map((r) => r.merchant),
    categories: categories.filter((c) => c.kind !== "TRANSFER") as { name: string; kind: "EXPENSE" | "INCOME" }[],
    accounts,
    now,
  });
  if (!parsed.matched) return null;

  const where: Prisma.TransactionWhereInput = { userId, deletedAt: null, type: parsed.type };
  if (parsed.monthKey) {
    const { start, end } = monthRange(parsed.monthKey);
    where.occurredAt = { gte: start, lt: end };
  } else if (parsed.yearKey) {
    where.occurredAt = { gte: istMidnight(`${parsed.yearKey}-01-01`), lt: istMidnight(`${Number(parsed.yearKey) + 1}-01-01`) };
  }
  if (parsed.merchant) where.merchant = parsed.merchant;
  else if (parsed.category) where.category = { name: parsed.category };
  if (parsed.accountId) where.accountId = parsed.accountId;
  else if (parsed.accountType) where.account = { type: parsed.accountType as AccountType };
  if (parsed.minPaise !== null || parsed.maxPaise !== null) {
    // filters on the transaction's full amount; for the (rare, non-import) split
    // case this is an approximation of the user's exact share — an accepted
    // trade-off for not having to load every matching row's splits up front.
    where.amount = {
      ...(parsed.minPaise !== null ? { gte: parsed.minPaise } : {}),
      ...(parsed.maxPaise !== null ? { lte: parsed.maxPaise } : {}),
    };
  }

  const rows = await prisma.transaction.findMany({
    where,
    select: { amount: true, splits: { select: { participantId: true, owedAmount: true } } },
  });
  const total = rows.reduce((sum, r) => {
    if (parsed.type === "INCOME") return sum + Number(r.amount);
    const mine = r.splits.find((s) => s.participantId === null);
    return sum + (mine ? Number(mine.owedAmount) : Number(r.amount));
  }, 0);

  return {
    answer: describeQuery(parsed, formatPaise(total), rows.length),
    filter: { q: parsed.merchant ?? parsed.category ?? "", tab: parsed.type, monthKey: parsed.monthKey },
  };
}
