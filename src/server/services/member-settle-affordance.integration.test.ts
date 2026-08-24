// Who is offered the member↔member Settle action, and what it carries (#240).
//
// minimizeSettlements has always routed one member straight to another — that
// is what makes it the shortest way to clear a group — but only rows with the
// owner on one side could be recorded, so the rest read "settle outside the
// app" and the group could not be driven to zero from inside it.
//
// member-settlements.integration covers the write path itself (18 tests). This
// covers the decision to offer it at all: the prefill is attached server-side,
// carries the pair exactly as the plan produced it, and is withheld from anyone
// who could not record it anyway. Plus the two gaps that path leaves — a caller
// who owns neither person, and a group holding only one of them.

import { beforeEach, describe, expect, it } from "vitest";
import { parsePeriod } from "@/lib/period";
import { groupDashboard } from "./group-dashboard";
import { recordMemberSettlement } from "./shared";
import { prisma } from "../db";

const EMAIL = "member-affordance@ledgerly.app";
const rup = (n: number) => Math.round(n * 100);
const ALL = parsePeriod({ p: "all" });

let userId: string, groupId: string;
let ana: string, ben: string, cara: string;

/** An expense paid by one person and shared by everyone named. */
async function expense(amount: number, paidBy: string | null, shares: [string | null, number][]) {
  await prisma.transaction.create({
    data: {
      userId,
      type: "EXPENSE",
      amount: rup(amount),
      merchant: "Dinner",
      occurredAt: new Date("2026-08-05T06:30:00.000Z"),
      groupId,
      paidByParticipantId: paidBy,
      splits: { create: shares.map(([participantId, owed]) => ({ participantId, owedAmount: rup(owed) })) },
    },
  });
}

const dash = async (uid = userId) => (await groupDashboard(uid, groupId, ALL))!;

beforeEach(async () => {
  const ex = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (ex) await prisma.user.delete({ where: { id: ex.id } });
  userId = (await prisma.user.create({ data: { name: "Owner", email: EMAIL, emailVerified: true } })).id;
  const mk = async (n: string) => (await prisma.participant.create({ data: { ownerId: userId, displayName: n } })).id;
  ana = await mk("Ana");
  ben = await mk("Ben");
  cara = await mk("Cara");
  groupId = (
    await prisma.group.create({
      data: { name: "Trip", createdById: userId, members: { create: [ana, ben, cara].map((participantId) => ({ participantId })) } },
    })
  ).id;
  // Ana fronts a bill everyone shares, so Ben and Cara owe HER, not the owner —
  // the shape that puts member→member rows in the plan.
  await expense(400, ana, [
    [null, 100],
    [ana, 100],
    [ben, 100],
    [cara, 100],
  ]);
});

describe("the plan offers member→member rows to the owner", () => {
  it("attaches a prefill carrying the pair exactly as planned", async () => {
    const rows = (await dash()).suggestions.filter((s) => !s.involvesYou);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.settleMembers).toBeDefined();
      // The direction is the pair, never derived from who is reading.
      expect({ from: r.settleMembers!.fromParticipantId, to: r.settleMembers!.toParticipantId }).toEqual({ from: r.fromId, to: r.toId });
      expect(r.settleMembers!.fromName).toBe(r.fromName);
      expect(r.settleMembers!.toName).toBe(r.toName);
      // and never the owner-directed prefill
      expect(r.settle).toBeUndefined();
    }
  });

  it("both ends are real participants, never the owner sentinel", async () => {
    const roster = new Set([ana, ben, cara]);
    for (const r of (await dash()).suggestions.filter((s) => !s.involvesYou)) {
      expect(roster.has(r.settleMembers!.fromParticipantId)).toBe(true);
      expect(roster.has(r.settleMembers!.toParticipantId)).toBe(true);
    }
  });

  it("the amount is offered to the paisa", async () => {
    const r = (await dash()).suggestions.find((s) => !s.involvesYou)!;
    expect(Math.round(Number(r.settleMembers!.amountRupees) * 100)).toBe(r.amount);
  });

  it("owner-involved rows keep the owner-directed prefill and get no member one", async () => {
    for (const r of (await dash()).suggestions.filter((s) => s.involvesYou)) {
      expect(r.settleMembers).toBeUndefined();
      expect(r.settle).toBeDefined();
    }
  });

  it("every row in the plan is now actionable by the owner", async () => {
    // The point of the issue: no row is left saying "settle outside the app".
    for (const r of (await dash()).suggestions) expect(Boolean(r.settle || r.settleMembers)).toBe(true);
  });
});

describe("a non-owner is offered nothing", () => {
  it("neither prefill reaches a linked member", async () => {
    const member = await prisma.user.create({ data: { name: "Ben", email: `ma-${Date.now()}@ledgerly.app`, emailVerified: true } });
    await prisma.participant.update({ where: { id: ben }, data: { linkedUserId: member.id } });
    const seen = await dash(member.id);
    expect(seen.canRecordSettlements).toBe(false);
    for (const r of seen.suggestions) {
      expect(r.settle).toBeUndefined();
      expect(r.settleMembers).toBeUndefined();
    }
    // but they still see the plan itself — it is group-wide, not viewer-scoped
    expect(seen.suggestions.length).toBeGreaterThan(0);
    await prisma.user.delete({ where: { id: member.id } });
  });
});

describe("the write path refuses what the affordance cannot cover", () => {
  it("a caller who owns neither person cannot record between them", async () => {
    const stranger = await prisma.user.create({ data: { name: "S", email: `ms-${Date.now()}@ledgerly.app`, emailVerified: true } });
    await expect(recordMemberSettlement(stranger.id, ben, cara, rup(50), "UPI", undefined, groupId)).rejects.toThrow(/not found/i);
    expect(await prisma.settlement.count({ where: { userId: stranger.id } })).toBe(0);
    await prisma.user.delete({ where: { id: stranger.id } });
  });

  it("a group holding only one of the two is not attached", async () => {
    const outsider = (await prisma.participant.create({ data: { ownerId: userId, displayName: "Outsider" } })).id;
    await recordMemberSettlement(userId, ben, outsider, rup(50), "UPI", undefined, groupId);
    const s = await prisma.settlement.findFirstOrThrow({ where: { userId, toParticipantId: outsider } });
    // Recorded between the two people, but not against a ledger where that debt
    // does not exist — the group must hold BOTH.
    expect(s.groupId).toBeNull();
    expect((await dash()).settlements).toHaveLength(0);
  });

  it("recording a member→member row does not disturb the owner's own rows", async () => {
    const before = await dash();
    const ownerRows = before.suggestions.filter((s) => s.involvesYou).map((s) => ({ from: s.fromId, to: s.toId, amount: s.amount }));
    const pair = before.suggestions.find((s) => !s.involvesYou)!;
    await recordMemberSettlement(userId, pair.settleMembers!.fromParticipantId, pair.settleMembers!.toParticipantId, pair.amount, "CASH", undefined, groupId);

    const after = await dash();
    // youNet is the owner's own standing, and it must not move — that is the
    // invariant the whole member↔member model rests on.
    //
    // youAreOwed and youOwe are NOT that: they are sums over the members' nets,
    // so a payment between two members moves them by construction (the payer
    // owes the group less, the recipient is owed less). Asserting those would
    // be asserting that the two members' balances did NOT update, which is the
    // opposite of what this feature is for.
    expect(after.youNet).toBe(before.youNet);
    // the owner's own obligations are untouched
    expect(after.suggestions.filter((s) => s.involvesYou).map((s) => ({ from: s.fromId, to: s.toId, amount: s.amount }))).toEqual(ownerRows);
    // and no cash leg was invented
    expect(await prisma.transaction.count({ where: { userId, type: { in: ["INCOME", "TRANSFER"] } } })).toBe(0);
  });
});
