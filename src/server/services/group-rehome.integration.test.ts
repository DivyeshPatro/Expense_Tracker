// v2.1 database-backed regression suite for the shared-expense group bug.
//
// Production incident being guarded against: five expenses were split among a
// group's members, but four were saved with groupId = null, so the group
// dashboard showed only a small fraction of the real total. The split arithmetic was
// never wrong — attribution was. These tests therefore assert two things at
// once: that a re-home puts the money where it belongs, and that it does not
// change a single rupee doing so.
//
// Run with `npm run test:integration` against the LOCAL Docker Postgres.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { currentMonthKey } from "@/lib/dates";
import { parsePeriod } from "@/lib/period";
import { addExpense, rehomeExpense, updateExpense } from "./transactions";
import { groupDashboard } from "./group-dashboard";
import { netBalances } from "./shared";
import { NotAuthorizedError } from "./authorization";
import { prisma } from "../db";

const EMAIL = "rehome-owner@ledgerly.app";
const OTHER_EMAIL = "rehome-outsider@ledgerly.app";
const KEY = currentMonthKey();
const YMD = `${KEY}-05`;

let userId: string;
let outsiderId: string;
let groupId: string;
let otherGroupId: string;
let accountId: string;
let personalCategoryId: string;
let groupCategoryId: string;
/** The five-member roster: You + these four. */
let alex: string;
let blake: string;
let casey: string;
let devon: string;
/** Deliberately NOT a member of either group. */
let outsiderParticipant: string;

async function reset() {
  for (const e of [EMAIL, OTHER_EMAIL]) {
    const ex = await prisma.user.findUnique({ where: { email: e } });
    if (ex) await prisma.user.delete({ where: { id: ex.id } });
  }

  const user = await prisma.user.create({ data: { name: "Owner", email: EMAIL, emailVerified: true } });
  userId = user.id;
  const outsider = await prisma.user.create({ data: { name: "Outsider", email: OTHER_EMAIL, emailVerified: true } });
  outsiderId = outsider.id;

  const acct = await prisma.account.create({
    data: { userId, name: "Cash", type: "CASH", openingBalance: 0, balance: 0 },
  });
  accountId = acct.id;

  const personalCat = await prisma.category.create({ data: { userId, name: "Travel", kind: "EXPENSE" } });
  personalCategoryId = personalCat.id;

  const mk = async (displayName: string) => (await prisma.participant.create({ data: { ownerId: userId, displayName } })).id;
  alex = await mk("Alex");
  blake = await mk("Blake");
  casey = await mk("Casey");
  devon = await mk("Devon");
  outsiderParticipant = await mk("Zara");

  const group = await prisma.group.create({
    data: {
      name: "Lakeside",
      createdById: userId,
      members: { create: [alex, blake, casey, devon].map((participantId) => ({ participantId })) },
    },
  });
  groupId = group.id;
  const groupCat = await prisma.category.create({ data: { groupId, name: "Travel", kind: "EXPENSE" } });
  groupCategoryId = groupCat.id;

  // A second group sharing two members — the ambiguity case.
  const other = await prisma.group.create({
    data: {
      name: "Flat 402",
      createdById: userId,
      members: { create: [{ participantId: alex }, { participantId: blake }] },
    },
  });
  otherGroupId = other.id;
}

/** Creates the personal split expense the bug produced: split among the
 *  group's members, saved with no group. */
async function personalSplit(amountPaise: number, participantIds: string[]) {
  await addExpense(userId, {
    amount: amountPaise,
    accountId,
    categoryId: personalCategoryId,
    merchant: "Coach fare",
    date: YMD,
    groupId: null,
    split: { mode: "EQUAL", participantIds, payerParticipantId: null },
  });
  const tx = await prisma.transaction.findFirst({ where: { userId, merchant: "Coach fare" }, orderBy: { createdAt: "desc" } });
  return tx!;
}

const splitsOf = (txId: string) =>
  prisma.expenseSplit.findMany({ where: { txId }, orderBy: [{ participantId: "asc" }], select: { participantId: true, owedAmount: true, method: true } });

beforeAll(reset);

describe("equal split arithmetic", () => {
  beforeEach(reset);

  it("₹500 across 5 people gives exactly ₹100 each", async () => {
    await addExpense(userId, {
      amount: 50_000,
      accountId,
      categoryId: groupCategoryId,
      merchant: "Dinner",
      date: YMD,
      groupId,
      split: { mode: "EQUAL", participantIds: [alex, blake, casey, devon], payerParticipantId: null },
    });
    const tx = await prisma.transaction.findFirst({ where: { userId, merchant: "Dinner" } });
    const splits = await splitsOf(tx!.id);
    expect(splits).toHaveLength(5);
    expect(splits.every((s) => Number(s.owedAmount) === 10_000)).toBe(true);
    expect(splits.reduce((a, s) => a + Number(s.owedAmount), 0)).toBe(50_000);
  });

  it("keeps paise exact when the total does not divide evenly", async () => {
    // ₹100 / 3 — the payer absorbs the remainder so the sum is preserved.
    await addExpense(userId, {
      amount: 10_000,
      accountId,
      categoryId: groupCategoryId,
      merchant: "Chai",
      date: YMD,
      groupId,
      split: { mode: "EQUAL", participantIds: [alex, blake], payerParticipantId: null },
    });
    const tx = await prisma.transaction.findFirst({ where: { userId, merchant: "Chai" } });
    const splits = await splitsOf(tx!.id);
    expect(splits.reduce((a, s) => a + Number(s.owedAmount), 0)).toBe(10_000);
    expect(splits.map((s) => Number(s.owedAmount)).sort((a, b) => a - b)).toEqual([3333, 3333, 3334]);
  });
});

describe("rehomeExpense — the production repair", () => {
  beforeEach(reset);

  it("reproduces the bug: a split saved as personal is invisible to the group", async () => {
    await personalSplit(500_000, [alex, blake, casey, devon]);
    const dash = await groupDashboard(userId, groupId, parsePeriod({ p: "all" }));
    expect(dash!.overview.totalExpenseSum).toBe(0);
    expect(dash!.youNet).toBe(0);
  });

  it("moving it into the group makes the group see it, with the right net", async () => {
    const tx = await personalSplit(500_000, [alex, blake, casey, devon]);
    await rehomeExpense(userId, tx.id, groupId);

    const dash = await groupDashboard(userId, groupId, parsePeriod({ p: "all" }));
    expect(dash!.overview.totalExpenseSum).toBe(500_000);
    // You paid the whole amount; the four others owe an equal share each.
    expect(dash!.youNet).toBe(4 * 100_000);
    expect(dash!.youAreOwed).toBe(4 * 100_000);
    expect(dash!.youOwe).toBe(0);
  });

  it("changes ONLY Transaction.groupId — every other column is byte-identical", async () => {
    const tx = await personalSplit(500_000, [alex, blake, casey, devon]);
    const before = await prisma.transaction.findUnique({ where: { id: tx.id } });
    const splitsBefore = await splitsOf(tx.id);

    await rehomeExpense(userId, tx.id, groupId);

    const after = await prisma.transaction.findUnique({ where: { id: tx.id } });
    const splitsAfter = await splitsOf(tx.id);

    expect(after!.groupId).toBe(groupId);
    expect(before!.groupId).toBeNull();
    // Everything that represents money or identity is untouched.
    expect(after!.amount).toBe(before!.amount);
    expect(after!.paidByParticipantId).toBe(before!.paidByParticipantId);
    expect(after!.accountId).toBe(before!.accountId);
    expect(after!.categoryId).toBe(before!.categoryId);
    expect(after!.merchant).toBe(before!.merchant);
    expect(after!.occurredAt).toEqual(before!.occurredAt);
    expect(splitsAfter).toEqual(splitsBefore);
  });

  it("does not rewrite the split ROWS — the same physical rows survive", async () => {
    // updateExpense() deletes and re-creates splits; a re-home must not.
    const tx = await personalSplit(500_000, [alex, blake, casey, devon]);
    const idsBefore = (await prisma.expenseSplit.findMany({ where: { txId: tx.id }, select: { id: true } })).map((s) => s.id).sort();
    await rehomeExpense(userId, tx.id, groupId);
    const idsAfter = (await prisma.expenseSplit.findMany({ where: { txId: tx.id }, select: { id: true } })).map((s) => s.id).sort();
    expect(idsAfter).toEqual(idsBefore);
  });

  it("leaves every per-person balance exactly unchanged", async () => {
    // The financial invariant from the report: total owed before == after.
    const tx = await personalSplit(500_000, [alex, blake, casey, devon]);
    const before = (await netBalances(userId)).map((p) => ({ id: p.id, net: p.net })).sort((a, b) => a.id.localeCompare(b.id));
    const totalBefore = before.reduce((s, p) => s + p.net, 0);

    await rehomeExpense(userId, tx.id, groupId);

    const after = (await netBalances(userId)).map((p) => ({ id: p.id, net: p.net })).sort((a, b) => a.id.localeCompare(b.id));
    expect(after).toEqual(before);
    expect(after.reduce((s, p) => s + p.net, 0)).toBe(totalBefore);
    expect(totalBefore).toBe(4 * 100_000);
  });

  it("does not touch the account balance", async () => {
    const tx = await personalSplit(500_000, [alex, blake, casey, devon]);
    const before = await prisma.account.findUnique({ where: { id: accountId } });
    await rehomeExpense(userId, tx.id, groupId);
    const after = await prisma.account.findUnique({ where: { id: accountId } });
    expect(after!.balance).toBe(before!.balance);
  });

  it("can move an expense back out to Personal", async () => {
    const tx = await personalSplit(500_000, [alex, blake, casey, devon]);
    await rehomeExpense(userId, tx.id, groupId);
    await rehomeExpense(userId, tx.id, null);
    const after = await prisma.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.groupId).toBeNull();
    const dash = await groupDashboard(userId, groupId, parsePeriod({ p: "all" }));
    expect(dash!.overview.totalExpenseSum).toBe(0);
  });

  it("is a no-op when the expense is already in that group", async () => {
    const tx = await personalSplit(500_000, [alex, blake, casey, devon]);
    await rehomeExpense(userId, tx.id, groupId);
    const v1 = (await prisma.transaction.findUnique({ where: { id: tx.id } }))!.version;
    const res = await rehomeExpense(userId, tx.id, groupId);
    const v2 = (await prisma.transaction.findUnique({ where: { id: tx.id } }))!.version;
    expect(res.moved).toBe(false);
    expect(v2).toBe(v1);
  });

  it("records an audit row so the move is visible in history", async () => {
    const tx = await personalSplit(500_000, [alex, blake, casey, devon]);
    await rehomeExpense(userId, tx.id, groupId);
    const row = await prisma.auditLog.findFirst({ where: { entityId: tx.id, action: "rehome" } });
    expect(row).not.toBeNull();
    expect((row!.after as { groupId: string }).groupId).toBe(groupId);
  });
});

describe("authorization", () => {
  beforeEach(reset);

  it("refuses to attach an expense to a group the caller isn't in", async () => {
    const tx = await personalSplit(500_000, [alex, blake, casey, devon]);
    // outsiderId is a real user with no membership of `groupId` at all.
    await expect(rehomeExpense(outsiderId, tx.id, groupId)).rejects.toThrow(NotAuthorizedError);
    const after = await prisma.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.groupId).toBeNull();
  });

  it("refuses when the target group does not exist", async () => {
    const tx = await personalSplit(500_000, [alex, blake, casey, devon]);
    await expect(rehomeExpense(userId, tx.id, "no-such-group")).rejects.toThrow(NotAuthorizedError);
  });

  it("refuses to move someone else's expense at all", async () => {
    const tx = await personalSplit(500_000, [alex, blake, casey, devon]);
    await expect(rehomeExpense(outsiderId, tx.id, null)).rejects.toThrow(NotAuthorizedError);
  });
});

describe("group isolation", () => {
  beforeEach(reset);

  it("an expense in one group never appears in another", async () => {
    const tx = await personalSplit(500_000, [alex, blake, casey, devon]);
    await rehomeExpense(userId, tx.id, groupId);

    const sri = await groupDashboard(userId, groupId, parsePeriod({ p: "all" }));
    const flat = await groupDashboard(userId, otherGroupId, parsePeriod({ p: "all" }));
    expect(sri!.overview.totalExpenseSum).toBe(500_000);
    expect(flat!.overview.totalExpenseSum).toBe(0);
    expect(flat!.youNet).toBe(0);
  });

  it("moving between groups moves the whole balance, leaving nothing behind", async () => {
    const tx = await personalSplit(500_000, [alex, blake, casey, devon]);
    await rehomeExpense(userId, tx.id, groupId);
    await rehomeExpense(userId, tx.id, otherGroupId);

    const sri = await groupDashboard(userId, groupId, parsePeriod({ p: "all" }));
    const flat = await groupDashboard(userId, otherGroupId, parsePeriod({ p: "all" }));
    expect(sri!.overview.totalExpenseSum).toBe(0);
    expect(sri!.youNet).toBe(0);
    expect(flat!.overview.totalExpenseSum).toBe(500_000);
  });

  it("keeps a non-member's share visible after a re-home — nobody's debt vanishes", async () => {
    // The production shape of this: one real person existed as two participant
    // records, and only one of them was on the roster. The other still held
    // a real outstanding share. Re-homing must not quietly drop a split whose participant
    // isn't a current member — computeMemberBalances keeps them (as
    // "(left group)") precisely so an outstanding balance can't disappear.
    const tx = await personalSplit(30_000, [alex, outsiderParticipant]);
    await rehomeExpense(userId, tx.id, groupId);

    const dash = await groupDashboard(userId, groupId, parsePeriod({ p: "all" }));
    const stranger = dash!.members.find((m) => m.participantId === outsiderParticipant);
    expect(stranger).toBeDefined();
    expect(stranger!.net).toBe(10_000); // ₹300 / 3 = ₹100
    expect(stranger!.name).toBe("(left group)");
    // and the group's total still reflects the whole expense
    expect(dash!.overview.totalExpenseSum).toBe(30_000);
    expect(dash!.youNet).toBe(20_000);
  });

  it("the global shared balance is unaffected by which group holds the expense", async () => {
    const tx = await personalSplit(500_000, [alex, blake, casey, devon]);
    const before = (await netBalances(userId)).reduce((s, p) => s + p.net, 0);
    await rehomeExpense(userId, tx.id, groupId);
    const mid = (await netBalances(userId)).reduce((s, p) => s + p.net, 0);
    await rehomeExpense(userId, tx.id, otherGroupId);
    const after = (await netBalances(userId)).reduce((s, p) => s + p.net, 0);
    expect(mid).toBe(before);
    expect(after).toBe(before);
  });
});

describe("updateExpense persists groupId (fix B)", () => {
  beforeEach(reset);

  it("moves the expense when an edit explicitly sends a new groupId", async () => {
    const tx = await personalSplit(500_000, [alex, blake, casey, devon]);
    await updateExpense(userId, tx.id, {
      amount: 500_000,
      accountId,
      categoryId: groupCategoryId, // target namespace
      merchant: "Coach fare",
      date: YMD,
      groupId,
      split: { mode: "EQUAL", participantIds: [alex, blake, casey, devon], payerParticipantId: null },
    });
    const after = await prisma.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.groupId).toBe(groupId);
  });

  it("leaves the group alone when the edit says nothing about it", async () => {
    // The regression this pins: an ordinary edit must never re-home a row.
    const tx = await personalSplit(500_000, [alex, blake, casey, devon]);
    await rehomeExpense(userId, tx.id, groupId);
    await updateExpense(userId, tx.id, {
      amount: 600_000,
      accountId,
      categoryId: groupCategoryId,
      merchant: "Coach fare (corrected)",
      date: YMD,
      // groupId deliberately omitted
      split: { mode: "EQUAL", participantIds: [alex, blake, casey, devon], payerParticipantId: null },
    });
    const after = await prisma.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.groupId).toBe(groupId);
    expect(Number(after!.amount)).toBe(600_000);
  });

  it("rejects a category from the wrong namespace when re-homing via an edit", async () => {
    const tx = await personalSplit(500_000, [alex, blake, casey, devon]);
    await expect(
      updateExpense(userId, tx.id, {
        amount: 500_000,
        accountId,
        categoryId: personalCategoryId, // personal category, group target
        merchant: "Coach fare",
        date: YMD,
        groupId,
        split: { mode: "EQUAL", participantIds: [alex, blake, casey, devon], payerParticipantId: null },
      })
    ).rejects.toThrow(/category/i);
  });

  it("refuses an edit that attaches the row to a group the caller isn't in", async () => {
    const tx = await personalSplit(500_000, [alex, blake, casey, devon]);
    await expect(
      updateExpense(outsiderId, tx.id, {
        amount: 500_000,
        accountId,
        categoryId: null,
        merchant: "Coach fare",
        date: YMD,
        groupId,
        split: { mode: "EQUAL", participantIds: [alex, blake, casey, devon], payerParticipantId: null },
      })
    ).rejects.toThrow(NotAuthorizedError);
  });
});

describe("the full production scenario, end to end", () => {
  beforeEach(reset);

  it("reproduces the mostly-invisible group and repairs it without changing a rupee", async () => {
    // The five real expenses, all paid by You, in production's proportions.
    const rows: { merchant: string; amount: number; members: string[]; inGroup: boolean }[] = [
      { merchant: "Coach fare", amount: 500_000, members: [alex, blake, casey, devon], inGroup: false },
      { merchant: "Uber", amount: 30_000, members: [alex, blake, casey, devon], inGroup: true },
      { merchant: "Corner shop", amount: 5_000, members: [alex, blake, casey, devon], inGroup: false },
      { merchant: "Tiffin", amount: 36_000, members: [alex, blake], inGroup: false },
      { merchant: "Uber 2", amount: 300_000, members: [alex, blake, casey, devon], inGroup: false },
    ];
    for (const r of rows) {
      await addExpense(userId, {
        amount: r.amount,
        accountId,
        categoryId: r.inGroup ? groupCategoryId : personalCategoryId,
        merchant: r.merchant,
        date: YMD,
        groupId: r.inGroup ? groupId : null,
        split: { mode: "EQUAL", participantIds: r.members, payerParticipantId: null },
      });
    }

    const totalOwedBefore = (await netBalances(userId)).reduce((s, p) => s + p.net, 0);
    const dashBefore = await groupDashboard(userId, groupId, parsePeriod({ p: "all" }));
    expect(dashBefore!.overview.totalExpenseSum).toBe(30_000); // only the one tagged row
    expect(dashBefore!.youNet).toBe(4 * 6_000);

    // Repair: move the four orphans in.
    const orphans = await prisma.transaction.findMany({ where: { userId, groupId: null, type: "EXPENSE", splits: { some: {} } } });
    expect(orphans).toHaveLength(4);
    for (const o of orphans) await rehomeExpense(userId, o.id, groupId);

    const totalOwedAfter = (await netBalances(userId)).reduce((s, p) => s + p.net, 0);
    const dashAfter = await groupDashboard(userId, groupId, parsePeriod({ p: "all" }));

    // The whole point: the group can finally see everything...
    expect(dashAfter!.overview.totalExpenseSum).toBe(871_000); // the whole trip
    // ...and not one rupee of what anyone owes has moved.
    expect(totalOwedAfter).toBe(totalOwedBefore);
    expect(dashAfter!.youNet).toBe(totalOwedBefore);
  });
});
