// Recurring engine (Architecture doc §5): the daily cron reads rules with
// nextRunAt ≤ now, materializes the templated transaction/bill inside a DB
// transaction, and advances nextRunAt — re-runs are no-ops because the advance
// happens atomically with the materialization.

import { advance, istNoon, toYMD } from "@/lib/dates";
import { prisma } from "../db";
import { applyBalances } from "./transactions";

export async function materializeDueRules(now = new Date()): Promise<number> {
  const due = await prisma.recurringRule.findMany({
    where: { nextRunAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
  });

  let created = 0;
  for (const rule of due) {
    await prisma.$transaction(async (db) => {
      // reload inside the tx so concurrent runs can't double-create
      const fresh = await db.recurringRule.findUnique({ where: { id: rule.id } });
      if (!fresh || fresh.nextRunAt > now) return;

      const tpl = fresh.template as Record<string, unknown>;
      const runYMD = toYMD(fresh.nextRunAt);
      if (fresh.kind === "TRANSACTION") {
        const t = await db.transaction.create({
          data: {
            userId: fresh.userId,
            type: (tpl.type as "EXPENSE" | "INCOME") ?? "EXPENSE",
            amount: Math.round(Number(tpl.amount)),
            accountId: (tpl.accountId as string) ?? null,
            categoryId: (tpl.categoryId as string) ?? null,
            merchant: (tpl.merchant as string) ?? "Recurring",
            occurredAt: istNoon(runYMD),
            isRecurring: true,
            recurringRuleId: fresh.id,
          },
        });
        await applyBalances(db, t, 1);
        await db.notification.create({
          data: {
            userId: fresh.userId,
            kind: "RECURRING_CREATED",
            dedupeKey: `recurring:${fresh.id}:${runYMD}`,
            payload: { txId: t.id, merchant: t.merchant, amount: Number(t.amount) },
          },
        });
      } else {
        await db.bill.create({
          data: {
            userId: fresh.userId,
            name: (tpl.name as string) ?? "Bill",
            amount: Math.round(Number(tpl.amount)),
            categoryId: (tpl.categoryId as string) ?? null,
            dueDate: istNoon(runYMD),
            recurringRuleId: fresh.id,
          },
        });
      }

      await db.recurringRule.update({
        where: { id: fresh.id },
        data: { nextRunAt: istNoon(advance(runYMD, fresh.cadence, fresh.interval)) },
      });
      created++;
    });
  }
  return created;
}
