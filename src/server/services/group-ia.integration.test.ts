// v2.1 information-architecture regression suite.
//
// Two UX defects came out of real usage and are pinned here:
//
//   1. Shared led with a flat list of every shared expense, with groups as a
//      row of chips. Groups are the primary object now, so the home needs a
//      per-group standing — listGroupSummaries().
//   2. The group page showed "Total expenses ₹X" but never the expenses behind
//      it: groupDashboard() loaded those rows to compute balances and then
//      dropped them. They are exposed now, so the total is traceable and each
//      expense is reachable (and therefore editable) from the group.
//
// These tests also guard the invariant that matters most: the new read models
// must AGREE with the existing balance engine, never re-derive it.

import { beforeAll, describe, expect, it } from "vitest";
import { currentMonthKey } from "@/lib/dates";
import { parsePeriod } from "@/lib/period";
import { addExpense, updateExpense, softDeleteTransaction } from "./transactions";
import { groupDashboard, listGroupSummaries } from "./group-dashboard";
import { recordSettlement } from "./shared";
import { prisma } from "../db";

const EMAIL = "group-ia@ledgerly.app";
const KEY = currentMonthKey();
const YMD = `${KEY}-05`;

let userId: string;
let accountId: string;
let categoryId: string;
let tripId: string;   // 2 expenses, unsettled
let flatId: string;   // 1 expense, fully settled
let emptyId: string;  // no expenses at all
let alex: string;
let blake: string;

beforeAll(async () => {
  const ex = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (ex) await prisma.user.delete({ where: { id: ex.id } });
  const u = await prisma.user.create({ data: { name: "Owner", email: EMAIL, emailVerified: true } });
  userId = u.id;
  accountId = (await prisma.account.create({ data: { userId, name: "Cash", type: "CASH", openingBalance: 0, balance: 0 } })).id;
  categoryId = (await prisma.category.create({ data: { userId, name: "Travel", kind: "EXPENSE" } })).id;
  const mk = async (n: string) => (await prisma.participant.create({ data: { ownerId: userId, displayName: n } })).id;
  alex = await mk("Alex");
  blake = await mk("Blake");

  const mkGroup = async (name: string, members: string[]) =>
    (await prisma.group.create({ data: { name, createdById: userId, members: { create: members.map((participantId) => ({ participantId })) } } })).id;
  tripId = await mkGroup("Trip", [alex, blake]);
  flatId = await mkGroup("Flat", [alex]);
  emptyId = await mkGroup("Empty", [blake]);

  const add = (merchant: string, amount: number, groupId: string, who: string[]) =>
    addExpense(userId, { amount, accountId, categoryId, merchant, date: YMD, groupId, split: { mode: "EQUAL", participantIds: who, payerParticipantId: null } });
  await add("Coach fare", 30_000, tripId, [alex, blake]); // 3 ways → 10_000 each
  await add("Dinner", 60_000, tripId, [alex, blake]);     // 3 ways → 20_000 each
  await add("Rent", 20_000, flatId, [alex]);              // 2 ways → 10_000 each
  // clear the Flat balance so one group reads as settled
  await recordSettlement(userId, alex, "TO_OWNER", 10_000, "CASH", undefined, flatId);
});

describe("listGroupSummaries — the Shared home's group-first read model", () => {
  it("orders by what needs attention, not by when the group was created", async () => {
    // Creation order put an empty, settled group above a trip with money
    // outstanding — the first thing the eye hit had nothing to act on.
    // Unsettled first, then most recently active, never-used groups last.
    const s = await listGroupSummaries(userId);
    expect(s.map((g) => g.name)).toEqual(["Trip", "Flat", "Empty"]);
    expect(s[0].settled).toBe(false);
    expect(s[2].lastActivity).toBeNull();
  });

  it("answers the questions a group card asks, without opening the group", async () => {
    const trip = (await listGroupSummaries(userId)).find((g) => g.name === "Trip")!;
    expect(trip.memberCount).toBe(3);          // you + 2
    expect(trip.memberNames.sort()).toEqual(["Alex", "Blake"]);
    expect(trip.expenseCount).toBe(2);
    expect(trip.totalSpent).toBe(90_000);
    expect(trip.youAreOwed).toBe(60_000);      // 2 people × (10k + 20k)
    expect(trip.youOwe).toBe(0);
    expect(trip.youNet).toBe(60_000);
    expect(trip.settled).toBe(false);
    expect(trip.lastActivity).toBe(YMD);
  });

  it("marks a group with nothing outstanding as settled", async () => {
    const flat = (await listGroupSummaries(userId)).find((g) => g.name === "Flat")!;
    expect(flat.youAreOwed).toBe(0);
    expect(flat.youOwe).toBe(0);
    expect(flat.settled).toBe(true);
    expect(flat.expenseCount).toBe(1); // it still has its expense
  });

  it("handles a group with zero expenses without dividing by anything", async () => {
    const empty = (await listGroupSummaries(userId)).find((g) => g.name === "Empty")!;
    expect(empty.expenseCount).toBe(0);
    expect(empty.totalSpent).toBe(0);
    expect(empty.youNet).toBe(0);
    expect(empty.settled).toBe(true);
    expect(empty.lastActivity).toBeNull();
  });

  it("keeps groups isolated — one group's expenses never appear in another's totals", async () => {
    const s = await listGroupSummaries(userId);
    expect(s.find((g) => g.name === "Trip")!.totalSpent).toBe(90_000);
    expect(s.find((g) => g.name === "Flat")!.totalSpent).toBe(20_000);
    expect(s.find((g) => g.name === "Empty")!.totalSpent).toBe(0);
  });

  it("agrees exactly with groupDashboard — one balance engine, not two", async () => {
    for (const summary of await listGroupSummaries(userId)) {
      const dash = (await groupDashboard(userId, summary.id, parsePeriod({ p: "all" })))!;
      expect(summary.youNet).toBe(dash.youNet);
      expect(summary.youAreOwed).toBe(dash.youAreOwed);
      expect(summary.youOwe).toBe(dash.youOwe);
      expect(summary.totalSpent).toBe(dash.overview.totalExpenseSum);
      expect(summary.expenseCount).toBe(dash.overview.totalExpenseCount);
    }
  });

  it("returns nothing for a user with no groups", async () => {
    const solo = await prisma.user.create({ data: { name: "Solo", email: `ia-solo-${Date.now()}@x.test`, emailVerified: true } });
    expect(await listGroupSummaries(solo.id)).toEqual([]);
    await prisma.user.delete({ where: { id: solo.id } });
  });
});

describe("groupDashboard.expenses — the transactions behind the total", () => {
  it("exposes every expense that makes up totalExpenseSum", async () => {
    const g = (await groupDashboard(userId, tripId, parsePeriod({ p: "all" })))!;
    expect(g.expenses).toHaveLength(2);
    expect(g.expenses.reduce((s, e) => s + e.amount, 0)).toBe(g.overview.totalExpenseSum);
  });

  it("carries what the list needs, resolved server-side", async () => {
    const g = (await groupDashboard(userId, tripId, parsePeriod({ p: "all" })))!;
    const dinner = g.expenses.find((e) => e.merchant === "Dinner")!;
    expect(dinner.amount).toBe(60_000);
    expect(dinner.ymd).toBe(YMD);
    expect(dinner.paidByName).toBe("You");
    expect(dinner.paidByParticipantId).toBeNull();
    expect(dinner.yourShare).toBe(20_000);
    expect(dinner.splitCount).toBe(3);
    expect(dinner.categoryName).toBe("Travel");
  });

  it("names a member payer rather than leaving the row blank", async () => {
    await addExpense(userId, {
      amount: 30_000, accountId: null, categoryId, merchant: "Paid by Alex", date: YMD, groupId: tripId,
      split: { mode: "EQUAL", participantIds: [alex, blake], payerParticipantId: alex },
    });
    const g = (await groupDashboard(userId, tripId, parsePeriod({ p: "all" })))!;
    const row = g.expenses.find((e) => e.merchant === "Paid by Alex")!;
    expect(row.paidByName).toBe("Alex");
    expect(row.paidByParticipantId).toBe(alex);
    // clean up so later assertions keep their arithmetic
    const tx = await prisma.transaction.findFirstOrThrow({ where: { merchant: "Paid by Alex" } });
    await prisma.expenseSplit.deleteMany({ where: { txId: tx.id } });
    await prisma.transaction.delete({ where: { id: tx.id } });
  });

  it("is empty — not broken — for a group with no expenses", async () => {
    const g = (await groupDashboard(userId, emptyId, parsePeriod({ p: "all" })))!;
    expect(g.expenses).toEqual([]);
    expect(g.overview.totalExpenseSum).toBe(0);
  });

  it("shows expenses all-time, independent of the spending period filter", async () => {
    // The charts follow the period; the expense list must not, or the rows
    // behind an all-time total would vanish when the period narrows.
    const past = (await groupDashboard(userId, tripId, parsePeriod({ p: "2020-01" })))!;
    expect(past.expenses).toHaveLength(2);
    expect(past.spending.totalSpent).toBe(0); // charts correctly empty
  });
});

describe("editing a shared expense from the group updates everything", () => {
  it("an edit moves the group total, the balances and the list together", async () => {
    const before = (await groupDashboard(userId, tripId, parsePeriod({ p: "all" })))!;
    const coach = before.expenses.find((e) => e.merchant === "Coach fare")!;

    await updateExpense(userId, coach.id, {
      amount: 60_000, // was 30_000
      accountId,
      categoryId,
      merchant: "Coach fare",
      date: YMD,
      split: { mode: "EQUAL", participantIds: [alex, blake], payerParticipantId: null },
    });

    const after = (await groupDashboard(userId, tripId, parsePeriod({ p: "all" })))!;
    expect(after.overview.totalExpenseSum).toBe(before.overview.totalExpenseSum + 30_000);
    expect(after.expenses.find((e) => e.merchant === "Coach fare")!.amount).toBe(60_000);
    expect(after.youNet).toBe(before.youNet + 20_000); // 2 others × extra 10k each
    // and the Shared home agrees without a second calculation
    const summary = (await listGroupSummaries(userId)).find((g) => g.id === tripId)!;
    expect(summary.totalSpent).toBe(after.overview.totalExpenseSum);
    expect(summary.youNet).toBe(after.youNet);
  });

  it("an edit does not create a second transaction", async () => {
    const g = (await groupDashboard(userId, tripId, parsePeriod({ p: "all" })))!;
    expect(g.expenses.filter((e) => e.merchant === "Coach fare")).toHaveLength(1);
  });

  it("stays in the group when the edit says nothing about the group", async () => {
    const g = (await groupDashboard(userId, tripId, parsePeriod({ p: "all" })))!;
    expect(g.expenses.some((e) => e.merchant === "Coach fare")).toBe(true);
  });

  it("a delete removes it from the list and the totals (run last — mutates state)", async () => {
    const before = (await groupDashboard(userId, tripId, parsePeriod({ p: "all" })))!;
    const dinner = before.expenses.find((e) => e.merchant === "Dinner")!;

    await softDeleteTransaction(userId, dinner.id);

    const after = (await groupDashboard(userId, tripId, parsePeriod({ p: "all" })))!;
    expect(after.expenses.some((e) => e.id === dinner.id)).toBe(false);
    expect(after.overview.totalExpenseSum).toBe(before.overview.totalExpenseSum - dinner.amount);
    expect(after.youNet).toBe(before.youNet - 2 * dinner.yourShare);
    const summary = (await listGroupSummaries(userId)).find((g) => g.id === tripId)!;
    expect(summary.expenseCount).toBe(after.overview.totalExpenseCount);
    expect(summary.youNet).toBe(after.youNet);
  });
});
