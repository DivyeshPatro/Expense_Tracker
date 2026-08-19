// A settlement must land in the ledger it settles.
//
// Recorded without a group it cleared the shared-page balance but not the
// group's, because the group dashboard only counts settlements tagged to it.
// Someone paying back what they owed from a trip saw the debt clear on one
// screen and still owed it on the other — which is exactly what happened in
// production: eight settlements, all untagged, and a group page showing the
// full pre-settlement amounts.
//
// Splitwise cannot produce that state: a payment is a row in the same ledger as
// the expenses, so it necessarily moves those balances. This mirrors that.

import { beforeEach, describe, expect, it } from "vitest";
import { parsePeriod } from "@/lib/period";
import { groupDashboard } from "./group-dashboard";
import { recordSettlement } from "./shared";
import { prisma } from "../db";

const EMAIL = "settle-infer@ledgerly.app";
const rup = (n: number) => Math.round(n * 100);
const ALL = parsePeriod({ p: "all" });
let userId: string, categoryId: string, anaId: string, benId: string, tripId: string;

async function groupExpense(groupId: string, amount: number, shares: [string | null, number][]) {
  return prisma.transaction.create({
    data: {
      userId, type: "EXPENSE", amount: rup(amount), categoryId, merchant: "Dinner",
      occurredAt: new Date(), groupId, paidByParticipantId: null,
      splits: { create: shares.map(([participantId, owed]) => ({ participantId, owedAmount: rup(owed) })) },
    },
  });
}

describe("settlement group inference", () => {
  beforeEach(async () => {
    const ex = await prisma.user.findUnique({ where: { email: EMAIL } });
    if (ex) await prisma.user.delete({ where: { id: ex.id } });
    userId = (await prisma.user.create({ data: { name: "Owner", email: EMAIL, emailVerified: true } })).id;
    categoryId = (await prisma.category.create({ data: { userId, name: "Trip", kind: "EXPENSE", icon: "🧳", color: "#000" } })).id;
    anaId = (await prisma.participant.create({ data: { ownerId: userId, displayName: "Ana" } })).id;
    benId = (await prisma.participant.create({ data: { ownerId: userId, displayName: "Ben" } })).id;
    tripId = (await prisma.group.create({ data: { name: "Trip", createdById: userId, members: { create: [{ participantId: anaId }, { participantId: benId }] } } })).id;
    await groupExpense(tripId, 300, [[null, 100], [anaId, 100], [benId, 100]]);
  });

  it("attaches the group when the person belongs to exactly one", async () => {
    await recordSettlement(userId, anaId, "TO_OWNER", rup(100), "UPI"); // no groupId passed
    const s = await prisma.settlement.findFirstOrThrow({ where: { userId } });
    expect(s.groupId).toBe(tripId);
  });

  it("the group page reflects it — the bug that started this", async () => {
    const before = (await groupDashboard(userId, tripId, ALL))!;
    expect(before.members.find((m) => m.name === "Ana")!.net).toBe(rup(100));
    await recordSettlement(userId, anaId, "TO_OWNER", rup(100), "UPI"); // as the shared page would
    const after = (await groupDashboard(userId, tripId, ALL))!;
    expect(after.members.find((m) => m.name === "Ana")!.net).toBe(0);
    expect(after.settlements).toHaveLength(1);
  });

  it("an explicit group still wins over inference", async () => {
    await recordSettlement(userId, anaId, "TO_OWNER", rup(50), "UPI", undefined, tripId);
    expect((await prisma.settlement.findFirstOrThrow({ where: { userId } })).groupId).toBe(tripId);
  });

  it("stays untagged when the person is in NO group", async () => {
    const loner = (await prisma.participant.create({ data: { ownerId: userId, displayName: "Loner" } })).id;
    await recordSettlement(userId, loner, "TO_OWNER", rup(40), "CASH");
    expect((await prisma.settlement.findFirstOrThrow({ where: { userId, participantId: loner } })).groupId).toBeNull();
  });

  it("stays untagged when the person is in SEVERAL groups", async () => {
    // Guessing here would settle the wrong ledger. Ambiguous must stay null.
    const flatId = (await prisma.group.create({ data: { name: "Flat", createdById: userId, members: { create: [{ participantId: anaId }] } } })).id;
    await groupExpense(flatId, 200, [[null, 100], [anaId, 100]]);
    await recordSettlement(userId, anaId, "TO_OWNER", rup(100), "UPI");
    const s = await prisma.settlement.findFirstOrThrow({ where: { userId, participantId: anaId } });
    expect(s.groupId).toBeNull();
    // and neither group has silently absorbed it
    for (const gid of [tripId, flatId]) {
      expect((await groupDashboard(userId, gid, ALL))!.settlements).toHaveLength(0);
    }
  });

  it("never attaches a group belonging to somebody else", async () => {
    const other = await prisma.user.create({ data: { name: "X", email: `xi-${Date.now()}@ledgerly.app`, emailVerified: true } });
    const theirPart = await prisma.participant.create({ data: { ownerId: other.id, displayName: "Theirs" } });
    await prisma.group.create({ data: { name: "TheirGroup", createdById: other.id, members: { create: [{ participantId: theirPart.id }] } } });
    // our own participant, only in our one group — inference must not reach across users
    await recordSettlement(userId, benId, "TO_OWNER", rup(100), "UPI");
    expect((await prisma.settlement.findFirstOrThrow({ where: { userId, participantId: benId } })).groupId).toBe(tripId);
    await prisma.user.delete({ where: { id: other.id } });
  });

  it("the shared page and the group page now agree", async () => {
    await recordSettlement(userId, anaId, "TO_OWNER", rup(60), "UPI");
    const g = (await groupDashboard(userId, tripId, ALL))!;
    const groupNet = g.members.find((m) => m.name === "Ana")!.net;
    // the same arithmetic the shared page does: every settlement, group or not
    const setts = await prisma.settlement.findMany({ where: { userId, participantId: anaId } });
    const shared = rup(100) - setts.reduce((s, x) => s + (x.direction === "TO_OWNER" ? Number(x.amount) : -Number(x.amount)), 0);
    expect(groupNet).toBe(shared);
  });
});
