// Database-backed tests for the recurring engine. Run with
// `npm run test:integration` (needs DATABASE_URL); CI runs these in the job
// with a Postgres service.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { istNoon, todayYMD, toYMD } from "@/lib/dates";
import {
  createRecurringRule,
  deleteRecurringRule,
  listRecurringRules,
  materializeDueRules,
  setRecurringRulePaused,
  updateRecurringRule,
  type RuleInput,
} from "./recurring";
import { prisma } from "../db";

const EMAIL = "recurring-test@ledgerly.app";

let userId: string;
let accountId: string;
let categoryId: string;

async function makeRule(over: Partial<{
  cadence: "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";
  interval: number;
  nextRunAt: Date;
  endsAt: Date | null;
  anchorDay: number | null;
  template: Record<string, unknown>;
  kind: "TRANSACTION" | "BILL";
}> = {}) {
  return prisma.recurringRule.create({
    data: {
      userId,
      kind: over.kind ?? "TRANSACTION",
      cadence: over.cadence ?? "DAILY",
      interval: over.interval ?? 1,
      nextRunAt: over.nextRunAt ?? istNoon("2026-07-01"),
      endsAt: over.endsAt ?? null,
      anchorDay: over.anchorDay ?? null,
      template: (over.template ?? {
        type: "EXPENSE",
        amount: 1_000,
        accountId,
        categoryId,
        merchant: "Netflix",
      }) as object,
    },
  });
}

describe("materializeDueRules", () => {
  beforeAll(async () => {
    const existing = await prisma.user.findUnique({ where: { email: EMAIL } });
    if (existing) await prisma.user.delete({ where: { id: existing.id } });
    const user = await prisma.user.create({ data: { name: "Recurring", email: EMAIL, emailVerified: true } });
    userId = user.id;
    const acc = await prisma.account.create({
      data: { userId, name: "Recurring Bank", type: "BANK", balance: 100_000, openingBalance: 100_000 },
    });
    accountId = acc.id;
    const cat = await prisma.category.create({ data: { userId, name: "Subscriptions", kind: "EXPENSE" } });
    categoryId = cat.id;
  });

  beforeEach(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.notification.deleteMany({ where: { userId } });
    await prisma.bill.deleteMany({ where: { userId } });
    await prisma.recurringRule.deleteMany({ where: { userId } });
    await prisma.account.update({ where: { id: accountId }, data: { balance: 100_000 } });
  });

  it("materializes a due occurrence and advances the schedule", async () => {
    const rule = await makeRule({ nextRunAt: istNoon("2026-07-01") });
    const res = await materializeDueRules(istNoon("2026-07-01"));

    expect(res.created).toBe(1);
    expect(res.failures).toEqual([]);
    const txs = await prisma.transaction.findMany({ where: { userId } });
    expect(txs).toHaveLength(1);
    expect(txs[0].merchant).toBe("Netflix");
    expect(txs[0].isRecurring).toBe(true);
    expect(txs[0].recurringRuleId).toBe(rule.id);

    const after = await prisma.recurringRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(toYMD(after.nextRunAt)).toBe("2026-07-02");
  });

  it("applies the balance effect and files a notification", async () => {
    await makeRule({ nextRunAt: istNoon("2026-07-01") });
    await materializeDueRules(istNoon("2026-07-01"));

    const acct = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(Number(acct.balance)).toBe(99_000); // 100000 − 1000 expense

    const notes = await prisma.notification.findMany({ where: { userId } });
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe("RECURRING_CREATED");
  });

  it("is idempotent — a second run on the same day creates nothing more", async () => {
    await makeRule({ nextRunAt: istNoon("2026-07-01") });
    const first = await materializeDueRules(istNoon("2026-07-01"));
    const second = await materializeDueRules(istNoon("2026-07-01"));

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(await prisma.transaction.count({ where: { userId } })).toBe(1);
  });

  // Regression: one occurrence per run meant a missed window took as many runs
  // to recover as it had missed days.
  it("catches up every missed occurrence in a single run", async () => {
    const rule = await makeRule({ cadence: "DAILY", nextRunAt: istNoon("2026-07-01") });
    // Cron didn't run for five days.
    const res = await materializeDueRules(istNoon("2026-07-05"));

    expect(res.created).toBe(5); // Jul 1,2,3,4,5
    const txs = await prisma.transaction.findMany({ where: { userId }, orderBy: { occurredAt: "asc" } });
    expect(txs.map((t) => toYMD(t.occurredAt))).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
      "2026-07-05",
    ]);
    const after = await prisma.recurringRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(toYMD(after.nextRunAt)).toBe("2026-07-06");
    // Balances follow the whole catch-up, not just the first occurrence.
    const acct = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(Number(acct.balance)).toBe(95_000);
  });

  it("bounds catch-up so a wildly backdated rule can't run away in one job", async () => {
    await makeRule({ cadence: "DAILY", nextRunAt: istNoon("2020-01-01") });
    const res = await materializeDueRules(istNoon("2026-07-05"));
    expect(res.created).toBe(60); // MAX_CATCHUP_PER_RUN
    expect(await prisma.transaction.count({ where: { userId } })).toBe(60);
  });

  it("never materializes an occurrence past the rule's end date", async () => {
    const rule = await makeRule({
      cadence: "DAILY",
      nextRunAt: istNoon("2026-07-01"),
      endsAt: istNoon("2026-07-03"),
    });
    const res = await materializeDueRules(istNoon("2026-07-10"));

    expect(res.created).toBe(3); // Jul 1,2,3 — not beyond endsAt
    const txs = await prisma.transaction.findMany({ where: { userId }, orderBy: { occurredAt: "asc" } });
    expect(txs.map((t) => toYMD(t.occurredAt))).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
    const after = await prisma.recurringRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(toYMD(after.nextRunAt)).toBe("2026-07-04"); // parked past the end
  });

  // Regression: the engine had no per-rule error handling, so a template
  // referencing a deleted account threw an FK error that aborted the whole loop
  // — every later rule silently skipped, and the reconciliation after it too.
  it("isolates a failing rule so the rest of the run still completes", async () => {
    await makeRule({
      nextRunAt: istNoon("2026-07-01"),
      template: { type: "EXPENSE", amount: 500, accountId: "account-that-does-not-exist", merchant: "Broken" },
    });
    const healthy = await makeRule({
      nextRunAt: istNoon("2026-07-01"),
      template: { type: "EXPENSE", amount: 700, accountId, categoryId, merchant: "Healthy" },
    });

    const res = await materializeDueRules(istNoon("2026-07-01"));

    expect(res.failures).toHaveLength(1);
    expect(res.created).toBe(1);
    const txs = await prisma.transaction.findMany({ where: { userId } });
    expect(txs.map((t) => t.merchant)).toEqual(["Healthy"]);
    // The healthy rule advanced; the broken one stayed put for a later retry.
    const after = await prisma.recurringRule.findUniqueOrThrow({ where: { id: healthy.id } });
    expect(toYMD(after.nextRunAt)).toBe("2026-07-02");
  });

  // Regression: advancing from an already-clamped date walked a month-end
  // schedule down to the 28th and left it there forever.
  it("keeps a month-end schedule on its anchor day across a short month", async () => {
    const rule = await makeRule({
      cadence: "MONTHLY",
      nextRunAt: istNoon("2026-01-31"),
      anchorDay: 31,
    });
    await materializeDueRules(istNoon("2026-04-30"));

    const txs = await prisma.transaction.findMany({ where: { userId }, orderBy: { occurredAt: "asc" } });
    expect(txs.map((t) => toYMD(t.occurredAt))).toEqual([
      "2026-01-31",
      "2026-02-28", // February clamps…
      "2026-03-31", // …and March gets the 31st back
      "2026-04-30",
    ]);
    const after = await prisma.recurringRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(toYMD(after.nextRunAt)).toBe("2026-05-31");
  });

  it("leaves rules with no anchor on their existing (drifting) schedule", async () => {
    await makeRule({ cadence: "MONTHLY", nextRunAt: istNoon("2026-01-31"), anchorDay: null });
    await materializeDueRules(istNoon("2026-03-31"));

    const txs = await prisma.transaction.findMany({ where: { userId }, orderBy: { occurredAt: "asc" } });
    expect(txs.map((t) => toYMD(t.occurredAt))).toEqual(["2026-01-31", "2026-02-28", "2026-03-28"]);
  });

  it("still materializes BILL rules (engine support is unchanged)", async () => {
    await makeRule({
      kind: "BILL",
      cadence: "MONTHLY",
      nextRunAt: istNoon("2026-07-01"),
      template: { name: "Broadband", amount: 99_900, categoryId },
    });
    const res = await materializeDueRules(istNoon("2026-07-01"));

    expect(res.created).toBe(1);
    const bills = await prisma.bill.findMany({ where: { userId } });
    expect(bills).toHaveLength(1);
    expect(bills[0].name).toBe("Broadband");
    expect(await prisma.transaction.count({ where: { userId } })).toBe(0);
  });

  it("does nothing when no rule is due yet", async () => {
    await makeRule({ nextRunAt: istNoon("2026-08-01") });
    const res = await materializeDueRules(istNoon("2026-07-01"));
    expect(res).toEqual({ created: 0, failures: [] });
  });
});

describe("recurring rule management", () => {
  function input(over: Partial<RuleInput> = {}): RuleInput {
    return {
      type: "EXPENSE",
      amountPaise: 49_900,
      accountId,
      categoryId,
      merchant: "Spotify",
      cadence: "MONTHLY",
      interval: 1,
      startYmd: "2026-08-15",
      endYmd: null,
      ...over,
    };
  }

  beforeEach(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.notification.deleteMany({ where: { userId } });
    await prisma.recurringRule.deleteMany({ where: { userId } });
    await prisma.account.update({ where: { id: accountId }, data: { balance: 100_000 } });
  });

  it("creates a rule and lists it with resolved account/category names", async () => {
    await createRecurringRule(userId, input());
    const [rule] = await listRecurringRules(userId);

    expect(rule.template.merchant).toBe("Spotify");
    expect(rule.template.amount).toBe(49_900);
    expect(rule.nextRunYmd).toBe("2026-08-15");
    expect(rule.accountName).toBe("Recurring Bank");
    expect(rule.categoryName).toBe("Subscriptions");
    expect(rule.isPaused).toBe(false);
    expect(rule.materializedCount).toBe(0);
  });

  it("anchors month-based cadences to the start day, and leaves day-based ones unanchored", async () => {
    await createRecurringRule(userId, input({ cadence: "MONTHLY", startYmd: "2026-01-31" }));
    await createRecurringRule(userId, input({ cadence: "WEEKLY", startYmd: "2026-01-31", merchant: "Weekly" }));
    const rules = await listRecurringRules(userId);

    expect(rules.find((r) => r.template.merchant === "Spotify")?.anchorDay).toBe(31);
    expect(rules.find((r) => r.template.merchant === "Weekly")?.anchorDay).toBeNull();
  });

  // Regression: the day a schedule is pinned to was read back off its FIRST
  // RUN, and "repeat this" on a 31st transaction schedules the first run a
  // month later — a September that has no 31st. The start date arrived already
  // clamped to the 30th, the anchor was derived from it, and the schedule was
  // on the 30th from then on. The caller now says which day it means.
  it("stores the anchor the caller states, not the day its clamped start date happens to fall on", async () => {
    await createRecurringRule(userId, input({ cadence: "MONTHLY", startYmd: "2026-09-30", anchorDay: 31 }));
    const rule = (await listRecurringRules(userId))[0];

    expect(rule.anchorDay).toBe(31);
    expect(rule.nextRunYmd).toBe("2026-09-30"); // the occurrence is still right
  });

  it("materializes a 31st-anchored rule created that way back onto the 31st", async () => {
    // The whole point, end to end: a rule created from a 31 August transaction
    // must produce Sep 30, Oct 31, Nov 30 — not the 30th forever.
    await createRecurringRule(userId, input({ cadence: "MONTHLY", startYmd: "2026-09-30", anchorDay: 31 }));
    await materializeDueRules(istNoon("2026-11-30"));

    const txs = await prisma.transaction.findMany({ where: { userId }, orderBy: { occurredAt: "asc" } });
    expect(txs.map((t) => toYMD(t.occurredAt))).toEqual(["2026-09-30", "2026-10-31", "2026-11-30"]);
  });

  it("ignores a nonsensical anchor and falls back to the start date's own day", async () => {
    for (const bad of [0, 32, -1, 3.5] as number[]) {
      await prisma.recurringRule.deleteMany({ where: { userId } });
      await createRecurringRule(userId, input({ cadence: "MONTHLY", startYmd: "2026-01-15", anchorDay: bad }));
      expect((await listRecurringRules(userId))[0].anchorDay).toBe(15);
    }
  });

  it("never anchors a day-based cadence, whatever the caller states", async () => {
    // A day-of-month on a weekly rule would make `advance` treat it as a
    // month-based one, silently changing what the schedule means.
    await createRecurringRule(userId, input({ cadence: "WEEKLY", startYmd: "2026-01-31", anchorDay: 31 }));
    expect((await listRecurringRules(userId))[0].anchorDay).toBeNull();
  });

  it("keeps a stated anchor through an edit that leaves the start date alone", async () => {
    // Saving an amount change on a month-end rule must not demote it: the date
    // in the form is the next run, which for such a rule is already clamped.
    await createRecurringRule(userId, input({ cadence: "MONTHLY", startYmd: "2026-09-30", anchorDay: 31 }));
    const created = (await listRecurringRules(userId))[0];

    await updateRecurringRule(userId, created.id, input({ cadence: "MONTHLY", startYmd: "2026-09-30", anchorDay: 31, amountPaise: 59_900 }));
    const after = (await listRecurringRules(userId))[0];

    expect(after.anchorDay).toBe(31);
    expect(after.template.amount).toBe(59_900);
  });

  it("re-anchors on an edit that moves the start date", async () => {
    // Choosing a new date IS choosing a new anchor — the obsolete one must go.
    await createRecurringRule(userId, input({ cadence: "MONTHLY", startYmd: "2026-09-30", anchorDay: 31 }));
    const created = (await listRecurringRules(userId))[0];

    await updateRecurringRule(userId, created.id, input({ cadence: "MONTHLY", startYmd: "2026-10-15" }));
    const after = (await listRecurringRules(userId))[0];

    expect(after.anchorDay).toBe(15);
    expect(after.nextRunYmd).toBe("2026-10-15");
  });

  it("drops the anchor when an edit turns a monthly rule into a weekly one", async () => {
    await createRecurringRule(userId, input({ cadence: "MONTHLY", startYmd: "2026-09-30", anchorDay: 31 }));
    const created = (await listRecurringRules(userId))[0];

    await updateRecurringRule(userId, created.id, input({ cadence: "WEEKLY", startYmd: "2026-10-05" }));
    expect((await listRecurringRules(userId))[0].anchorDay).toBeNull();
  });

  it("refuses an account or category belonging to someone else", async () => {
    const other = await prisma.user.create({ data: { name: "Other", email: "other-recurring@ledgerly.app", emailVerified: true } });
    const foreign = await prisma.account.create({
      data: { userId: other.id, name: "Not Yours", type: "BANK", balance: 0, openingBalance: 0 },
    });

    await expect(createRecurringRule(userId, input({ accountId: foreign.id }))).rejects.toThrow(/account doesn't exist/);
    expect(await prisma.recurringRule.count({ where: { userId } })).toBe(0);

    await prisma.user.delete({ where: { id: other.id } });
  });

  it("edits future occurrences only, never past ones", async () => {
    const id = await createRecurringRule(userId, input({ cadence: "DAILY", startYmd: "2026-07-01" }));
    await materializeDueRules(istNoon("2026-07-02")); // two occurrences at 49,900

    await updateRecurringRule(userId, id, input({ cadence: "DAILY", startYmd: "2026-07-03", amountPaise: 99_900 }));
    await materializeDueRules(istNoon("2026-07-03"));

    const txs = await prisma.transaction.findMany({ where: { userId }, orderBy: { occurredAt: "asc" } });
    expect(txs.map((t) => Number(t.amount))).toEqual([49_900, 49_900, 99_900]);
  });

  it("deleting a rule keeps the transactions it already created", async () => {
    const id = await createRecurringRule(userId, input({ cadence: "DAILY", startYmd: "2026-07-01" }));
    await materializeDueRules(istNoon("2026-07-02"));
    expect(await prisma.transaction.count({ where: { userId, deletedAt: null } })).toBe(2);

    await deleteRecurringRule(userId, id);

    expect(await prisma.recurringRule.count({ where: { id } })).toBe(0);
    // History survives, still stamped with the (now absent) rule id.
    const txs = await prisma.transaction.findMany({ where: { userId, deletedAt: null } });
    expect(txs).toHaveLength(2);
    expect(txs.every((t) => t.recurringRuleId === id)).toBe(true);
  });

  it("will not touch another user's rule", async () => {
    const other = await prisma.user.create({ data: { name: "Other", email: "other-recurring@ledgerly.app", emailVerified: true } });
    const theirs = await prisma.recurringRule.create({
      data: {
        userId: other.id,
        kind: "TRANSACTION",
        cadence: "DAILY",
        interval: 1,
        nextRunAt: istNoon("2026-07-01"),
        template: { type: "EXPENSE", amount: 100, merchant: "Theirs" } as object,
      },
    });

    await expect(deleteRecurringRule(userId, theirs.id)).rejects.toThrow(/not found/);
    await expect(setRecurringRulePaused(userId, theirs.id, true)).rejects.toThrow(/not found/);
    expect(await prisma.recurringRule.count({ where: { id: theirs.id } })).toBe(1);

    await prisma.user.delete({ where: { id: other.id } });
  });

  it("a paused rule materializes nothing and its schedule does not advance", async () => {
    const id = await createRecurringRule(userId, input({ cadence: "DAILY", startYmd: "2026-07-01" }));
    await setRecurringRulePaused(userId, id, true);

    const res = await materializeDueRules(istNoon("2026-07-05"));

    expect(res.created).toBe(0);
    expect(await prisma.transaction.count({ where: { userId } })).toBe(0);
    const rule = await prisma.recurringRule.findUniqueOrThrow({ where: { id } });
    expect(toYMD(rule.nextRunAt)).toBe("2026-07-01"); // frozen where it stood
  });

  it("resuming skips the paused window instead of backfilling it", async () => {
    // Start in the past so resume has a gap to skip.
    const id = await createRecurringRule(userId, input({ cadence: "DAILY", startYmd: "2020-01-01" }));
    await setRecurringRulePaused(userId, id, true);
    await setRecurringRulePaused(userId, id, false);

    const rule = await prisma.recurringRule.findUniqueOrThrow({ where: { id } });
    expect(rule.isPaused).toBe(false);
    // Rolled forward to today or later — not still sitting in 2020.
    expect(toYMD(rule.nextRunAt) >= todayYMD()).toBe(true);

    const res = await materializeDueRules(new Date());
    expect(res.created).toBeLessThanOrEqual(1); // at most today's occurrence
  });
});
