// Database-backed tests for the recurring engine. Run with
// `npm run test:integration` (needs DATABASE_URL); CI runs these in the job
// with a Postgres service.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { istNoon, toYMD } from "@/lib/dates";
import { materializeDueRules } from "./recurring";
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
