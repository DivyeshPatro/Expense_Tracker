// v2.1 regression suite for identity merging.
//
// The production incident: one real person ("Blake") existed as two Participant
// records — an imported lending contact hidden from the split picker, and a
// second created in-app under the same name. Each accumulated a separate portion
// of the SAME person's debt, and the group dashboard showed one of them as
// "(left group)".
//
// These tests pin two separate things:
//   1. after a merge the person has ONE balance, equal to the sum;
//   2. the merge moves references only — never a rupee.
//
// The nastiest case has its own test: ExpenseSplit.participantId is nullable
// with ON DELETE SET NULL, and every balance reader treats null as "the owner's
// own share". Deleting the duplicate before repointing therefore destroys money
// silently. `deleting the duplicate first would silently destroy money` proves
// that hazard is real, and the ordering test proves mergeParticipants avoids it.

import { beforeEach, describe, expect, it } from "vitest";
import { currentMonthKey } from "@/lib/dates";
import { parsePeriod } from "@/lib/period";
import { istNoon } from "@/lib/dates";
import { groupDashboard } from "./group-dashboard";
import { mergeParticipants, MergeConflictError, netBalances, recordSettlement } from "./shared";
import { lendingBalances } from "./lending";
import { prisma } from "../db";

const EMAIL = "merge-owner@ledgerly.app";
const KEY = currentMonthKey();
const YMD = `${KEY}-05`;

let userId: string;
let accountId: string;
let categoryId: string;
let groupId: string;
let otherGroupId: string;
let canonical: string; // "Blake" #1 — the keeper
let duplicate: string; // "Blake" #2 — folded in
let alex: string;

async function reset() {
  const ex = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (ex) await prisma.user.delete({ where: { id: ex.id } });
  const u = await prisma.user.create({ data: { name: "Owner", email: EMAIL, emailVerified: true } });
  userId = u.id;
  accountId = (await prisma.account.create({ data: { userId, name: "Cash", type: "CASH", openingBalance: 0, balance: 0 } })).id;
  categoryId = (await prisma.category.create({ data: { userId, name: "Travel", kind: "EXPENSE" } })).id;
  const mk = async (n: string) => (await prisma.participant.create({ data: { ownerId: userId, displayName: n } })).id;
  canonical = await mk("Blake");
  duplicate = await mk("Blake");
  alex = await mk("Alex");
  groupId = (await prisma.group.create({
    data: { name: "Lakeside", createdById: userId, members: { create: [{ participantId: canonical }, { participantId: alex }] } },
  })).id;
  otherGroupId = (await prisma.group.create({
    data: { name: "Flat 402", createdById: userId, members: { create: [{ participantId: alex }] } },
  })).id;
}

/**
 * An expense paid by the owner, split equally with `who`.
 *
 * Written straight to the database rather than through addExpense, because the
 * state this suite repairs cannot be created through addExpense any more: P0-2
 * refuses a group expense that names somebody outside the roster, and the
 * duplicate "Blake" is by definition not on it — that is the whole defect. The
 * rows here stand in for history recorded before the server validated this,
 * which is exactly what a merge tool has to cope with. The split maths matches
 * splitEqual: floor for everyone, remainder to the payer (the owner).
 */
async function expense(merchant: string, amount: number, who: string[], group: string | null = groupId) {
  const ids: (string | null)[] = [null, ...who];
  const base = Math.floor(amount / ids.length);
  const remainder = amount - base * ids.length;
  await prisma.transaction.create({
    data: {
      userId, type: "EXPENSE", amount, accountId, categoryId, merchant,
      occurredAt: istNoon(YMD), groupId: group, paidByParticipantId: null,
      splits: { create: ids.map((participantId) => ({ participantId, owedAmount: base + (participantId === null ? remainder : 0) })) },
    },
  });
  return prisma.transaction.findFirstOrThrow({ where: { userId, merchant }, include: { splits: true } });
}

const netOf = async (pid: string) => (await netBalances(userId)).find((p) => p.id === pid)?.net ?? 0;
const grandTotal = async () => (await netBalances(userId)).reduce((s, p) => s + p.net, 0);

beforeEach(reset);

describe("two identities for one person cannot survive a merge as two balances", () => {
  it("collapses into ONE balance equal to the sum", async () => {
    // Mirrors the production shape: a larger split on the duplicate, a smaller one
    // on the canonical record.
    await expense("Coach fare", 300_000, [alex, duplicate]);
    await expense("Uber", 60_000, [alex, canonical]);

    const beforeCanonical = await netOf(canonical);
    const beforeDuplicate = await netOf(duplicate);
    const beforeTotal = await grandTotal();
    expect(beforeCanonical).toBeGreaterThan(0);
    expect(beforeDuplicate).toBeGreaterThan(0);

    await mergeParticipants(userId, canonical, duplicate);

    const after = await netBalances(userId);
    const survivors = after.filter((p) => p.name === "Blake");
    expect(survivors).toHaveLength(1);
    expect(survivors[0].id).toBe(canonical);
    expect(survivors[0].net).toBe(beforeCanonical + beforeDuplicate);
    expect(await grandTotal()).toBe(beforeTotal);
    expect(after.find((p) => p.id === duplicate)).toBeUndefined();
  });

  it("leaves no second balance hiding anywhere", async () => {
    await expense("Coach fare", 300_000, [alex, duplicate]);
    await mergeParticipants(userId, canonical, duplicate);
    const rows = await prisma.expenseSplit.count({ where: { participantId: duplicate } });
    expect(rows).toBe(0);
    expect(await prisma.participant.findUnique({ where: { id: duplicate } })).toBeNull();
  });
});

describe("references survive; amounts never change", () => {
  it("keeps the SAME ExpenseSplit rows — only participantId moves", async () => {
    const tx = await expense("Coach fare", 300_000, [alex, duplicate]);
    const before = await prisma.expenseSplit.findMany({
      where: { txId: tx.id }, orderBy: { id: "asc" },
      select: { id: true, txId: true, owedAmount: true, method: true, isSettled: true },
    });

    await mergeParticipants(userId, canonical, duplicate);

    const after = await prisma.expenseSplit.findMany({
      where: { txId: tx.id }, orderBy: { id: "asc" },
      select: { id: true, txId: true, owedAmount: true, method: true, isSettled: true },
    });
    expect(after).toEqual(before); // same ids, same amounts, nothing recreated
  });

  it("never changes a split amount or the total", async () => {
    await expense("Coach fare", 300_000, [alex, duplicate]);
    await expense("Uber", 60_000, [alex, canonical]);
    const sumBefore = (await prisma.expenseSplit.aggregate({ _sum: { owedAmount: true } }))._sum.owedAmount;
    const rowsBefore = await prisma.expenseSplit.count();

    await mergeParticipants(userId, canonical, duplicate);

    expect((await prisma.expenseSplit.aggregate({ _sum: { owedAmount: true } }))._sum.owedAmount).toBe(sumBefore);
    expect(await prisma.expenseSplit.count()).toBe(rowsBefore);
  });

  it("never changes the parent expense — amount, payer, category, merchant, date, groupId", async () => {
    const tx = await expense("Coach fare", 300_000, [alex, duplicate]);
    const before = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
    await mergeParticipants(userId, canonical, duplicate);
    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(after).toEqual(before);
  });

  it("never changes group attribution", async () => {
    const tx = await expense("Coach fare", 300_000, [alex, duplicate]);
    await mergeParticipants(userId, canonical, duplicate);
    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(after.groupId).toBe(groupId);
    const dash = (await groupDashboard(userId, groupId, parsePeriod({ p: "all" })))!;
    expect(dash.overview.totalExpenseSum).toBe(300_000);
  });

  it("removes the '(left group)' row a non-member duplicate was producing", async () => {
    // The duplicate is NOT a group member, so its share renders as "(left group)".
    await expense("Coach fare", 300_000, [alex, duplicate]);
    const before = (await groupDashboard(userId, groupId, parsePeriod({ p: "all" })))!;
    expect(before.members.some((m) => m.name === "(left group)")).toBe(true);

    await mergeParticipants(userId, canonical, duplicate);

    const after = (await groupDashboard(userId, groupId, parsePeriod({ p: "all" })))!;
    expect(after.members.some((m) => m.name === "(left group)")).toBe(false);
    expect(after.members.filter((m) => m.name === "Blake")).toHaveLength(1);
    expect(after.youNet).toBe(before.youNet);
  });
});

describe("the SET NULL hazard that dictates the ordering", () => {
  it("deleting the duplicate FIRST would silently destroy money", async () => {
    // Not how mergeParticipants behaves — this documents WHY it repoints first.
    await expense("Coach fare", 300_000, [alex, duplicate]);
    const before = await grandTotal();
    const lost = await netOf(duplicate);
    expect(lost).toBeGreaterThan(0);

    await prisma.participant.delete({ where: { id: duplicate } }); // naive "merge"

    const orphaned = await prisma.expenseSplit.count({ where: { participantId: null, txId: { not: undefined } } });
    expect(orphaned).toBeGreaterThan(0); // its share became an owner share
    expect(await grandTotal()).toBe(before - lost); // money vanished
  });

  it("mergeParticipants repoints first, so nothing is ever nulled", async () => {
    await expense("Coach fare", 300_000, [alex, duplicate]);
    const nullsBefore = await prisma.expenseSplit.count({ where: { participantId: null } });
    const before = await grandTotal();

    await mergeParticipants(userId, canonical, duplicate);

    expect(await prisma.expenseSplit.count({ where: { participantId: null } })).toBe(nullsBefore);
    expect(await grandTotal()).toBe(before);
  });
});

describe("consistency across Shared, Lending and Groups", () => {
  it("carries lending entries over and combines them under one contact", async () => {
    await prisma.loanEntry.create({ data: { userId, participantId: duplicate, kind: "GAVE", amount: 100_000, occurredAt: new Date() } });
    await prisma.loanEntry.create({ data: { userId, participantId: canonical, kind: "GAVE", amount: 50_000, occurredAt: new Date() } });

    await mergeParticipants(userId, canonical, duplicate);

    const lend = await lendingBalances(userId);
    const blake = lend.filter((l) => l.name === "Blake");
    expect(blake).toHaveLength(1);
    expect(blake[0].id).toBe(canonical);
    expect(blake[0].net).toBe(150_000);
  });

  it("carries settlements over instead of dropping them", async () => {
    await expense("Coach fare", 300_000, [alex, duplicate]);
    await recordSettlement(userId, duplicate, "TO_OWNER", 10_000, "UPI");
    const totalBefore = await grandTotal();

    await mergeParticipants(userId, canonical, duplicate);

    expect(await prisma.settlement.count({ where: { participantId: duplicate } })).toBe(0);
    expect(await prisma.settlement.count({ where: { participantId: canonical } })).toBe(1);
    expect(await grandTotal()).toBe(totalBefore); // the settlement still reduces the balance
  });

  it("moves a group membership the canonical record doesn't already have", async () => {
    await prisma.groupMember.create({ data: { groupId: otherGroupId, participantId: duplicate } });
    const res = await mergeParticipants(userId, canonical, duplicate);
    expect(res.movedMemberships).toEqual([otherGroupId]);
    expect(await prisma.groupMember.count({ where: { groupId: otherGroupId, participantId: canonical } })).toBe(1);
    expect(await prisma.groupMember.count({ where: { participantId: duplicate } })).toBe(0);
  });

  it("drops a redundant membership without ever removing the canonical one", async () => {
    await prisma.groupMember.create({ data: { groupId, participantId: duplicate } });
    const res = await mergeParticipants(userId, canonical, duplicate);
    expect(res.redundantMemberships).toEqual([groupId]);
    // exactly one membership survives, and it is the canonical one
    expect(await prisma.groupMember.count({ where: { groupId, participantId: canonical } })).toBe(1);
    expect(await prisma.groupMember.count({ where: { groupId } })).toBe(2); // Blake + Alex
  });

  it("repoints an expense the duplicate PAID for", async () => {
    // Same reason as the `expense` helper: the duplicate is not on the roster,
    // so this row could only have been recorded before P0-2 existed.
    await prisma.transaction.create({
      data: {
        userId, type: "EXPENSE", amount: 30_000, accountId: null, categoryId, merchant: "Paid by dup",
        occurredAt: istNoon(YMD), groupId, paidByParticipantId: duplicate,
        splits: { create: [null, alex, duplicate].map((participantId) => ({ participantId, owedAmount: 10_000 })) },
      },
    });
    await mergeParticipants(userId, canonical, duplicate);
    const tx = await prisma.transaction.findFirstOrThrow({ where: { merchant: "Paid by dup" } });
    expect(tx.paidByParticipantId).toBe(canonical);
  });
});

describe("refuses to merge when it would be wrong", () => {
  it("rejects merging a contact into itself", async () => {
    await expect(mergeParticipants(userId, canonical, canonical)).rejects.toThrow(MergeConflictError);
  });

  it("rejects when both appear on the SAME expense — that proves two people", async () => {
    await expense("Dinner", 30_000, [canonical, duplicate]);
    await expect(mergeParticipants(userId, canonical, duplicate)).rejects.toThrow(/same expense/i);
    // and nothing was changed by the failed attempt
    expect(await prisma.participant.findUnique({ where: { id: duplicate } })).not.toBeNull();
  });

  it("rejects when the two are linked to different real user accounts", async () => {
    const u2 = await prisma.user.create({ data: { name: "A", email: `mg-a-${Date.now()}@x.test`, emailVerified: true } });
    const u3 = await prisma.user.create({ data: { name: "B", email: `mg-b-${Date.now()}@x.test`, emailVerified: true } });
    await prisma.participant.update({ where: { id: canonical }, data: { linkedUserId: u2.id } });
    await prisma.participant.update({ where: { id: duplicate }, data: { linkedUserId: u3.id } });
    await expect(mergeParticipants(userId, canonical, duplicate)).rejects.toThrow(/different user accounts/i);
  });

  it("rejects a contact that isn't the caller's", async () => {
    const other = await prisma.user.create({ data: { name: "X", email: `mg-x-${Date.now()}@x.test`, emailVerified: true } });
    const theirs = await prisma.participant.create({ data: { ownerId: other.id, displayName: "Blake" } });
    await expect(mergeParticipants(userId, canonical, theirs.id)).rejects.toThrow(MergeConflictError);
  });

  it("rolls back completely on a rejected merge", async () => {
    await expense("Dinner", 30_000, [canonical, duplicate]);
    const before = await grandTotal();
    await expect(mergeParticipants(userId, canonical, duplicate)).rejects.toThrow();
    expect(await grandTotal()).toBe(before);
    expect(await prisma.expenseSplit.count({ where: { participantId: duplicate } })).toBeGreaterThan(0);
  });
});

describe("audit history", () => {
  it("records the merge with the exact id mapping", async () => {
    const tx = await expense("Coach fare", 300_000, [alex, duplicate]);
    const movedIds = (await prisma.expenseSplit.findMany({ where: { participantId: duplicate }, select: { id: true } })).map((s) => s.id);

    await mergeParticipants(userId, canonical, duplicate);

    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: "merge", entityId: canonical } });
    const after = row.after as { duplicateDeleted: string; repointedExpenseSplitIds: string[] };
    expect(after.duplicateDeleted).toBe(duplicate);
    expect(after.repointedExpenseSplitIds.sort()).toEqual(movedIds.sort());
    expect(tx.id).toBeTruthy();
  });

  it("does not delete pre-existing audit history for the duplicate", async () => {
    await expense("Coach fare", 300_000, [alex, duplicate]);
    const before = await prisma.auditLog.count();
    await mergeParticipants(userId, canonical, duplicate);
    // history only grows: the merge adds a row, nothing is removed
    expect(await prisma.auditLog.count()).toBe(before + 1);
  });
});
