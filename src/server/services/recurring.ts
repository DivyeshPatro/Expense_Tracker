// Recurring engine (Architecture doc §5): the daily cron reads rules with
// nextRunAt ≤ now, materializes the templated transaction/bill inside a DB
// transaction, and advances nextRunAt — re-runs are no-ops because the advance
// happens atomically with the materialization.

import { advance, istNoon, toYMD } from "@/lib/dates";
import { prisma } from "../db";
import { applyBalances } from "./transactions";

/**
 * Occurrences a single rule may materialize in one cron run.
 *
 * Each run used to produce exactly one occurrence per rule, so a schedule that
 * fell behind caught up at one step per day: a DAILY rule missed over a 5-day
 * outage needed 5 more days to come right, and a rule whose start date was
 * backdated never caught up at all. The loop below closes the gap in one run
 * instead — bounded, so a rule accidentally dated years in the past can't try to
 * write thousands of rows in a single job. Whatever is left over is picked up by
 * the next run.
 */
const MAX_CATCHUP_PER_RUN = 60;

export interface RuleFailure {
  ruleId: string;
  message: string;
}

export interface MaterializeResult {
  created: number;
  failures: RuleFailure[];
}

/**
 * Materialize one due occurrence of a rule. Returns false when there was
 * nothing to do, which is what ends the catch-up loop.
 *
 * The reload-inside-the-transaction and the nextRunAt advance are what make
 * this idempotent: two concurrent runs can't both materialize the same
 * occurrence, because whichever commits first moves nextRunAt past it.
 */
async function materializeOnce(ruleId: string, now: Date): Promise<boolean> {
  return prisma.$transaction(async (db) => {
    const fresh = await db.recurringRule.findUnique({ where: { id: ruleId } });
    if (!fresh || fresh.nextRunAt > now) return false;
    // An occurrence scheduled past the rule's end date is not due — it never
    // happens at all. (The outer query only knows the rule hasn't ended yet.)
    if (fresh.endsAt && fresh.nextRunAt > fresh.endsAt) return false;

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
      data: { nextRunAt: istNoon(advance(runYMD, fresh.cadence, fresh.interval, fresh.anchorDay)) },
    });
    return true;
  });
}

export async function materializeDueRules(now = new Date()): Promise<MaterializeResult> {
  // endsAt bounds which OCCURRENCES exist, not which rules are worth looking at
  // — materializeOnce refuses anything scheduled past it. Selecting only rules
  // that haven't ended yet would mean an outage spanning a rule's end date threw
  // away the occurrences that fell due before it, which is exactly the data
  // catch-up exists to recover. A rule that has finished simply no-ops here.
  const due = await prisma.recurringRule.findMany({
    where: { nextRunAt: { lte: now } },
    select: { id: true },
  });

  let created = 0;
  const failures: RuleFailure[] = [];

  for (const rule of due) {
    // One rule must never take the run down with it. A template pointing at a
    // deleted account raises an FK error, and without this the throw escaped the
    // loop: every remaining user's rules were skipped AND the reconciliation
    // that runs after this never happened — silently, every night, until someone
    // noticed the missing transactions. Record it and keep going.
    try {
      for (let i = 0; i < MAX_CATCHUP_PER_RUN; i++) {
        if (!(await materializeOnce(rule.id, now))) break;
        created++;
      }
    } catch (e) {
      failures.push({ ruleId: rule.id, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return { created, failures };
}
