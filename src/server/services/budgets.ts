// Budgets with 80%/100% thresholds. Crossing a threshold creates a notification
// exactly once per budget per period (PRD §4.4 AC) via the dedupeKey unique index.

import { currentMonthKey } from "@/lib/dates";
import { prisma } from "../db";
import { audit } from "./audit";
import { loadLedgerAgg, categoryTotals, type AggRow } from "./ledger";

export interface BudgetView {
  id: string;
  categoryId: string | null;
  category: string; // "Overall" for null
  icon: string;
  color: string;
  limit: number; // paise
  spent: number; // paise, current month
  pct: number; // 0..∞ (100 = at limit)
  over: boolean;
  warn: boolean; // ≥ alertAt%, not over
  alertAt: number;
}

/**
 * precomputedRows lets a caller that already fetched (or is already fetching, as
 * a promise) a wider aggregation window this request — e.g. Dashboard's 6-month
 * loadLedgerAgg, which always covers the current month — hand those rows in
 * instead of triggering a second, narrower Transaction scan. categoryTotals()
 * filters to the current month regardless of how wide the input window is, so
 * the result is identical either way. Passing the in-flight promise (rather
 * than an already-awaited array) keeps this call's own budget.findMany firing
 * immediately in parallel, same as before.
 */
export async function listBudgets(
  userId: string,
  now = new Date(),
  precomputedRows?: AggRow[] | Promise<AggRow[]>
): Promise<BudgetView[]> {
  const key = currentMonthKey(now);
  const [budgets, rows] = await Promise.all([
    prisma.budget.findMany({ where: { userId }, include: { category: true }, orderBy: { limit: "desc" } }),
    precomputedRows ?? loadLedgerAgg(userId, 1, now),
  ]);
  const totals = categoryTotals(rows, key);
  const byCat = new Map(totals.map((t) => [t.name, t.total]));
  const overallSpent = totals.reduce((s, t) => s + t.total, 0);

  return budgets.map((b) => {
    const limit = Number(b.limit);
    const spent = b.categoryId ? (byCat.get(b.category!.name) ?? 0) : overallSpent;
    const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;
    return {
      id: b.id,
      categoryId: b.categoryId,
      category: b.category?.name ?? "Overall",
      icon: b.category?.icon ?? "◔",
      color: b.category?.color ?? "#2a63f6",
      limit,
      spent,
      pct,
      over: spent > limit,
      warn: pct >= b.alertAt && spent <= limit,
      alertAt: b.alertAt,
    };
  });
}

export async function upsertBudget(userId: string, categoryId: string | null, limit: number) {
  const existing = await prisma.budget.findFirst({ where: { userId, categoryId, accountId: null, period: "MONTHLY" } });
  await prisma.$transaction(async (db) => {
    if (existing) {
      const updated = await db.budget.update({ where: { id: existing.id }, data: { limit } });
      await audit(db, userId, "update", "Budget", existing.id, existing, updated);
    } else {
      const b = await db.budget.create({ data: { userId, categoryId, period: "MONTHLY", limit } });
      await audit(db, userId, "create", "Budget", b.id, undefined, b);
    }
  });
}

/** Called after every expense write for the affected category. */
export async function checkBudgetThresholds(userId: string, categoryId: string, now = new Date()) {
  const key = currentMonthKey(now);
  const views = await listBudgets(userId, now);
  const hit = views.filter((v) => (v.categoryId === categoryId || v.categoryId === null) && (v.over || v.warn));
  for (const v of hit) {
    const level = v.over ? 100 : v.alertAt;
    const kind = v.over ? "BUDGET_EXCEEDED" : "BUDGET_WARNING";
    try {
      await prisma.notification.create({
        data: {
          userId,
          kind,
          dedupeKey: `budget:${v.id}:${key}:${level}`,
          payload: { budgetId: v.id, category: v.category, spent: v.spent, limit: v.limit, monthKey: key },
        },
      });
    } catch {
      // unique(dedupeKey) violation ⇒ already notified this period — exactly-once by design
    }
  }
}
