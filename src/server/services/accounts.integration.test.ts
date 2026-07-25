// Database-backed tests for account lifecycle: rename, archive, restore, and the
// delete-or-archive decision. Run with `npm run test:integration`.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { istNoon } from "@/lib/dates";
import {
  archiveAccount,
  deleteOrArchiveAccount,
  listAccountRows,
  listAccounts,
  listArchivedAccounts,
  renameAccount,
  unarchiveAccount,
} from "./accounts";
import { queryTransactions } from "./ledger";
import { createRecurringRule, materializeDueRules } from "./recurring";
import { prisma } from "../db";

const EMAIL = "accounts-test@ledgerly.app";
let userId: string;
let categoryId: string;

async function makeAccount(name: string, over: { type?: "BANK" | "CASH" | "CREDIT_CARD"; balance?: number } = {}) {
  return prisma.account.create({
    data: {
      userId,
      name,
      type: over.type ?? "BANK",
      balance: over.balance ?? 50_000,
      openingBalance: over.balance ?? 50_000,
    },
  });
}

describe("account lifecycle", () => {
  beforeAll(async () => {
    const existing = await prisma.user.findUnique({ where: { email: EMAIL } });
    if (existing) await prisma.user.delete({ where: { id: existing.id } });
    const user = await prisma.user.create({ data: { name: "Accounts", email: EMAIL, emailVerified: true } });
    userId = user.id;
    const cat = await prisma.category.create({ data: { userId, name: "Misc", kind: "EXPENSE" } });
    categoryId = cat.id;
  });

  beforeEach(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.recurringRule.deleteMany({ where: { userId } });
    await prisma.budget.deleteMany({ where: { userId } });
    await prisma.bill.deleteMany({ where: { userId } });
    await prisma.loanEntry.deleteMany({ where: { userId } });
    await prisma.account.deleteMany({ where: { userId } });
  });

  it("renames an account without touching its balance", async () => {
    const a = await makeAccount("Typo Bnk");
    await renameAccount(userId, a.id, "Typo Bank");
    const after = await prisma.account.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.name).toBe("Typo Bank");
    expect(Number(after.balance)).toBe(50_000);
    expect(Number(after.openingBalance)).toBe(50_000);
  });

  it("hard-deletes an account nothing refers to", async () => {
    const a = await makeAccount("Created By Mistake");
    const res = await deleteOrArchiveAccount(userId, a.id);
    expect(res.outcome).toBe("deleted");
    expect(await prisma.account.count({ where: { id: a.id } })).toBe(0);
  });

  it("archives instead of deleting when transactions reference it, and keeps them", async () => {
    const a = await makeAccount("Real Bank");
    await prisma.transaction.create({
      data: { userId, type: "EXPENSE", amount: 1_000, accountId: a.id, categoryId, merchant: "Coffee", occurredAt: istNoon("2026-07-01") },
    });

    const res = await deleteOrArchiveAccount(userId, a.id);

    expect(res.outcome).toBe("archived");
    expect(res.reason).toContain("1 transaction");
    const after = await prisma.account.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.isArchived).toBe(true);
    expect(Number(after.balance)).toBe(50_000); // untouched
    expect(await prisma.transaction.count({ where: { userId } })).toBe(1);
  });

  // A transfer's destination is a reference too — deleting the account on the
  // receiving end would orphan the other half of the transfer.
  it("counts the destination side of a transfer as a reference", async () => {
    const from = await makeAccount("From");
    const to = await makeAccount("To");
    await prisma.transaction.create({
      data: { userId, type: "TRANSFER", amount: 500, accountId: from.id, toAccountId: to.id, merchant: "Self", occurredAt: istNoon("2026-07-01") },
    });

    expect((await deleteOrArchiveAccount(userId, to.id)).outcome).toBe("archived");
  });

  // Soft-deleted rows are restorable; they'd come back pointing at nothing.
  it("counts soft-deleted transactions as references", async () => {
    const a = await makeAccount("Has Deleted Rows");
    await prisma.transaction.create({
      data: {
        userId, type: "EXPENSE", amount: 1_000, accountId: a.id, merchant: "Gone",
        occurredAt: istNoon("2026-07-01"), deletedAt: new Date(),
      },
    });
    const res = await deleteOrArchiveAccount(userId, a.id);
    expect(res.outcome).toBe("archived");
  });

  // Budget/Bill cascade on account delete — a hard delete would silently destroy
  // them, which is exactly what archiving exists to avoid.
  it("archives rather than cascading away a budget or bill", async () => {
    const withBudget = await makeAccount("Budgeted");
    await prisma.budget.create({ data: { userId, accountId: withBudget.id, categoryId, limit: 10_000, period: "MONTHLY" } });
    const budgetRes = await deleteOrArchiveAccount(userId, withBudget.id);
    expect(budgetRes.outcome).toBe("archived");
    expect(budgetRes.reason).toContain("budget");
    expect(await prisma.budget.count({ where: { userId } })).toBe(1);

    const withBill = await makeAccount("Billed");
    await prisma.bill.create({ data: { userId, name: "Rent", amount: 5_000, accountId: withBill.id, dueDate: istNoon("2026-08-01") } });
    const billRes = await deleteOrArchiveAccount(userId, withBill.id);
    expect(billRes.outcome).toBe("archived");
    expect(billRes.reason).toContain("bill");
    expect(await prisma.bill.count({ where: { userId } })).toBe(1);
  });

  it("hides archived accounts from the pickers but keeps them listed as archived", async () => {
    const active = await makeAccount("Still Used");
    const archived = await makeAccount("Put Away");
    await archiveAccount(userId, archived.id);

    const rows = await listAccountRows(userId);
    const views = await listAccounts(userId);
    expect(rows.map((r) => r.id)).toEqual([active.id]);
    expect(views.map((v) => v.id)).toEqual([active.id]);

    const archivedList = await listArchivedAccounts(userId);
    expect(archivedList.map((a) => a.name)).toEqual(["Put Away"]);
    expect(archivedList[0].balance).toBe(50_000);
  });

  it("restores an archived account back into the pickers", async () => {
    const a = await makeAccount("Back Again");
    await archiveAccount(userId, a.id);
    expect((await listAccountRows(userId)).length).toBe(0);

    await unarchiveAccount(userId, a.id);

    expect((await listAccountRows(userId)).map((r) => r.name)).toEqual(["Back Again"]);
    expect(await listArchivedAccounts(userId)).toEqual([]);
  });

  it("reports the live transaction count on an archived account", async () => {
    const a = await makeAccount("Historic");
    await prisma.transaction.create({
      data: { userId, type: "EXPENSE", amount: 900, accountId: a.id, merchant: "Old", occurredAt: istNoon("2026-06-01") },
    });
    await archiveAccount(userId, a.id);
    const [archived] = await listArchivedAccounts(userId);
    expect(archived.transactionCount).toBe(1);
  });

  it("renames an archived account without restoring it", async () => {
    const a = await makeAccount("Wrong Name");
    await archiveAccount(userId, a.id);
    await renameAccount(userId, a.id, "Right Name");
    const [archived] = await listArchivedAccounts(userId);
    expect(archived.name).toBe("Right Name");
    expect((await listAccountRows(userId)).length).toBe(0);
  });

  describe("recurring rules", () => {
    it("pauses rules funded by an account when it is archived, and stops materializing them", async () => {
      const a = await makeAccount("Funds Netflix");
      await createRecurringRule(userId, {
        type: "EXPENSE", amountPaise: 49_900, accountId: a.id, categoryId, merchant: "Netflix",
        cadence: "DAILY", interval: 1, startYmd: "2026-07-01", endYmd: null,
      });

      const { pausedRules } = await archiveAccount(userId, a.id);
      expect(pausedRules).toBe(1);
      expect((await prisma.recurringRule.findFirstOrThrow({ where: { userId } })).isPaused).toBe(true);

      // The whole point: no new transactions land in an account put away.
      const res = await materializeDueRules(istNoon("2026-07-05"));
      expect(res.created).toBe(0);
      expect(await prisma.transaction.count({ where: { userId } })).toBe(0);
    });

    it("refuses to schedule a NEW rule against an archived account", async () => {
      const a = await makeAccount("Archived Funder");
      await archiveAccount(userId, a.id);

      await expect(
        createRecurringRule(userId, {
          type: "EXPENSE", amountPaise: 1_000, accountId: a.id, categoryId, merchant: "Nope",
          cadence: "MONTHLY", interval: 1, startYmd: "2026-08-01", endYmd: null,
        })
      ).rejects.toThrow(/archived/);
    });

    it("archives rather than deletes an account a recurring rule funds", async () => {
      const a = await makeAccount("Rule Funder");
      await createRecurringRule(userId, {
        type: "EXPENSE", amountPaise: 1_000, accountId: a.id, categoryId, merchant: "Sub",
        cadence: "MONTHLY", interval: 1, startYmd: "2026-08-01", endYmd: null,
      });
      const res = await deleteOrArchiveAccount(userId, a.id);
      expect(res.outcome).toBe("archived");
      expect(res.reason).toContain("recurring rule");
    });

    it("leaves rules paused after a restore rather than guessing they should resume", async () => {
      const a = await makeAccount("Restored Funder");
      await createRecurringRule(userId, {
        type: "EXPENSE", amountPaise: 1_000, accountId: a.id, categoryId, merchant: "Sub",
        cadence: "MONTHLY", interval: 1, startYmd: "2026-08-01", endYmd: null,
      });
      await archiveAccount(userId, a.id);
      await unarchiveAccount(userId, a.id);

      expect((await prisma.recurringRule.findFirstOrThrow({ where: { userId } })).isPaused).toBe(true);
    });
  });

  it("will not touch another user's account", async () => {
    const other = await prisma.user.create({ data: { name: "Other", email: "other-accounts@ledgerly.app", emailVerified: true } });
    const theirs = await prisma.account.create({
      data: { userId: other.id, name: "Theirs", type: "BANK", balance: 0, openingBalance: 0 },
    });

    await expect(renameAccount(userId, theirs.id, "Mine now")).rejects.toThrow(/not found/);
    await expect(archiveAccount(userId, theirs.id)).rejects.toThrow(/not found/);
    await expect(unarchiveAccount(userId, theirs.id)).rejects.toThrow(/not found/);
    await expect(deleteOrArchiveAccount(userId, theirs.id)).rejects.toThrow(/not found/);
    expect(await prisma.account.count({ where: { id: theirs.id } })).toBe(1);

    await prisma.user.delete({ where: { id: other.id } });
  });
});

describe("transaction filtering by account", () => {
  it("matches both sides of a transfer, and composes with a text search", async () => {
    const from = await makeAccount("Filter From");
    const to = await makeAccount("Filter To");
    await prisma.transaction.createMany({
      data: [
        { userId, type: "EXPENSE", amount: 100, accountId: from.id, merchant: "Groceries", occurredAt: istNoon("2026-07-01") },
        { userId, type: "TRANSFER", amount: 500, accountId: from.id, toAccountId: to.id, merchant: "Moving money", occurredAt: istNoon("2026-07-02") },
        { userId, type: "EXPENSE", amount: 200, accountId: to.id, merchant: "Groceries", occurredAt: istNoon("2026-07-03") },
      ],
    });

    const fromSide = await queryTransactions(userId, { accountId: from.id }, 0);
    expect(fromSide.rows.map((r) => r.merchant).sort()).toEqual(["Groceries", "Moving money"]);

    // The transfer counts for the destination account too.
    const toSide = await queryTransactions(userId, { accountId: to.id }, 0);
    expect(toSide.rows.map((r) => r.merchant).sort()).toEqual(["Groceries", "Moving money"]);

    // Account filter AND text search, not one overwriting the other.
    const both = await queryTransactions(userId, { accountId: to.id, textQuery: "Groceries" }, 0);
    expect(both.rows).toHaveLength(1);
    expect(Number(both.rows[0].amount)).toBe(200);
  });

  it("still finds the history of an archived account", async () => {
    const a = await makeAccount("Archived History");
    await prisma.transaction.create({
      data: { userId, type: "EXPENSE", amount: 700, accountId: a.id, merchant: "Old Spend", occurredAt: istNoon("2026-06-01") },
    });
    await archiveAccount(userId, a.id);

    const page = await queryTransactions(userId, { accountId: a.id }, 0);
    expect(page.rows.map((r) => r.merchant)).toEqual(["Old Spend"]);
  });
});
