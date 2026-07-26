// Database-backed tests for budgets: the upsert/delete lifecycle and the
// threshold notifications that hang off it. Run with `npm run test:integration`.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { currentMonthKey, istNoon } from "@/lib/dates";
import { checkBudgetThresholds, deleteBudget, listBudgets, upsertBudget } from "./budgets";
import { prisma } from "../db";

const EMAIL = "budgets-test@ledgerly.app";
let userId: string;
let accountId: string;
let foodId: string;

// Inside the current month, so listBudgets' month filter sees the spending.
const NOW = new Date();
const KEY = currentMonthKey(NOW);
const SPEND_YMD = `${KEY}-01`;

async function spend(paise: number, categoryId = foodId) {
  const t = await prisma.transaction.create({
    data: { userId, type: "EXPENSE", amount: paise, accountId, categoryId, merchant: "Spend", occurredAt: istNoon(SPEND_YMD) },
  });
  return t;
}

async function budgetAlerts(budgetId?: string) {
  const rows = await prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  return rows.filter((r) => r.dedupeKey?.startsWith(budgetId ? `budget:${budgetId}:` : "budget:"));
}

describe("budgets", () => {
  beforeAll(async () => {
    const existing = await prisma.user.findUnique({ where: { email: EMAIL } });
    if (existing) await prisma.user.delete({ where: { id: existing.id } });
    const user = await prisma.user.create({ data: { name: "Budgets", email: EMAIL, emailVerified: true } });
    userId = user.id;
    const acc = await prisma.account.create({
      data: { userId, name: "Budget Bank", type: "BANK", balance: 1_000_000, openingBalance: 1_000_000 },
    });
    accountId = acc.id;
    const food = await prisma.category.create({ data: { userId, name: "Food", kind: "EXPENSE" } });
    foodId = food.id;
  });

  beforeEach(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.notification.deleteMany({ where: { userId } });
    await prisma.budget.deleteMany({ where: { userId } });
  });

  it("creates a budget and reports spending progress against it", async () => {
    await upsertBudget(userId, foodId, 10_000, NOW);
    await spend(6_000);

    const [view] = await listBudgets(userId, NOW);
    expect(view.limit).toBe(10_000);
    expect(view.spent).toBe(6_000);
    expect(view.pct).toBe(60);
    expect(view.over).toBe(false);
    expect(view.warn).toBe(false);
  });

  it("edits an existing budget in place, preserving its spending progress", async () => {
    await upsertBudget(userId, foodId, 10_000, NOW);
    const before = await prisma.budget.findFirstOrThrow({ where: { userId } });
    await spend(6_000);

    await upsertBudget(userId, foodId, 20_000, NOW);

    const after = await prisma.budget.findFirstOrThrow({ where: { userId } });
    expect(after.id).toBe(before.id); // same row, not a duplicate
    expect(await prisma.budget.count({ where: { userId } })).toBe(1);
    const [view] = await listBudgets(userId, NOW);
    expect(view.spent).toBe(6_000); // progress untouched
    expect(view.pct).toBe(30); // recomputed against the new limit
  });

  describe("threshold notifications", () => {
    it("files a warning once per period, not on every write", async () => {
      await upsertBudget(userId, foodId, 10_000, NOW);
      await spend(8_500);

      await checkBudgetThresholds(userId, foodId, NOW);
      await checkBudgetThresholds(userId, foodId, NOW);

      const alerts = await budgetAlerts();
      expect(alerts).toHaveLength(1);
      expect(alerts[0].kind).toBe("BUDGET_WARNING");
    });

    // Raising a budget after an 80% alert has fired: the alert now describes a
    // threshold that isn't crossed any more, and quotes the old limit.
    it("clears a stale warning when the budget is raised past it", async () => {
      await upsertBudget(userId, foodId, 10_000, NOW);
      await spend(8_500);
      await checkBudgetThresholds(userId, foodId, NOW);
      expect(await budgetAlerts()).toHaveLength(1);

      await upsertBudget(userId, foodId, 20_000, NOW);

      expect(await budgetAlerts()).toHaveLength(0);
      const [view] = await listBudgets(userId, NOW);
      expect(view.warn).toBe(false);
      expect(view.over).toBe(false);
    });

    // Lowering it must re-alert at the new level, which only works because the
    // old row (and therefore its dedupeKey) was cleared first.
    it("re-alerts at the new level when the budget is lowered below current spending", async () => {
      await upsertBudget(userId, foodId, 20_000, NOW);
      await spend(15_000);
      await checkBudgetThresholds(userId, foodId, NOW);
      expect(await budgetAlerts()).toHaveLength(0); // 75% of 20,000 — below the 80% threshold

      await upsertBudget(userId, foodId, 10_000, NOW);

      const alerts = await budgetAlerts();
      expect(alerts).toHaveLength(1);
      expect(alerts[0].kind).toBe("BUDGET_EXCEEDED");
      const payload = alerts[0].payload as { limit: number; spent: number };
      expect(payload.limit).toBe(10_000); // the NEW limit, not the old one
      expect(payload.spent).toBe(15_000);
    });

    it("does not churn notifications when the limit is re-saved unchanged", async () => {
      await upsertBudget(userId, foodId, 10_000, NOW);
      await spend(8_500);
      await checkBudgetThresholds(userId, foodId, NOW);
      const [before] = await budgetAlerts();

      await upsertBudget(userId, foodId, 10_000, NOW); // same value

      const [after] = await budgetAlerts();
      expect(after.id).toBe(before.id); // untouched, not deleted and re-created
    });
  });

  describe("delete", () => {
    it("removes the budget without touching transactions, categories or accounts", async () => {
      await upsertBudget(userId, foodId, 10_000, NOW);
      const budget = await prisma.budget.findFirstOrThrow({ where: { userId } });
      await spend(6_000);
      const balanceBefore = Number((await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).balance);

      const res = await deleteBudget(userId, budget.id);

      expect(res.clearedNotifications).toBe(0);
      expect(await prisma.budget.count({ where: { userId } })).toBe(0);
      // The budgeting layer is gone; everything underneath it is not.
      expect(await prisma.transaction.count({ where: { userId, deletedAt: null } })).toBe(1);
      expect(await prisma.category.count({ where: { id: foodId } })).toBe(1);
      expect(await prisma.account.count({ where: { id: accountId } })).toBe(1);
      expect(Number((await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).balance)).toBe(balanceBefore);
    });

    // Notifications reference a budget only through their dedupeKey string, so
    // nothing cascades — without explicit cleanup the alerts outlive the budget
    // and keep describing it in the notification centre.
    it("clears the budget's threshold alerts so none survive it", async () => {
      await upsertBudget(userId, foodId, 10_000, NOW);
      const budget = await prisma.budget.findFirstOrThrow({ where: { userId } });
      await spend(12_000);
      await checkBudgetThresholds(userId, foodId, NOW);
      expect(await budgetAlerts(budget.id)).toHaveLength(1);

      const res = await deleteBudget(userId, budget.id);

      expect(res.clearedNotifications).toBe(1);
      expect(await budgetAlerts()).toHaveLength(0);
    });

    it("leaves other budgets' alerts alone", async () => {
      const travel = await prisma.category.create({ data: { userId, name: "Travel", kind: "EXPENSE" } });
      await upsertBudget(userId, foodId, 10_000, NOW);
      await upsertBudget(userId, travel.id, 10_000, NOW);
      await spend(12_000, foodId);
      await spend(12_000, travel.id);
      await checkBudgetThresholds(userId, foodId, NOW);
      await checkBudgetThresholds(userId, travel.id, NOW);

      const foodBudget = await prisma.budget.findFirstOrThrow({ where: { userId, categoryId: foodId } });
      const travelBudget = await prisma.budget.findFirstOrThrow({ where: { userId, categoryId: travel.id } });
      expect(await budgetAlerts(travelBudget.id)).toHaveLength(1);

      await deleteBudget(userId, foodBudget.id);

      expect(await budgetAlerts(foodBudget.id)).toHaveLength(0);
      expect(await budgetAlerts(travelBudget.id)).toHaveLength(1);

      await prisma.budget.deleteMany({ where: { userId } });
      await prisma.category.delete({ where: { id: travel.id } });
    });

    it("a deleted budget stops producing alerts entirely", async () => {
      await upsertBudget(userId, foodId, 10_000, NOW);
      const budget = await prisma.budget.findFirstOrThrow({ where: { userId } });
      await spend(12_000);
      await deleteBudget(userId, budget.id);

      await checkBudgetThresholds(userId, foodId, NOW);

      expect(await budgetAlerts()).toHaveLength(0);
    });

    it("will not touch another user's budget", async () => {
      const other = await prisma.user.create({ data: { name: "Other", email: "other-budgets@ledgerly.app", emailVerified: true } });
      const theirs = await prisma.budget.create({ data: { userId: other.id, limit: 5_000, period: "MONTHLY" } });

      await expect(deleteBudget(userId, theirs.id)).rejects.toThrow(/not found/);
      expect(await prisma.budget.count({ where: { id: theirs.id } })).toBe(1);

      await prisma.user.delete({ where: { id: other.id } });
    });
  });
});
