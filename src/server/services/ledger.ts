// Read-side of the ledger: one query feeding dashboard, analytics, search and
// the transaction list. At personal scale (a few thousand rows) aggregating in
// process is simpler and fast; swap for the month×category rollup view when needed.

import { MISC_META, TRANSFER_META } from "@/lib/categories";
import { monthRange, shiftMonthKey, toYMD } from "@/lib/dates";
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

export async function loadLedger(userId: string, monthsBack = 6, now = new Date()): Promise<LedgerRow[]> {
  const startKey = shiftMonthKey(toYMD(now).slice(0, 7), -(monthsBack - 1));
  const { start } = monthRange(startKey);

  const rows = await prisma.transaction.findMany({
    where: { userId, deletedAt: null, occurredAt: { gte: start } },
    include: {
      account: { select: { name: true, type: true } },
      toAccount: { select: { name: true } },
      category: { select: { name: true, icon: true, color: true } },
      splits: { select: { participantId: true, owedAmount: true } },
      paidBy: { select: { displayName: true } },
      receipts: { select: { id: true }, take: 1 },
    },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
  });

  return rows.map((t) => {
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
  });
}

export function monthAgg(rows: LedgerRow[], key: string): { income: number; expense: number } {
  let income = 0;
  let expense = 0;
  for (const r of rows) {
    if (!r.ymd.startsWith(key)) continue;
    if (r.type === "INCOME") income += r.amount;
    else if (r.type === "EXPENSE") expense += r.myExpense;
  }
  return { income, expense };
}

export function categoryTotals(rows: LedgerRow[], key: string): { name: string; icon: string; color: string; total: number }[] {
  const map = new Map<string, { name: string; icon: string; color: string; total: number }>();
  for (const r of rows) {
    if (r.type !== "EXPENSE" || !r.ymd.startsWith(key) || r.myExpense <= 0) continue;
    const name = r.category ?? "Misc";
    const cur = map.get(name) ?? { name, icon: r.icon, color: r.color, total: 0 };
    cur.total += r.myExpense;
    map.set(name, cur);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

export function merchantTotals(rows: LedgerRow[], key: string): { name: string; total: number; count: number }[] {
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
