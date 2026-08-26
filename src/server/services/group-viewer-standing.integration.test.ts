// Whose money the group page's first-person figures describe (#238).
//
// The settlement plan, the obligations and the members list were already
// group-wide and identical for every viewer. The personal figures were not:
// youNet / youAreOwed / youOwe / yourShare all read the OWNER's row whoever was
// looking, so a member saw another person's money under their own pronoun,
// directly above a plan that correctly said something else.
//
// No new arithmetic is involved. computeMemberBalances already holds every
// person's position; standingOf reads the right row and, for a member, flips
// the sign into the frame the page has always spoken in.
//
// Fixture mirrors the one in the issue: 4 people, equal shares, one expense
// each paid by a different person, so every viewer has a different answer.

import { beforeAll, describe, expect, it } from "vitest";
import { parsePeriod } from "@/lib/period";
import { groupDashboard, listGroupSummaries } from "./group-dashboard";
import { viewerPositionTotals } from "@/lib/group-dashboard";
import { prisma } from "../db";

const EMAIL = "viewer-standing@ledgerly.app";
const rup = (n: number) => Math.round(n * 100);
const ALL = parsePeriod({ p: "all" });

let ownerId: string, groupId: string;
let ana: string, ben: string, cara: string;
let anaUser: string, benUser: string;

async function expense(amount: number, paidBy: string | null, shares: [string | null, number][]) {
  await prisma.transaction.create({
    data: {
      userId: ownerId,
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

const dash = async (uid: string) => (await groupDashboard(uid, groupId, ALL))!;
const card = async (uid: string) => (await listGroupSummaries(uid)).find((g) => g.id === groupId)!;

beforeAll(async () => {
  for (const e of [EMAIL, `ana-${EMAIL}`, `ben-${EMAIL}`]) {
    const ex = await prisma.user.findUnique({ where: { email: e } });
    if (ex) await prisma.user.delete({ where: { id: ex.id } });
  }
  ownerId = (await prisma.user.create({ data: { name: "Owner", email: EMAIL, emailVerified: true } })).id;
  anaUser = (await prisma.user.create({ data: { name: "Ana", email: `ana-${EMAIL}`, emailVerified: true } })).id;
  benUser = (await prisma.user.create({ data: { name: "Ben", email: `ben-${EMAIL}`, emailVerified: true } })).id;

  const mk = async (n: string, linkedUserId?: string) =>
    (await prisma.participant.create({ data: { ownerId, displayName: n, linkedUserId } })).id;
  ana = await mk("Ana", anaUser);
  ben = await mk("Ben", benUser);
  cara = await mk("Cara");
  groupId = (
    await prisma.group.create({
      data: { name: "Trip", createdById: ownerId, members: { create: [ana, ben, cara].map((participantId) => ({ participantId })) } },
    })
  ).id;

  // Every viewer must land on a DIFFERENT number, or a test that reads the
  // owner's row by mistake would still pass — which is exactly what an earlier
  // version of this fixture did, with all three at +₹100.
  //
  // The last bill is also split UNEQUALLY, because yourShare only diverges once
  // one is: equal splits hide the very bug being fixed.
  //
  //            paid     share                    standing (paid − share)
  //   owner     400     100+150+20 = 270          +130
  //   Ana       600     100+150+60 = 310          +290
  //   Ben       200     100+150+50 = 300          −100
  //   Cara        0     100+150+70 = 320          −320
  await expense(400, null, [[null, 100], [ana, 100], [ben, 100], [cara, 100]]);
  await expense(600, ana, [[null, 150], [ana, 150], [ben, 150], [cara, 150]]);
  await expense(200, ben, [[null, 20], [ana, 60], [ben, 50], [cara, 70]]);
});

/** paid − share, in the frame the page speaks: positive means "I am owed". */
const TRUE_STANDING = { owner: rup(130), ana: rup(290), ben: rup(-100), cara: rup(-320) };

describe("each viewer reads their own position", () => {
  it("the owner sees theirs, exactly as before", async () => {
    expect((await dash(ownerId)).youNet).toBe(TRUE_STANDING.owner);
  });

  it("a member sees theirs, not the owner's", async () => {
    const seen = await dash(anaUser);
    expect(seen.youNet).toBe(TRUE_STANDING.ana);
    expect(seen.youNet).not.toBe(TRUE_STANDING.owner);
  });

  it("a member who OWES sees a negative standing, not the owner's positive one", async () => {
    const seen = await dash(benUser);
    expect(seen.youNet).toBe(TRUE_STANDING.ben);
    expect(seen.youNet).toBeLessThan(0);
  });

  it("all three viewers get three different answers", async () => {
    const [o, a, b] = await Promise.all([dash(ownerId), dash(anaUser), dash(benUser)]);
    expect([o.youNet, a.youNet, b.youNet]).toEqual([TRUE_STANDING.owner, TRUE_STANDING.ana, TRUE_STANDING.ben]);
    expect(new Set([o.youNet, a.youNet, b.youNet]).size).toBe(3);
  });

  it("an unlinked member's row still reads correctly through the owner's view", async () => {
    const g = await dash(ownerId);
    expect(-g.members.find((m) => m.participantId === cara)!.net).toBe(TRUE_STANDING.cara);
  });

  it("every viewer's hero matches the row already shown for them", async () => {
    for (const [uid, pid] of [
      [anaUser, ana],
      [benUser, ben],
    ] as const) {
      const g = await dash(uid);
      expect({ uid, net: g.youNet }).toEqual({ uid, net: -g.members.find((m) => m.participantId === pid)!.net });
    }
  });
});

describe("you'll get / you'll pay follow the same person", () => {
  it("still reconcile with the net, for every viewer", async () => {
    for (const uid of [ownerId, anaUser, benUser]) {
      const g = await dash(uid);
      expect({ uid, diff: g.youAreOwed - g.youOwe }).toEqual({ uid, diff: g.youNet });
    }
  });

  it("a member who is owed shows it on the right side", async () => {
    const g = await dash(anaUser);
    expect({ owed: g.youAreOwed, owe: g.youOwe }).toEqual({ owed: TRUE_STANDING.ana, owe: 0 });
  });

  it("a member who owes shows it on the other side", async () => {
    const g = await dash(benUser);
    expect({ owed: g.youAreOwed, owe: g.youOwe }).toEqual({ owed: 0, owe: -TRUE_STANDING.ben });
  });
});

describe("your share is your own", () => {
  it("each viewer's share of an expense is their own split row", async () => {
    for (const [uid, pid] of [
      [ownerId, null],
      [anaUser, ana],
      [benUser, ben],
    ] as const) {
      const g = await dash(uid);
      for (const e of g.expenses) {
        const stored = await prisma.expenseSplit.findFirstOrThrow({ where: { txId: e.id, participantId: pid } });
        expect({ uid, merchant: e.merchant, share: e.yourShare }).toEqual({ uid, merchant: e.merchant, share: Number(stored.owedAmount) });
      }
    }
  });
});

describe("the group card agrees with the page it opens", () => {
  it("no viewer is shown one figure on the card and another on the page", async () => {
    // Fixing only the page would have swapped a consistent-but-wrong number for
    // a contradiction between two screens.
    //
    // Compared against what the page RENDERS, which is no longer g.youAreOwed:
    // that pair is the group-wide aggregate over member nets, kept for the
    // group statement export, and the position block never showed it. The block
    // shows the viewer's own bilateral pair, so that is what the card has to
    // match — and did not, reading ₹420 / ₹290 over a page saying ₹300 / ₹170.
    for (const uid of [ownerId, anaUser, benUser]) {
      const [c, g] = [await card(uid), await dash(uid)];
      const page = viewerPositionTotals(g.detailed, g.viewerParticipantId);
      expect({ uid, net: c.youNet, owed: c.youAreOwed, owe: c.youOwe }).toEqual({ uid, net: g.youNet, owed: page.receive, owe: page.pay });
    }
  });
});

describe("what must not have changed", () => {
  it("the settlement plan is still identical for every viewer", async () => {
    const shape = (uid: string) =>
      dash(uid).then((g) => g.suggestions.map((s) => ({ from: s.fromId, to: s.toId, amount: s.amount })));
    const [o, a, b] = await Promise.all([shape(ownerId), shape(anaUser), shape(benUser)]);
    expect(a).toEqual(o);
    expect(b).toEqual(o);
  });

  it("the members list is still identical for every viewer", async () => {
    const nets = (uid: string) =>
      dash(uid).then((g) => g.members.map((m) => ({ id: m.participantId, net: m.net })));
    const [o, a] = await Promise.all([nets(ownerId), nets(anaUser)]);
    expect(a).toEqual(o);
  });

  it("only the owner can still record settlements", async () => {
    expect((await dash(ownerId)).canRecordSettlements).toBe(true);
    expect((await dash(anaUser)).canRecordSettlements).toBe(false);
  });

  it("the members' balances still sum to the owner's own standing", async () => {
    const g = await dash(ownerId);
    const sum = g.members.filter((m) => m.participantId !== null).reduce((s, m) => s + m.net, 0);
    expect(sum).toBe(g.youNet);
  });
});
