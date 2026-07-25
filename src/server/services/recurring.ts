// Recurring engine (Architecture doc §5): the daily cron reads rules with
// nextRunAt ≤ now, materializes the templated transaction/bill inside a DB
// transaction, and advances nextRunAt — re-runs are no-ops because the advance
// happens atomically with the materialization.

import type { Prisma } from "@prisma/client";
import { advance, istNoon, todayYMD, toYMD } from "@/lib/dates";
import { prisma } from "../db";
import { audit } from "./audit";
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
    // Paused rules hold their position: nextRunAt is deliberately not advanced,
    // so nothing accumulates. resumeRule() decides where to restart from.
    if (fresh.isPaused) return false;
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

// ── Rule management ──────────────────────────────────────────────────────────
// Scope is deliberately TRANSACTION rules only. The engine still materializes
// RuleKind.BILL, but bills already recur through Bill.cadence (which rolls the
// due date forward on payment) and exposing a second, parallel mechanism would
// leave users with two different answers to "make this bill repeat".

export interface RecurringTemplate {
  type: "EXPENSE" | "INCOME";
  amount: number; // paise
  accountId: string | null;
  categoryId: string | null;
  merchant: string;
}

export interface RecurringRuleView {
  id: string;
  cadence: "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";
  interval: number;
  nextRunYmd: string;
  endsYmd: string | null;
  isPaused: boolean;
  anchorDay: number | null;
  template: RecurringTemplate;
  accountName: string | null;
  categoryName: string | null;
  /** Occurrences already materialized from this rule (soft-deleted excluded). */
  materializedCount: number;
}

export interface RuleInput {
  type: "EXPENSE" | "INCOME";
  amountPaise: number;
  accountId: string | null;
  categoryId: string | null;
  merchant: string;
  cadence: "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";
  interval: number;
  startYmd: string;
  endYmd: string | null;
}

/** Month-based cadences pin to the start date's day; day-based ones don't need it. */
function anchorFor(cadence: RuleInput["cadence"], startYmd: string): number | null {
  if (cadence === "DAILY" || cadence === "WEEKLY") return null;
  return Number(startYmd.slice(8, 10));
}

function toTemplate(input: RuleInput): RecurringTemplate {
  return {
    type: input.type,
    amount: input.amountPaise,
    accountId: input.accountId,
    categoryId: input.categoryId,
    merchant: input.merchant,
  };
}

/**
 * Referenced account/category must belong to this user. Without this check a
 * crafted id would be written into the template and then fail — unattended, in
 * the middle of the night, inside the cron — rather than at the boundary where
 * someone can see the error.
 */
async function assertOwnedRefs(userId: string, accountId: string | null, categoryId: string | null) {
  if (accountId) {
    const owned = await prisma.account.count({ where: { id: accountId, userId } });
    if (!owned) throw new Error("That account doesn't exist");
  }
  if (categoryId) {
    const owned = await prisma.category.count({ where: { id: categoryId, userId } });
    if (!owned) throw new Error("That category doesn't exist");
  }
}

export async function listRecurringRules(userId: string): Promise<RecurringRuleView[]> {
  const rules = await prisma.recurringRule.findMany({
    where: { userId, kind: "TRANSACTION" },
    orderBy: { nextRunAt: "asc" },
  });
  if (rules.length === 0) return [];

  // Resolve display names in two queries rather than per rule.
  const [accounts, categories, counts] = await Promise.all([
    prisma.account.findMany({ where: { userId }, select: { id: true, name: true } }),
    prisma.category.findMany({ where: { userId }, select: { id: true, name: true } }),
    prisma.transaction.groupBy({
      by: ["recurringRuleId"],
      where: { userId, deletedAt: null, recurringRuleId: { in: rules.map((r) => r.id) } },
      _count: { _all: true },
    }),
  ]);
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const countByRule = new Map(counts.map((c) => [c.recurringRuleId, c._count._all]));

  return rules.map((r) => {
    const t = (r.template ?? {}) as Partial<RecurringTemplate>;
    return {
      id: r.id,
      cadence: r.cadence,
      interval: r.interval,
      nextRunYmd: toYMD(r.nextRunAt),
      endsYmd: r.endsAt ? toYMD(r.endsAt) : null,
      isPaused: r.isPaused,
      anchorDay: r.anchorDay,
      template: {
        type: t.type === "INCOME" ? "INCOME" : "EXPENSE",
        amount: Number(t.amount ?? 0),
        accountId: t.accountId ?? null,
        categoryId: t.categoryId ?? null,
        merchant: t.merchant ?? "Recurring",
      },
      accountName: t.accountId ? accountName.get(t.accountId) ?? null : null,
      categoryName: t.categoryId ? categoryName.get(t.categoryId) ?? null : null,
      materializedCount: countByRule.get(r.id) ?? 0,
    };
  });
}

export async function createRecurringRule(userId: string, input: RuleInput): Promise<string> {
  await assertOwnedRefs(userId, input.accountId, input.categoryId);
  const rule = await prisma.recurringRule.create({
    data: {
      userId,
      kind: "TRANSACTION",
      cadence: input.cadence,
      interval: input.interval,
      nextRunAt: istNoon(input.startYmd),
      endsAt: input.endYmd ? istNoon(input.endYmd) : null,
      anchorDay: anchorFor(input.cadence, input.startYmd),
      template: toTemplate(input) as unknown as Prisma.InputJsonValue,
    },
  });
  await audit(prisma, userId, "create", "RecurringRule", rule.id, undefined, rule);
  return rule.id;
}

/**
 * Edits apply to FUTURE occurrences only — transactions already materialized are
 * real money that happened and are never rewritten. Changing the start date
 * reschedules the next run; it does not retroactively move past occurrences.
 */
export async function updateRecurringRule(userId: string, ruleId: string, input: RuleInput): Promise<void> {
  const before = await prisma.recurringRule.findFirst({ where: { id: ruleId, userId, kind: "TRANSACTION" } });
  if (!before) throw new Error("Recurring rule not found");
  await assertOwnedRefs(userId, input.accountId, input.categoryId);
  const after = await prisma.recurringRule.update({
    where: { id: ruleId },
    data: {
      cadence: input.cadence,
      interval: input.interval,
      nextRunAt: istNoon(input.startYmd),
      endsAt: input.endYmd ? istNoon(input.endYmd) : null,
      anchorDay: anchorFor(input.cadence, input.startYmd),
      template: toTemplate(input) as unknown as Prisma.InputJsonValue,
    },
  });
  await audit(prisma, userId, "update", "RecurringRule", ruleId, before, after);
}

/**
 * Deletes the rule only. Transactions it already created stay — they record
 * money that actually moved, and deleting a schedule is not a statement about
 * history. Their recurringRuleId is left pointing at the removed rule (there is
 * no FK, so nothing breaks); anything reading it must tolerate a missing rule.
 */
export async function deleteRecurringRule(userId: string, ruleId: string): Promise<void> {
  const before = await prisma.recurringRule.findFirst({ where: { id: ruleId, userId, kind: "TRANSACTION" } });
  if (!before) throw new Error("Recurring rule not found");
  await prisma.recurringRule.delete({ where: { id: ruleId } });
  await audit(prisma, userId, "delete", "RecurringRule", ruleId, before, undefined);
}

/**
 * Pausing freezes the schedule where it stands. Resuming rolls nextRunAt forward
 * to the next occurrence that is still in the future, so a rule paused for three
 * months doesn't dump three months of transactions the moment it comes back —
 * "paused" means those occurrences didn't happen, not that they're owed.
 */
export async function setRecurringRulePaused(userId: string, ruleId: string, paused: boolean): Promise<void> {
  const rule = await prisma.recurringRule.findFirst({ where: { id: ruleId, userId, kind: "TRANSACTION" } });
  if (!rule) throw new Error("Recurring rule not found");

  let nextRunAt = rule.nextRunAt;
  if (!paused) {
    const today = todayYMD();
    let ymd = toYMD(rule.nextRunAt);
    // Pure date arithmetic, so stepping is cheap even across years of pause
    // (a daily rule paused since 2020 is a few thousand iterations, well under a
    // millisecond). The cap is strictly an infinite-loop guard for the case where
    // advance() somehow fails to move forward — not a limit on how long a rule
    // may stay paused. interval >= 1 is enforced by the validator.
    for (let i = 0; i < 10_000 && ymd < today; i++) {
      ymd = advance(ymd, rule.cadence, rule.interval, rule.anchorDay);
    }
    nextRunAt = istNoon(ymd);
  }

  await prisma.recurringRule.update({ where: { id: ruleId }, data: { isPaused: paused, nextRunAt } });
  await audit(prisma, userId, paused ? "pause" : "resume", "RecurringRule", ruleId, { isPaused: rule.isPaused }, { isPaused: paused });
}
