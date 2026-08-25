// "You" means the person reading the page (P0 · CH-1…CH-4).
//
// The settlement section's personal view was hardcoded to flow to the group's
// creator — `toId: OWNER_ID` — so every member read the OWNER's receivables
// under a first-person label. The member rows did the same in words: the
// owner's row was chipped as the reader's, and other rows said "will pay you"
// about a debt that goes to whoever fronted the bill.
//
// No new arithmetic. computeDetailedObligations already produces true bilateral
// pairs between any two people — the debtor is whoever shared a bill, the
// creditor is whoever paid it, and neither has to be the owner. So the viewer's
// two lists are a FILTER over that, and their difference is the viewer's net by
// construction:
//
//     Σ(owed to me) − Σ(owed by me)  ==  paid_me − share_me  ==  standingOf(me)
//
// FIXTURE RULE, learned the hard way: every viewer must land on a DIFFERENT
// number and at least one split must be unequal. An earlier viewer-perspective
// fixture gave three people the same balance, and the whole suite passed with
// the bug reinstated.

import { beforeAll, describe, expect, it } from "vitest";
import { parsePeriod } from "@/lib/period";
import { groupDashboard } from "./group-dashboard";
import { recordMemberSettlement } from "./shared";
import { OWNER_SENTINEL, SETTLED_THRESHOLD } from "@/lib/group-dashboard";
import { prisma } from "../db";

const EMAIL = "viewer-perspective@ledgerly.app";
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
/** The viewer's id in obligation space, exactly as the client maps it. */
const meOf = (v: string | null) => v ?? OWNER_SENTINEL;

beforeAll(async () => {
  for (const e of [EMAIL, `ana-${EMAIL}`, `ben-${EMAIL}`]) {
    const ex = await prisma.user.findUnique({ where: { email: e } });
    if (ex) await prisma.user.delete({ where: { id: ex.id } });
  }
  ownerId = (await prisma.user.create({ data: { name: "Owner", email: EMAIL, emailVerified: true } })).id;
  anaUser = (await prisma.user.create({ data: { name: "Ana", email: `ana-${EMAIL}`, emailVerified: true } })).id;
  benUser = (await prisma.user.create({ data: { name: "Ben", email: `ben-${EMAIL}`, emailVerified: true } })).id;
  const mk = async (n: string, linkedUserId?: string) => (await prisma.participant.create({ data: { ownerId, displayName: n, linkedUserId } })).id;
  ana = await mk("Ana", anaUser);
  ben = await mk("Ben", benUser);
  cara = await mk("Cara");
  groupId = (
    await prisma.group.create({
      data: { name: "Trip", createdById: ownerId, members: { create: [ana, ben, cara].map((participantId) => ({ participantId })) } },
    })
  ).id;

  //            paid    share                standing (paid − share)
  //  owner      400     100+150+20 = 270      +130
  //  Ana        600     100+150+60 = 310      +290
  //  Ben        200     100+150+50 = 300      −100
  //  Cara         0     100+150+70 = 320      −320
  //
  // Ana and Ben each front a bill, so real member→member debts exist — the
  // shape in which an owner-framed list is provably wrong. The third split is
  // unequal so no two people can be confused for one another.
  await expense(400, null, [[null, 100], [ana, 100], [ben, 100], [cara, 100]]);
  await expense(600, ana, [[null, 150], [ana, 150], [ben, 150], [cara, 150]]);
  await expense(200, ben, [[null, 20], [ana, 60], [ben, 50], [cara, 70]]);
});

const STANDING = { owner: rup(130), ana: rup(290), ben: rup(-100) };

/** What the client computes for the "Your position" view. */
async function position(uid: string) {
  const g = await dash(uid);
  const me = meOf(g.viewerParticipantId);
  const receive = g.detailed.filter((o) => o.toId === me && o.amount > SETTLED_THRESHOLD);
  const pay = g.detailed.filter((o) => o.fromId === me && o.amount > SETTLED_THRESHOLD);
  const sum = (rows: typeof receive) => rows.reduce((s, o) => s + o.amount, 0);
  return { g, me, receive, pay, receiveTotal: sum(receive), payTotal: sum(pay) };
}

describe("the viewer's identity is resolved, not assumed", () => {
  it("the owner is null; each linked member is their own participant", async () => {
    expect((await dash(ownerId)).viewerParticipantId).toBeNull();
    expect((await dash(anaUser)).viewerParticipantId).toBe(ana);
    expect((await dash(benUser)).viewerParticipantId).toBe(ben);
  });

  it("identity is not the same thing as capability", async () => {
    // Ana has an identity in this group and no permission to record. Deriving
    // "who am I" from canRecordSettlements is what made the labels lie.
    const g = await dash(anaUser);
    expect(g.viewerParticipantId).toBe(ana);
    expect(g.canRecordSettlements).toBe(false);
  });
});

describe("I'll receive / I'll pay are the viewer's own", () => {
  it("every row in either list has the viewer as a party", async () => {
    for (const uid of [ownerId, anaUser, benUser]) {
      const { me, receive, pay } = await position(uid);
      for (const o of receive) expect({ uid, to: o.toId }).toEqual({ uid, to: me });
      for (const o of pay) expect({ uid, from: o.fromId }).toEqual({ uid, from: me });
    }
  });

  it("the identity holds for every viewer: receive − pay = net", async () => {
    for (const [uid, expected] of [
      [ownerId, STANDING.owner],
      [anaUser, STANDING.ana],
      [benUser, STANDING.ben],
    ] as const) {
      const { g, receiveTotal, payTotal } = await position(uid);
      expect({ uid, diff: receiveTotal - payTotal }).toEqual({ uid, diff: expected });
      expect({ uid, net: g.youNet }).toEqual({ uid, net: expected });
    }
  });

  it("three viewers, three different answers", async () => {
    const [o, a, b] = await Promise.all([position(ownerId), position(anaUser), position(benUser)]);
    const nets = [o, a, b].map((p) => p.receiveTotal - p.payTotal);
    expect(new Set(nets).size).toBe(3);
    // and the lists themselves differ, not merely the totals
    expect(a.receive.map((r) => r.fromId)).not.toEqual(o.receive.map((r) => r.fromId));
  });

  it("a member is on BOTH sides at once, and the two are his own", async () => {
    // Ben owes the owner ₹100 (bill 1) and Ana ₹150 (bill 2) = ₹250 out.
    // He fronted bill 3, so ₹20 + ₹60 + ₹70 = ₹150 is owed to him.
    // 150 − 250 = −100, his standing. An owner-framed list could show neither.
    const { receive, pay, receiveTotal, payTotal } = await position(benUser);
    expect({ receive: receiveTotal, pay: payTotal }).toEqual({ receive: rup(150), pay: rup(250) });
    expect(receiveTotal - payTotal).toBe(STANDING.ben);
    expect(pay.map((o) => o.toId).sort()).toEqual([ana, OWNER_SENTINEL].sort());
    expect(receive.every((o) => o.toId === ben)).toBe(true);
  });

  it("no viewer's list is the owner's list, unless they are the owner", async () => {
    const owner = await position(ownerId);
    for (const uid of [anaUser, benUser]) {
      const p = await position(uid);
      expect({ uid, same: p.receiveTotal === owner.receiveTotal && p.payTotal === owner.payTotal }).toEqual({ uid, same: false });
    }
  });
});

describe("obligations are attributed to the right pair", () => {
  it("a debt to a member who fronted a bill is addressed to THEM, not the owner", async () => {
    const g = await dash(ownerId);
    const toAna = g.detailed.filter((o) => o.toId === ana);
    expect(toAna.length).toBeGreaterThan(0);
    expect(toAna.some((o) => o.fromId === ben || o.fromId === cara)).toBe(true);
  });

  it("owner↔member obligations exist alongside member↔member ones", async () => {
    const g = await dash(ownerId);
    expect(g.detailed.some((o) => o.fromId === OWNER_SENTINEL || o.toId === OWNER_SENTINEL)).toBe(true);
    expect(g.detailed.some((o) => o.fromId !== OWNER_SENTINEL && o.toId !== OWNER_SENTINEL)).toBe(true);
  });

  it("a recorded member→member settlement moves both of their lists and neither of the owner's", async () => {
    const before = await position(ownerId);
    const pair = (await dash(ownerId)).detailed.find((o) => o.fromId === cara && o.toId === ana)!;
    await recordMemberSettlement(ownerId, cara, ana, pair.amount, "CASH", undefined, groupId);

    const [after, anaAfter] = await Promise.all([position(ownerId), position(anaUser)]);
    expect(after.receiveTotal - after.payTotal).toBe(before.receiveTotal - before.payTotal);
    expect(anaAfter.receive.some((o) => o.fromId === cara)).toBe(false);
    // and it is a settlement, never an expense
    const s = await prisma.settlement.findFirstOrThrow({ where: { groupId, fromParticipantId: cara } });
    expect({ from: s.fromParticipantId, to: s.toParticipantId, legacy: s.participantId, dir: s.direction }).toEqual({
      from: cara,
      to: ana,
      legacy: null,
      dir: null,
    });
    // clean up so later assertions read the original fixture
    await prisma.settlement.delete({ where: { id: s.id } });
  });
});

describe("what must not have changed", () => {
  it("the group plan is still identical for every viewer", async () => {
    const shape = (uid: string) => dash(uid).then((g) => g.suggestions.map((s) => ({ from: s.fromId, to: s.toId, amount: s.amount })));
    const [o, a, b] = await Promise.all([shape(ownerId), shape(anaUser), shape(benUser)]);
    expect(a).toEqual(o);
    expect(b).toEqual(o);
  });

  it("the members list is still identical for every viewer", async () => {
    const nets = (uid: string) => dash(uid).then((g) => g.members.map((m) => ({ id: m.participantId, net: m.net })));
    expect(await nets(anaUser)).toEqual(await nets(ownerId));
  });

  it("dust below the threshold is still excluded, unchanged", async () => {
    const { receive, pay } = await position(ownerId);
    for (const o of [...receive, ...pay]) expect(o.amount).toBeGreaterThan(SETTLED_THRESHOLD);
  });

  it("only the owner may record", async () => {
    expect((await dash(ownerId)).canRecordSettlements).toBe(true);
    expect((await dash(anaUser)).canRecordSettlements).toBe(false);
  });
});
