// Read-side of the ledger: one shape (LedgerRow) feeding dashboard, analytics,
// search and the transaction list. Dashboard/analytics load a bounded recent
// window and aggregate in process — fine at personal scale. The transaction
// list and search push filtering to Postgres instead (queryTransactions /
// search.ts), since "load everything, filter in JS" gets slower with every
// imported row.

import type { Prisma } from "@prisma/client";
import { MISC_META, TRANSFER_META } from "@/lib/categories";
import { monthRange, shiftMonthKey, toYMD } from "@/lib/dates";
import { parsePeriod } from "@/lib/period";
import { prisma } from "../db";

export interface LedgerRow {
  id: string;
  type: "EXPENSE" | "INCOME" | "TRANSFER";
  amount: number; // paise
  accountId: string | null;
  accountName: string | null;
  accountType: string | null;
  toAccountId: string | null;
  toAccountName: string | null;
  categoryId: string | null;
  category: string | null;
  icon: string;
  color: string;
  merchant: string;
  ymd: string;
  notes: string | null;
  isRecurring: boolean;
  hasReceipt: boolean;
  /** null when personal; else split info */
  split: {
    paidByMe: boolean;
    payerName: string | null; // null when paid by me
    partCount: number;
    myShare: number; // paise
  } | null;
  /** what this row contributes to "my spend": my share when split, full amount otherwise */
  myExpense: number;
}

const TX_INCLUDE = {
  account: { select: { name: true, type: true } },
  toAccount: { select: { name: true } },
  category: { select: { name: true, icon: true, color: true } },
  splits: { select: { participantId: true, owedAmount: true } },
  paidBy: { select: { displayName: true } },
  receipts: { select: { id: true }, take: 1 },
} satisfies Prisma.TransactionInclude;

type RawTx = Prisma.TransactionGetPayload<{ include: typeof TX_INCLUDE }>;

function mapRow(t: RawTx): LedgerRow {
  const amount = Number(t.amount);
  let split: LedgerRow["split"] = null;
  if (t.splits.length > 0) {
    const mine = t.splits.find((s) => s.participantId === null);
    split = {
      paidByMe: t.paidByParticipantId === null,
      payerName: t.paidBy?.displayName ?? null,
      partCount: t.splits.length,
      myShare: mine ? Number(mine.owedAmount) : 0,
    };
  }
  const isTransfer = t.type === "TRANSFER";
  const meta = isTransfer ? TRANSFER_META : { icon: t.category?.icon ?? MISC_META.icon, color: t.category?.color ?? MISC_META.color };
  return {
    id: t.id,
    type: t.type,
    amount,
    accountId: t.accountId,
    accountName: t.account?.name ?? null,
    accountType: t.account?.type ?? null,
    toAccountId: t.toAccountId,
    toAccountName: t.toAccount?.name ?? null,
    categoryId: t.categoryId,
    category: t.category?.name ?? null,
    icon: meta.icon,
    color: meta.color,
    merchant: t.merchant,
    ymd: toYMD(t.occurredAt),
    notes: t.notes,
    isRecurring: t.isRecurring,
    hasReceipt: t.receipts.length > 0,
    split,
    myExpense: t.type !== "EXPENSE" ? 0 : split ? split.myShare : amount,
  };
}

/**
 * monthsBack limits the window for recent-focused views (dashboard, analytics
 * trend charts). Pass null for the full ledger. Prefer queryTransactions for
 * the transaction list / search — this unbounded form loads every row into
 * memory, which is only appropriate for small, bounded windows.
 */
export async function loadLedger(userId: string, monthsBack: number | null = 6, now = new Date()): Promise<LedgerRow[]> {
  const start = monthsBack === null ? undefined : monthRange(shiftMonthKey(toYMD(now).slice(0, 7), -(monthsBack - 1))).start;

  const rows = await prisma.transaction.findMany({
    where: { userId, deletedAt: null, ...(start ? { occurredAt: { gte: start } } : {}) },
    include: TX_INCLUDE,
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
  });
  return rows.map(mapRow);
}

/** Fields needed for chart/total aggregation — everything monthAgg/categoryTotals/merchantTotals/weekBars/dayBars/per-account net read. */
export interface AggRow {
  id: string;
  type: "EXPENSE" | "INCOME" | "TRANSFER";
  amount: number;
  merchant: string;
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  category: string | null;
  icon: string;
  color: string;
  ymd: string;
  myExpense: number;
}

const TX_AGG_SELECT = {
  id: true,
  occurredAt: true,
  type: true,
  amount: true,
  merchant: true,
  accountId: true,
  toAccountId: true,
  categoryId: true,
  category: { select: { name: true, icon: true, color: true } },
  splits: { select: { participantId: true, owedAmount: true } },
} satisfies Prisma.TransactionSelect;

type RawAggTx = Prisma.TransactionGetPayload<{ select: typeof TX_AGG_SELECT }>;

function mapAggRow(t: RawAggTx): AggRow {
  const amount = Number(t.amount);
  const mine = t.splits.find((s) => s.participantId === null);
  const myShare = mine ? Number(mine.owedAmount) : amount;
  return {
    id: t.id,
    type: t.type,
    amount,
    merchant: t.merchant,
    accountId: t.accountId,
    toAccountId: t.toAccountId,
    categoryId: t.categoryId,
    category: t.category?.name ?? null,
    icon: t.category?.icon ?? MISC_META.icon,
    color: t.category?.color ?? MISC_META.color,
    ymd: toYMD(t.occurredAt),
    myExpense: t.type !== "EXPENSE" ? 0 : t.splits.length > 0 ? myShare : amount,
  };
}

/**
 * Aggregation-only load: skips the account/toAccount/paidBy/receipts joins
 * that loadLedger pulls in for display purposes but charts and totals never
 * read. Dashboard and analytics only need this shape — use loadLedger (or
 * recentTransactions) only where the fuller display fields are actually shown.
 */
export async function loadLedgerAgg(userId: string, monthsBack: number | null = 6, now = new Date()): Promise<AggRow[]> {
  const start = monthsBack === null ? undefined : monthRange(shiftMonthKey(toYMD(now).slice(0, 7), -(monthsBack - 1))).start;

  const rows = await prisma.transaction.findMany({
    where: { userId, deletedAt: null, ...(start ? { occurredAt: { gte: start } } : {}) },
    select: TX_AGG_SELECT,
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
  });
  return rows.map(mapAggRow);
}

/** loadLedgerAgg for an explicit [start, end) window instead of a months-back one — for period-filtered views. */
export async function loadLedgerAggRange(userId: string, start?: Date, end?: Date): Promise<AggRow[]> {
  const occurredAt = start || end ? { ...(start ? { gte: start } : {}), ...(end ? { lt: end } : {}) } : undefined;
  const rows = await prisma.transaction.findMany({
    where: { userId, deletedAt: null, ...(occurredAt ? { occurredAt } : {}) },
    select: TX_AGG_SELECT,
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
  });
  return rows.map(mapAggRow);
}

/**
 * Cash-movement totals for a window, as two DB aggregates — no rows loaded.
 * "Cash" semantics match applyBalances: income counts in full, expenses count
 * in full but only when you actually paid (rows paid by a friend never moved
 * your money — you settle those later). Transfers between your own accounts
 * net to zero and are excluded. With unassignedOnly, restricts to rows not
 * posted to any account (imported history without account info), whose cash
 * effect exists in the ledger but not in any account's balance.
 */
export async function cashTotals(
  userId: string,
  opts: { start?: Date; end?: Date; unassignedOnly?: boolean } = {}
): Promise<{ income: number; expense: number }> {
  const occurredAt =
    opts.start || opts.end ? { ...(opts.start ? { gte: opts.start } : {}), ...(opts.end ? { lt: opts.end } : {}) } : undefined;
  const base: Prisma.TransactionWhereInput = {
    userId,
    deletedAt: null,
    ...(occurredAt ? { occurredAt } : {}),
    ...(opts.unassignedOnly ? { accountId: null } : {}),
  };
  const [inc, exp] = await Promise.all([
    prisma.transaction.aggregate({ _sum: { amount: true }, where: { ...base, type: "INCOME" } }),
    prisma.transaction.aggregate({ _sum: { amount: true }, where: { ...base, type: "EXPENSE", paidByParticipantId: null } }),
  ]);
  return { income: Number(inc._sum.amount ?? 0), expense: Number(exp._sum.amount ?? 0) };
}

/** The last N transactions with full display fields — for "recent transactions" widgets that only ever show a handful. */
export async function recentTransactions(userId: string, limit: number): Promise<LedgerRow[]> {
  const rows = await prisma.transaction.findMany({
    where: { userId, deletedAt: null },
    include: TX_INCLUDE,
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    take: limit,
  });
  return rows.map(mapRow);
}

export interface TxListFilter {
  type?: "EXPENSE" | "INCOME" | "TRANSFER";
  /** legacy single-month filter from NL search ("swiggy in march") — a deliberate one-off query, takes precedence over the shared period below */
  monthKey?: string | null;
  categoryId?: string | null;
  /** Either side of a transfer counts. Used by the Accounts page, including the
   * archived list, where it's the only way back to an account's history. */
  accountId?: string | null;
  /** the shared period picker's raw ?p/?from/?to — resolved with parsePeriod, same as every other period-aware page */
  period?: { p?: string; from?: string; to?: string };
  textQuery?: string;
  /** activity timeline's import tap-through: only rows from this import batch */
  importBatchId?: string | null;
}

export interface TxPage {
  rows: LedgerRow[];
  hasMore: boolean;
}

const PAGE_SIZE = 50;

/** Paginated, DB-filtered transaction list — the "see everything" screen without loading everything at once. */
export async function queryTransactions(userId: string, filter: TxListFilter, page: number): Promise<TxPage> {
  const where: Prisma.TransactionWhereInput = { userId, deletedAt: null };
  if (filter.type) where.type = filter.type;
  if (filter.categoryId) where.categoryId = filter.categoryId;
  if (filter.importBatchId) where.importBatchId = filter.importBatchId;
  if (filter.accountId) {
    // Both sides of a transfer count as "this account's" activity. Nested under
    // AND rather than assigning where.OR, which the text search below already
    // owns — the two filters have to compose, not overwrite each other.
    where.AND = [{ OR: [{ accountId: filter.accountId }, { toAccountId: filter.accountId }] }];
  }
  if (filter.monthKey) {
    const { start, end } = monthRange(filter.monthKey);
    where.occurredAt = { gte: start, lt: end };
  } else if (filter.period) {
    const { range } = parsePeriod(filter.period);
    if (range.start || range.end) where.occurredAt = { ...(range.start ? { gte: range.start } : {}), ...(range.end ? { lt: range.end } : {}) };
  }
  const q = filter.textQuery?.trim();
  if (q) {
    const amountGuess = Number(q.replace(/[₹,\s]/g, ""));
    where.OR = [
      { merchant: { contains: q, mode: "insensitive" } },
      { notes: { contains: q, mode: "insensitive" } },
      { category: { name: { contains: q, mode: "insensitive" } } },
      { account: { name: { contains: q, mode: "insensitive" } } },
      ...(Number.isFinite(amountGuess) && amountGuess > 0 ? [{ amount: BigInt(Math.round(amountGuess * 100)) }] : []),
    ];
  }

  const rows = await prisma.transaction.findMany({
    where,
    include: TX_INCLUDE,
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    skip: page * PAGE_SIZE,
    take: PAGE_SIZE + 1, // one extra row reveals whether another page exists
  });
  const hasMore = rows.length > PAGE_SIZE;
  return { rows: rows.slice(0, PAGE_SIZE).map(mapRow), hasMore };
}

type Aggregatable = Pick<LedgerRow, "ymd" | "type" | "amount" | "myExpense" | "categoryId" | "category" | "icon" | "color" | "merchant">;

export function monthAgg(rows: Aggregatable[], key: string): { income: number; expense: number } {
  let income = 0;
  let expense = 0;
  for (const r of rows) {
    if (!r.ymd.startsWith(key)) continue;
    if (r.type === "INCOME") income += r.amount;
    else if (r.type === "EXPENSE") expense += r.myExpense;
  }
  return { income, expense };
}

export function categoryTotals(
  rows: Aggregatable[],
  key: string,
  type: "EXPENSE" | "INCOME" = "EXPENSE"
): { id: string | null; name: string; icon: string; color: string; total: number }[] {
  const map = new Map<string, { id: string | null; name: string; icon: string; color: string; total: number }>();
  for (const r of rows) {
    if (r.type !== type || !r.ymd.startsWith(key)) continue;
    const amt = type === "EXPENSE" ? r.myExpense : r.amount;
    if (amt <= 0) continue;
    const name = r.category ?? "Misc";
    const cur = map.get(name) ?? { id: r.categoryId, name, icon: r.icon, color: r.color, total: 0 };
    cur.total += amt;
    map.set(name, cur);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

export function merchantTotals(rows: Aggregatable[], key: string): { name: string; total: number; count: number }[] {
  const map = new Map<string, { name: string; total: number; count: number }>();
  for (const r of rows) {
    if (r.type !== "EXPENSE" || !r.ymd.startsWith(key) || r.myExpense <= 0) continue;
    const cur = map.get(r.merchant) ?? { name: r.merchant, total: 0, count: 0 };
    cur.total += r.myExpense;
    cur.count += 1;
    map.set(r.merchant, cur);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}
