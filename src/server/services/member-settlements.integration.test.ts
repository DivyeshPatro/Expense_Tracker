// P0-1 — settlements between two members, and everything that must not change.
//
// minimizeSettlements has always been able to propose "Ana pays Ben": a group
// whose debts do not all run through one person needs such an edge to reach
// zero. The ledger could only record owner ↔ member, so the plan named a
// payment the app then refused to remember, and the group stayed permanently
// unsettled. These tests cover the new edge, the old ones unchanged beside it,
// and the invariant that matters most — a payment between two other people
// must not touch the owner's money.

import { beforeEach, describe, expect, it } from "vitest";
import { parsePeriod } from "@/lib/period";
import { groupDashboard } from "./group-dashboard";
import { netBalances, recordMemberSettlement, recordSettlement } from "./shared";
import { prisma } from "../db";

const EMAIL = "member-settle@ledgerly.app";
const rup = (n: number) => Math.round(n * 100);
const ALL = parsePeriod({ p: "all" });

let userId: string, categoryId: string, accountId: string, groupId: string;
let ana: string, ben: string, cara: string;

/** An expense the owner paid, split equally with everyone named. */
async function expense(amount: number, who: string[]) {
  const ids: (string | null)[] = [null, ...who];
  const base = Math.floor(amount / ids.length);
  const remainder = amount - base * ids.length;
  return prisma.transaction.create({
    data: {
      userId, type: "EXPENSE", amount, accountId, categoryId, merchant: "Dinner",
      occurredAt: new Date(), groupId, paidByParticipantId: null,
      splits: { create: ids.map((participantId) => ({ participantId, owedAmount: base + (participantId === null ? remainder : 0) })) },
    },
  });
}

/** Owner-centric net for one member, and the owner's own standing. */
async function balances() {
  const g = (await groupDashboard(userId, groupId, ALL))!;
  const of = (pid: string) => g.members.find((m) => m.participantId === pid)!.net;
  return { ana: of(ana), ben: of(ben), cara: of(cara), you: g.youNet, dash: g };
}

const accountBalance = async () => Number((await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).balance);
const cashLegs = () => prisma.transaction.count({ where: { userId, merchant: { startsWith: "Settled up" }, deletedAt: null } });

describe("settlements between two members", () => {
  beforeEach(async () => {
    const ex = await prisma.user.findUnique({ where: { email: EMAIL } });
    if (ex) await prisma.user.delete({ where: { id: ex.id } });
    userId = (await prisma.user.create({ data: { name: "Owner", email: EMAIL, emailVerified: true } })).id;
    categoryId = (await prisma.category.create({ data: { userId, name: "Trip", kind: "EXPENSE", icon: "🧳", color: "#000" } })).id;
    accountId = (await prisma.account.create({ data: { userId, name: "Cash", type: "CASH", openingBalance: 0, balance: 0, icon: "💵", color: "#000" } })).id;
    const mk = async (n: string) => (await prisma.participant.create({ data: { ownerId: userId, displayName: n } })).id;
    ana = await mk("Ana");
    ben = await mk("Ben");
    cara = await mk("Cara");
    groupId = (
      await prisma.group.create({
        data: { name: "Trip", createdById: userId, members: { create: [ana, ben, cara].map((participantId) => ({ participantId })) } },
      })
    ).id;
  });

  // ── A. existing behaviour, unchanged ─────────────────────────────────────
  it("member → owner still clears that member's balance", async () => {
    await expense(rup(400), [ana, ben, cara]); // ₹100 each
    expect((await balances()).ana).toBe(rup(100));
    await recordSettlement(userId, ana, "TO_OWNER", rup(100), "UPI", undefined, groupId);
    const b = await balances();
    expect(b.ana).toBe(0);
    expect(b.you).toBe(rup(200)); // Ben and Cara still owe ₹100 each
  });

  it("owner → member still works in the other direction", async () => {
    await expense(rup(400), [ana, ben, cara]);
    await recordSettlement(userId, ana, "FROM_OWNER", rup(100), "UPI", undefined, groupId);
    expect((await balances()).ana).toBe(rup(200));
  });

  it("still writes the owner's cash leg when the owner is a party", async () => {
    await expense(rup(400), [ana, ben, cara]);
    await recordSettlement(userId, ana, "TO_OWNER", rup(100), "UPI", undefined, groupId, accountId);
    expect(await cashLegs()).toBe(1);
    expect(await accountBalance()).toBe(rup(100)); // money actually arrived
  });

  it("a historical row with no from/to still reads correctly", async () => {
    // Written the way every row before this change was written.
    await expense(rup(400), [ana, ben, cara]);
    await prisma.settlement.create({
      data: { userId, participantId: ana, direction: "TO_OWNER", amount: rup(100), method: "UPI", groupId },
    });
    expect((await balances()).ana).toBe(0);
  });

  // ── B. the new edge ──────────────────────────────────────────────────────
  it("member A → member B moves the debt between them", async () => {
    await expense(rup(400), [ana, ben, cara]); // each owes the owner ₹100
    await recordMemberSettlement(userId, ana, ben, rup(50), "UPI", undefined, groupId);
    const b = await balances();
    expect(b.ana).toBe(rup(50)); // paid ₹50, owes ₹50 less
    expect(b.ben).toBe(rup(150)); // was paid ₹50, so is owed ₹50 less
    expect(b.cara).toBe(rup(100)); // untouched
  });

  it("and the reverse direction is its own edge", async () => {
    await expense(rup(400), [ana, ben, cara]);
    await recordMemberSettlement(userId, ben, ana, rup(50), "UPI", undefined, groupId);
    const b = await balances();
    expect(b.ben).toBe(rup(50));
    expect(b.ana).toBe(rup(150));
  });

  it("several member-to-member payments accumulate", async () => {
    await expense(rup(600), [ana, ben, cara]); // ₹150 each
    await recordMemberSettlement(userId, ana, ben, rup(50), "UPI", undefined, groupId);
    await recordMemberSettlement(userId, ana, cara, rup(25), "CASH", undefined, groupId);
    await recordMemberSettlement(userId, cara, ben, rup(10), "UPI", undefined, groupId);
    const b = await balances();
    expect(b.ana).toBe(rup(150) - rup(75));
    expect(b.ben).toBe(rup(150) + rup(60));
    expect(b.cara).toBe(rup(150) + rup(25) - rup(10));
    expect(b.you).toBe(rup(450)); // unchanged by any of them
  });

  it("mixes with owner-directed settlements", async () => {
    await expense(rup(400), [ana, ben, cara]);
    await recordSettlement(userId, ana, "TO_OWNER", rup(100), "UPI", undefined, groupId);
    await recordMemberSettlement(userId, ben, cara, rup(40), "UPI", undefined, groupId);
    const b = await balances();
    expect(b.ana).toBe(0);
    expect(b.ben).toBe(rup(60));
    expect(b.cara).toBe(rup(140));
    expect(b.you).toBe(rup(200)); // only Ana's payment moved the owner
  });

  // ── C. financial invariants ──────────────────────────────────────────────
  it("does NOT touch the owner's balance", async () => {
    await expense(rup(400), [ana, ben, cara]);
    const before = (await balances()).you;
    await recordMemberSettlement(userId, ana, ben, rup(75), "UPI", undefined, groupId);
    expect((await balances()).you).toBe(before);
  });

  it("does NOT create a cash leg or move the owner's account", async () => {
    // The invariant the separate writer exists to guarantee: recordMemberSettlement
    // takes no accountId, so there is nothing to pass by mistake.
    await expense(rup(400), [ana, ben, cara]);
    const before = await accountBalance();
    await recordMemberSettlement(userId, ana, ben, rup(75), "UPI", undefined, groupId);
    expect(await cashLegs()).toBe(0);
    expect(await accountBalance()).toBe(before);
    const row = await prisma.settlement.findFirstOrThrow({ where: { fromParticipantId: ana } });
    expect(row.transactionId).toBeNull();
    expect(row.participantId).toBeNull();
    expect(row.direction).toBeNull();
  });

  it("refuses a settlement with itself", async () => {
    await expect(recordMemberSettlement(userId, ana, ana, rup(10), "UPI")).rejects.toThrow(/different people/i);
  });

  it("the group reaches zero once every planned payment is recorded", async () => {
    // The case that could not be settled before: Ben fronts everything, so the
    // plan runs member → member and never through the owner.
    const amount = rup(300);
    const ids: (string | null)[] = [null, ana, ben, cara];
    await prisma.transaction.create({
      data: {
        userId, type: "EXPENSE", amount, accountId, categoryId, merchant: "Ben paid",
        occurredAt: new Date(), groupId, paidByParticipantId: ben,
        splits: { create: ids.map((participantId) => ({ participantId, owedAmount: rup(75) })) },
      },
    });
    const plan = (await groupDashboard(userId, groupId, ALL))!.suggestions;
    expect(plan.length).toBeGreaterThan(0);
    for (const t of plan) {
      if (t.fromId === "me") await recordSettlement(userId, t.toId, "FROM_OWNER", t.amount, "UPI", undefined, groupId);
      else if (t.toId === "me") await recordSettlement(userId, t.fromId, "TO_OWNER", t.amount, "UPI", undefined, groupId);
      else await recordMemberSettlement(userId, t.fromId, t.toId, t.amount, "UPI", undefined, groupId);
    }
    const after = (await groupDashboard(userId, groupId, ALL))!;
    for (const m of after.members) expect(m.net).toBe(0);
    expect(after.suggestions).toEqual([]);
  });

  it("leaves sub-rupee dust to the existing threshold policy", async () => {
    await expense(rup(10), [ana, ben, cara]); // ₹2.50 each, no remainder
    await recordMemberSettlement(userId, ana, ben, 1, "CASH", undefined, groupId); // 1 paise
    const b = await balances();
    expect(b.ana).toBe(rup(2.5) - 1);
    expect(b.ben).toBe(rup(2.5) + 1);
    // still "settled" to the UI, exactly as before — the threshold is untouched
    expect(Math.abs(b.you)).toBeGreaterThan(0);
  });

  // ── D. compatibility ─────────────────────────────────────────────────────
  it("the global per-friend balance follows both ends too", async () => {
    await expense(rup(400), [ana, ben, cara]);
    await recordMemberSettlement(userId, ana, ben, rup(50), "UPI", undefined, groupId);
    const nets = await netBalances(userId);
    expect(nets.find((n) => n.id === ana)!.net).toBe(rup(50));
    expect(nets.find((n) => n.id === ben)!.net).toBe(rup(150));
  });

  it("settlement history names both parties", async () => {
    await expense(rup(400), [ana, ben, cara]);
    await recordMemberSettlement(userId, ana, ben, rup(50), "UPI", undefined, groupId);
    await recordSettlement(userId, cara, "TO_OWNER", rup(100), "UPI", undefined, groupId);
    const rows = (await groupDashboard(userId, groupId, ALL))!.settlements;
    const m2m = rows.find((r) => r.direction === null)!;
    expect(m2m.fromName).toBe("Ana");
    expect(m2m.toName).toBe("Ben");
    const owner = rows.find((r) => r.direction === "TO_OWNER")!;
    expect(owner.participantName).toBe("Cara");
    expect(owner.toName).toBeNull(); // null ⇒ the owner
  });

  it("scopes to the group only when both people are in it", async () => {
    const outsider = (await prisma.participant.create({ data: { ownerId: userId, displayName: "Dev" } })).id;
    await recordMemberSettlement(userId, ana, outsider, rup(20), "UPI", undefined, groupId);
    const row = await prisma.settlement.findFirstOrThrow({ where: { toParticipantId: outsider } });
    expect(row.groupId).toBeNull(); // not this group's debt — left untagged
  });

  it("merging a duplicate contact repoints both ends of a member-to-member row", async () => {
    // Without this the delete at the end of a merge would cascade the payment
    // away — a real settlement lost to a bookkeeping fix.
    const dupe = (await prisma.participant.create({ data: { ownerId: userId, displayName: "Ana" } })).id;
    await prisma.groupMember.create({ data: { groupId, participantId: dupe } });
    await recordMemberSettlement(userId, dupe, ben, rup(30), "UPI", undefined, groupId);
    const { mergeParticipants } = await import("./shared");
    await mergeParticipants(userId, ana, dupe);
    const row = await prisma.settlement.findFirstOrThrow({ where: { toParticipantId: ben } });
    expect(row.fromParticipantId).toBe(ana);
    expect(await prisma.participant.count({ where: { id: dupe } })).toBe(0);
  });

  it("deleting a member-to-member settlement reverses it", async () => {
    await expense(rup(400), [ana, ben, cara]);
    await recordMemberSettlement(userId, ana, ben, rup(50), "UPI", undefined, groupId);
    const row = await prisma.settlement.findFirstOrThrow({ where: { fromParticipantId: ana } });
    await prisma.settlement.delete({ where: { id: row.id } });
    const b = await balances();
    expect(b.ana).toBe(rup(100));
    expect(b.ben).toBe(rup(100));
  });
});
