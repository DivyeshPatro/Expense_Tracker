// Settling when the person is in several groups: the choice reaches the ledger.
//
// settlement-group-inference covers what the server does on its own — attach
// when unambiguous, stay null when not. This covers the half that only exists
// once the form asks: an explicit answer arriving for a person the server would
// have refused to guess about, and the answers that must not be honoured.
//
// The security property is that the group cannot be steered to a ledger the
// caller has no claim on. recordSettlement validates both halves — the group
// must be one the caller created, and the person must actually be in it — and
// falls back to an untagged settlement rather than mis-filing when either
// fails.

import { beforeEach, describe, expect, it } from "vitest";
import { parsePeriod } from "@/lib/period";
import { groupDashboard } from "./group-dashboard";
import { recordSettlement } from "./shared";
import { prisma } from "../db";

const EMAIL = "settle-choice@ledgerly.app";
const rup = (n: number) => Math.round(n * 100);
const ALL = parsePeriod({ p: "all" });

let userId: string, anaId: string, tripId: string, flatId: string;

/** A group expense so each group has a real balance to settle. */
async function groupExpense(groupId: string, amount: number, shares: [string | null, number][]) {
  await prisma.transaction.create({
    data: {
      userId,
      type: "EXPENSE",
      amount: rup(amount),
      merchant: "Dinner",
      occurredAt: new Date("2026-08-05T06:30:00.000Z"),
      groupId,
      splits: { create: shares.map(([participantId, owed]) => ({ participantId, owedAmount: rup(owed) })) },
    },
  });
}

const settlementFor = (participantId: string) => prisma.settlement.findFirstOrThrow({ where: { userId, participantId } });

beforeEach(async () => {
  const ex = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (ex) await prisma.user.delete({ where: { id: ex.id } });
  userId = (await prisma.user.create({ data: { name: "Owner", email: EMAIL, emailVerified: true } })).id;
  anaId = (await prisma.participant.create({ data: { ownerId: userId, displayName: "Ana" } })).id;
  // Ana is in BOTH, which is exactly when the server refuses to guess.
  tripId = (await prisma.group.create({ data: { name: "Trip", createdById: userId, members: { create: [{ participantId: anaId }] } } })).id;
  flatId = (await prisma.group.create({ data: { name: "Flat", createdById: userId, members: { create: [{ participantId: anaId }] } } })).id;
  await groupExpense(tripId, 300, [[null, 150], [anaId, 150]]);
  await groupExpense(flatId, 200, [[null, 100], [anaId, 100]]);
});

describe("an explicit choice settles the group it names", () => {
  it("lands in the chosen group, not the other one", async () => {
    await recordSettlement(userId, anaId, "TO_OWNER", rup(150), "UPI", undefined, tripId);
    expect((await settlementFor(anaId)).groupId).toBe(tripId);
    expect((await groupDashboard(userId, tripId, ALL))!.settlements).toHaveLength(1);
    expect((await groupDashboard(userId, flatId, ALL))!.settlements).toHaveLength(0);
  });

  it("clears the chosen group's balance and leaves the other's standing", async () => {
    await recordSettlement(userId, anaId, "TO_OWNER", rup(150), "UPI", undefined, tripId);
    const trip = (await groupDashboard(userId, tripId, ALL))!;
    const flat = (await groupDashboard(userId, flatId, ALL))!;
    expect(trip.members.find((m) => m.participantId === anaId)!.net).toBe(0);
    expect(flat.members.find((m) => m.participantId === anaId)!.net).toBe(rup(100));
  });

  it("the other group is still settleable afterwards", async () => {
    await recordSettlement(userId, anaId, "TO_OWNER", rup(150), "UPI", undefined, tripId);
    await recordSettlement(userId, anaId, "TO_OWNER", rup(100), "CASH", undefined, flatId);
    for (const gid of [tripId, flatId]) {
      const g = (await groupDashboard(userId, gid, ALL))!;
      expect({ group: g.name, net: g.members.find((m) => m.participantId === anaId)!.net }).toEqual({ group: g.name, net: 0 });
    }
  });

  it("answering 'not for a group' records it untagged — the form sends nothing", async () => {
    // Choosing Personal is an answer, and the server cannot infer its way back:
    // inference only fires when exactly one group contains the person, and this
    // question is only asked when several do.
    await recordSettlement(userId, anaId, "TO_OWNER", rup(150), "UPI");
    expect((await settlementFor(anaId)).groupId).toBeNull();
    for (const gid of [tripId, flatId]) expect((await groupDashboard(userId, gid, ALL))!.settlements).toHaveLength(0);
  });
});

describe("a choice that isn't the caller's to make is not honoured", () => {
  it("a group the participant is not in cannot be injected", async () => {
    const outsiderGroup = (await prisma.group.create({ data: { name: "Other", createdById: userId } })).id;
    await recordSettlement(userId, anaId, "TO_OWNER", rup(150), "UPI", undefined, outsiderGroup);
    // Not mis-filed into a group Ana has no debt in — and not silently moved
    // into one of hers either.
    expect((await settlementFor(anaId)).groupId).toBeNull();
    expect((await groupDashboard(userId, outsiderGroup, ALL))!.settlements).toHaveLength(0);
  });

  it("another user's group cannot be injected, even with a real id", async () => {
    const other = await prisma.user.create({ data: { name: "X", email: `sc-${Date.now()}@ledgerly.app`, emailVerified: true } });
    const theirPart = await prisma.participant.create({ data: { ownerId: other.id, displayName: "Theirs" } });
    const theirGroup = (await prisma.group.create({ data: { name: "Theirs", createdById: other.id, members: { create: [{ participantId: theirPart.id }] } } })).id;
    await recordSettlement(userId, anaId, "TO_OWNER", rup(150), "UPI", undefined, theirGroup);
    expect((await settlementFor(anaId)).groupId).toBeNull();
    expect(await prisma.settlement.count({ where: { groupId: theirGroup } })).toBe(0);
    await prisma.user.delete({ where: { id: other.id } });
  });
});
