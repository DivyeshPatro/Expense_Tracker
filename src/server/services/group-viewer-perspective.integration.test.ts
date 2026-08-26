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

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parsePeriod } from "@/lib/period";
import { groupDashboard, listGroupSummaries } from "./group-dashboard";
import { recordMemberSettlement, recordSettlement } from "./shared";
import { OWNER_SENTINEL, SETTLED_THRESHOLD, viewerPosition, viewerPositionTotals } from "@/lib/group-dashboard";
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

/**
 * What the client computes for the "Your position" view — exactly as the
 * component does it: rows from viewerPosition() (threshold-filtered, because a
 * sub-rupee line is noise), totals from viewerPositionTotals() (unfiltered,
 * because dropping dust from the pair is the Srisailam bug). The two differ
 * only when dust exists.
 */
async function position(uid: string) {
  const g = await dash(uid);
  const me = meOf(g.viewerParticipantId);
  const { receive, pay } = viewerPosition(g.detailed, g.viewerParticipantId);
  const totals = viewerPositionTotals(g.detailed, g.viewerParticipantId);
  return { g, me, receive, pay, receiveTotal: totals.receive, payTotal: totals.pay };
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

// ── P1-1 / P1-2 ──────────────────────────────────────────────────────────────
//
// Position moved out of the settlement card into its own block above it, and
// the NET stat card went with it — that card stated the same net from a
// DIFFERENT derivation (gross over member nets: ₹420/₹290 where the
// obligations say ₹300/₹170), so leaving both would have put two "you'll get"
// figures on one page. These pin the single derivation and prove the plan
// itself is untouched by the move.

describe("P1: one derivation for the position block", () => {
  it("the block's three lines come from the obligations, and reconcile", async () => {
    for (const [uid, expected] of [
      [ownerId, STANDING.owner],
      [anaUser, STANDING.ana],
      [benUser, STANDING.ben],
    ] as const) {
      const { receiveTotal, payTotal } = await position(uid);
      expect({ uid, net: receiveTotal - payTotal }).toEqual({ uid, net: expected });
    }
  });

  it("the dashboard aggregate and the viewer's pair are different quantities", async () => {
    // Both are correct answers to different questions, and the page shows only
    // the second — which is why the NET stat card had to go rather than sit
    // above the position block stating ₹420 / ₹290 over its ₹300 / ₹170.
    //
    //   youAreOwed / youOwe — group-wide, over the member nets. The group
    //     statement export prints these above a members table they reconcile
    //     with cell by cell, so they stay as they were.
    //   viewerPositionTotals — this viewer's own bilateral pair, what the
    //     position block renders and what the group card must match.
    //
    // They net to the same figure and differ in their parts; nothing renders
    // both, and the card is pinned to the second below.
    const { g, receiveTotal, payTotal } = await position(ownerId);
    expect(g.youAreOwed - g.youOwe).toBe(receiveTotal - payTotal);
    expect(g.youAreOwed).not.toBe(receiveTotal);
  });

  it("the rows behind 'Who with?' sum to the two lines above them (no dust here)", async () => {
    // True because this fixture has no sub-rupee obligation. Where dust exists
    // the totals are deliberately larger than the visible rows — pinned in the
    // threshold-boundary block below.
    for (const uid of [ownerId, anaUser, benUser]) {
      const { receive, pay, receiveTotal, payTotal } = await position(uid);
      expect({ uid, r: receive.reduce((s, o) => s + o.amount, 0) }).toEqual({ uid, r: receiveTotal });
      expect({ uid, p: pay.reduce((s, o) => s + o.amount, 0) }).toEqual({ uid, p: payTotal });
    }
  });
});

describe("P1: the plan is unchanged by the reorder", () => {
  it("Simplify ON offers the same rows to every viewer", async () => {
    const plan = (uid: string) => dash(uid).then((g) => g.suggestions.map((x) => `${x.fromId}>${x.toId}:${x.amount}`));
    const [o, a, b] = await Promise.all([plan(ownerId), plan(anaUser), plan(benUser)]);
    expect(a).toEqual(o);
    expect(b).toEqual(o);
    expect(o.length).toBeGreaterThan(0);
  });

  it("Simplify OFF offers the same obligations to every viewer", async () => {
    const rows = (uid: string) =>
      dash(uid).then((g) =>
        g.detailed
          .filter((o) => o.amount > SETTLED_THRESHOLD)
          .map((x) => `${x.fromId}>${x.toId}:${x.amount}`)
          .sort()
      );
    const [o, a] = await Promise.all([rows(ownerId), rows(anaUser)]);
    expect(a).toEqual(o);
    expect(o.length).toBeGreaterThan(0);
  });

  it("every plan row is still actionable for the owner, none for a member", async () => {
    for (const s of (await dash(ownerId)).suggestions) expect(Boolean(s.settle || s.settleMembers)).toBe(true);
    for (const s of (await dash(anaUser)).suggestions) expect(Boolean(s.settle || s.settleMembers)).toBe(false);
  });

  it("member-to-member rows survive with both ends and a way to record them", async () => {
    const memberRows = (await dash(ownerId)).suggestions.filter((x) => !x.involvesYou);
    expect(memberRows.length).toBeGreaterThan(0);
    for (const r of memberRows) {
      expect(r.settleMembers).toBeDefined();
      expect({ from: r.settleMembers!.fromParticipantId, to: r.settleMembers!.toParticipantId }).toEqual({ from: r.fromId, to: r.toId });
    }
  });

  it("owner-directed rows keep their direction prefill", async () => {
    const ownerRows = (await dash(ownerId)).suggestions.filter((x) => x.involvesYou);
    expect(ownerRows.length).toBeGreaterThan(0);
    for (const r of ownerRows) expect(["TO_OWNER", "FROM_OWNER"]).toContain(r.settle!.direction);
  });
});

describe("P1: the group card agrees with the page it opens", () => {
  // The earlier version of this block asserted the NET only, and passed for
  // months while the two surfaces disagreed about its parts: the card summed
  // member nets (₹420 / ₹290 for the owner) and the page filtered the
  // obligations (₹300 / ₹170). A member had it worse — the card said
  // "you'll pay ₹0" over a page asking them for ₹160. Net was equal the whole
  // time, so netting alone never proved anything. Assert the parts.
  //
  // The fixture is what gives these teeth: three distinct standings
  // (+₹130 / +₹290 / −₹100), one unequal split, and real member↔member debts
  // from Ana and Ben each fronting a bill. The abandoned owner-centric
  // aggregate cannot reproduce these numbers.
  const card = async (uid: string) => (await listGroupSummaries(uid)).find((x) => x.id === groupId)!;

  it.each([
    ["the owner", () => ownerId, STANDING.owner],
    ["Ana, a member who is owed", () => anaUser, STANDING.ana],
    ["Ben, a member who owes", () => benUser, STANDING.ben],
  ])("%s sees one set of figures on both surfaces", async (_who, uid, standing) => {
    const c = await card(uid());
    const { receiveTotal, payTotal, g } = await position(uid());

    // 1. The card states what the page states.
    expect({ owed: c.youAreOwed, owe: c.youOwe, net: c.youNet }).toEqual({
      owed: receiveTotal,
      owe: payTotal,
      net: g.youNet,
    });

    // 2. Both surfaces reconcile against the viewer's standing, independently.
    expect(c.youAreOwed - c.youOwe).toBe(standing);
    expect(receiveTotal - payTotal).toBe(standing);

    // 3. Net itself is unchanged by the fix - still standingOf()'s answer.
    expect(c.youNet).toBe(standing);
    expect(g.youNet).toBe(standing);
  });

  it("the three viewers really do see different figures", async () => {
    // Guards the fixture, not the code: if every viewer had the same position,
    // the assertions above would hold even with the viewer ignored entirely.
    const cards = await Promise.all([ownerId, anaUser, benUser].map((u) => card(u)));
    const shapes = cards.map((c) => `${c.youAreOwed}/${c.youOwe}`);
    expect(new Set(shapes).size).toBe(3);
  });

  it("a member's pay side is a real figure, not max(-net, 0)", async () => {
    // The specific shape of the old bug: Ana is owed on balance, so the
    // discarded derivation reported youOwe = 0 for her. She does owe Cara.
    const c = await card(anaUser);
    expect(c.youOwe).toBeGreaterThan(0);
    expect(c.youAreOwed).toBeGreaterThan(c.youOwe);
  });
});

// ── Dust, and the ₹1.00 threshold ────────────────────────────────────────────
//
// Two different questions, deliberately answered by two different rules:
//
//   • WHAT IS WORTH LISTING — viewerPosition() drops rows at or under
//     SETTLED_THRESHOLD, because a 40-paise line is noise in a list.
//   • WHAT IS WORTH COUNTING — viewerPositionTotals() counts everything.
//
// The totals must count dust or the card stops adding up. That is not
// hypothetical: Srisailam shipped reading "You'll get ₹1.33 · You'll pay ₹0 ·
// Net +₹0.31", because the pair skipped every balance inside the threshold and
// ₹1.02 of it survived only in the net. group-aggregate-reconciliation.test.ts
// defends the identity; these pin it end-to-end, through the real read model,
// at the amounts where the two rules disagree.
describe("dust is hidden from the rows but never from the totals", () => {
  const DUST_EMAIL = "dust-boundary@ledgerly.app";
  let dustOwner = "", dustMemberUser = "";

  /**
   * A group whose only imbalances are `owedPaise` — one entry per member, each
   * owing the owner that many paise. Several small entries let a sum cross the
   * threshold while every part stays under it.
   */
  async function groupOwing(...owedPaise: number[]) {
    for (const e of [DUST_EMAIL, `m-${DUST_EMAIL}`]) {
      const ex = await prisma.user.findUnique({ where: { email: e } });
      if (ex) await prisma.user.delete({ where: { id: ex.id } });
    }
    dustOwner = (await prisma.user.create({ data: { name: "O", email: DUST_EMAIL, emailVerified: true } })).id;
    dustMemberUser = (await prisma.user.create({ data: { name: "M", email: `m-${DUST_EMAIL}`, emailVerified: true } })).id;
    const mk = async (n: string, linkedUserId?: string) =>
      (await prisma.participant.create({ data: { ownerId: dustOwner, displayName: n, linkedUserId } })).id;
    // The first member is the one who can open the group themselves.
    const pids = await Promise.all(owedPaise.map((_, i) => mk(`M${i}`, i === 0 ? dustMemberUser : undefined)));
    const gid = (
      await prisma.group.create({
        data: { name: "Dust", createdById: dustOwner, members: { create: pids.map((participantId) => ({ participantId })) } },
      })
    ).id;
    // The owner fronts the bill; each member's share is the amount they owe.
    const total = owedPaise.reduce((t, n) => t + n, 0) + rup(50);
    await prisma.transaction.create({
      data: {
        userId: dustOwner, type: "EXPENSE", amount: total, merchant: "Tea",
        occurredAt: new Date("2026-08-05T06:30:00.000Z"), groupId: gid, paidByParticipantId: null,
        splits: {
          create: [
            { participantId: null, owedAmount: rup(50) },
            ...pids.map((participantId, i) => ({ participantId, owedAmount: owedPaise[i] })),
          ],
        },
      },
    });
    return gid;
  }

  /** Owner's position and card for the group just built. */
  async function surfaces(gid: string, uid: string) {
    const g = (await groupDashboard(uid, gid, ALL))!;
    const rows = viewerPosition(g.detailed, g.viewerParticipantId);
    const totals = viewerPositionTotals(g.detailed, g.viewerParticipantId);
    const card = (await listGroupSummaries(uid)).find((x) => x.id === gid)!;
    return { g, rows, totals, card };
  }

  afterEach(async () => {
    for (const id of [dustOwner, dustMemberUser]) {
      if (id) await prisma.user.delete({ where: { id } }).catch(() => {});
    }
  });

  it.each([
    ["₹0.40 — under the threshold", [40], 0, 40],
    ["four × ₹0.40 — each under it, ₹1.60 together", [40, 40, 40, 40], 0, 160],
    ["exactly ₹1.00 — the boundary itself", [SETTLED_THRESHOLD], 0, 100],
    ["₹1.01 — one paise over", [SETTLED_THRESHOLD + 1], 1, 101],
    ["a normal ₹250 balance", [rup(250)], 1, rup(250)],
  ])("%s", async (_label, owed, visibleRows, expectedTotal) => {
    const gid = await groupOwing(...(owed as number[]));
    const { rows, totals, card } = await surfaces(gid, dustOwner);

    // Rows: only what is worth listing.
    expect(rows.receive.length).toBe(visibleRows);
    // Totals: every paise, whether or not it earned a row.
    expect(totals.receive).toBe(expectedTotal);
    expect(totals.pay).toBe(0);
    // And the card states the same pair the page does.
    expect({ owed: card.youAreOwed, owe: card.youOwe }).toEqual({ owed: totals.receive, owe: totals.pay });
  });

  it("receive − pay === standing at every one of those amounts", async () => {
    // The identity the Srisailam fix exists to protect, asserted through the
    // read model rather than the pure function.
    for (const owed of [[40], [40, 40, 40, 40], [SETTLED_THRESHOLD], [SETTLED_THRESHOLD + 1], [rup(250)]]) {
      const gid = await groupOwing(...owed);
      for (const uid of [dustOwner, dustMemberUser]) {
        const { g, totals, card } = await surfaces(gid, uid);
        expect({ owed, uid, diff: totals.receive - totals.pay }).toEqual({ owed, uid, diff: g.youNet });
        expect({ owed, uid, diff: card.youAreOwed - card.youOwe }).toEqual({ owed, uid, diff: card.youNet });
      }
      await prisma.user.delete({ where: { id: dustOwner } }).catch(() => {});
      await prisma.user.delete({ where: { id: dustMemberUser } }).catch(() => {});
    }
  });

  it("the ₹1.00 row is still offered by the settlement plan", async () => {
    // Unchanged semantics, pinned so a later pass has to change it on purpose:
    // the position block treats exactly ₹1.00 as not worth listing, while
    // computeSuggestions() minimises at threshold 0 and still offers it. The
    // two filters disagree at exactly this amount, by design.
    const gid = await groupOwing(SETTLED_THRESHOLD);
    const { g, rows, totals } = await surfaces(gid, dustOwner);
    expect(rows.receive.length).toBe(0);
    expect(totals.receive).toBe(SETTLED_THRESHOLD);
    expect(g.suggestions.length).toBe(1);
    expect(g.suggestions[0].amount).toBe(SETTLED_THRESHOLD);
  });
});

// ── A zero net does NOT mean every obligation is discharged ──────────────────
//
// Documented, deliberately NOT fixed here. Settling through the owner squares
// everyone's net without discharging the member↔member obligations it
// economically settled, so a residual zero-sum cycle survives in the
// obligation graph. The group then reports every member at ₹0 and an empty
// settlement plan, while the viewer's own position still shows real gross
// figures on both sides.
//
// Hiding that (e.g. zeroing the pair whenever |standing| <= threshold) would
// conceal obligations that genuinely exist, so the position stays honest and
// the mismatch is written down instead. Fixing it means changing how
// settlements discharge obligations — a separate pass.
describe("a squared group can still carry gross bilateral obligations", () => {
  const CYCLE_EMAIL = "settled-cycle@ledgerly.app";
  let cycleOwner = "", cycleGroup = "";

  beforeAll(async () => {
    const ex = await prisma.user.findUnique({ where: { email: CYCLE_EMAIL } });
    if (ex) await prisma.user.delete({ where: { id: ex.id } });
    cycleOwner = (await prisma.user.create({ data: { name: "O", email: CYCLE_EMAIL, emailVerified: true } })).id;
    const mk = async (n: string) => (await prisma.participant.create({ data: { ownerId: cycleOwner, displayName: n } })).id;
    const [p1, p2, p3] = [await mk("A"), await mk("B"), await mk("C")];
    cycleGroup = (
      await prisma.group.create({
        data: { name: "Cycle", createdById: cycleOwner, members: { create: [p1, p2, p3].map((participantId) => ({ participantId })) } },
      })
    ).id;
    // A fronts a bill for everyone, so the debts owed run member→member.
    await prisma.transaction.create({
      data: {
        userId: cycleOwner, type: "EXPENSE", amount: rup(400), merchant: "Hotel",
        occurredAt: new Date("2026-08-05T06:30:00.000Z"), groupId: cycleGroup, paidByParticipantId: p1,
        splits: { create: [
          { participantId: null, owedAmount: rup(100) },
          { participantId: p1, owedAmount: rup(100) },
          { participantId: p2, owedAmount: rup(100) },
          { participantId: p3, owedAmount: rup(100) },
        ] },
      },
    });
    // Everyone settles THROUGH the owner rather than with A directly.
    await recordSettlement(cycleOwner, p1, "FROM_OWNER", rup(300), "CASH", undefined, cycleGroup);
    await recordSettlement(cycleOwner, p2, "TO_OWNER", rup(100), "CASH", undefined, cycleGroup);
    await recordSettlement(cycleOwner, p3, "TO_OWNER", rup(100), "CASH", undefined, cycleGroup);
  });

  it("every member nets to zero and the plan is empty", async () => {
    const g = (await groupDashboard(cycleOwner, cycleGroup, ALL))!;
    for (const m of g.members) expect({ who: m.name, net: m.net }).toEqual({ who: m.name, net: 0 });
    expect(g.suggestions.length).toBe(0);
    expect(g.youNet).toBe(0);
  });

  it("yet the viewer's position still reports gross obligations on both sides", async () => {
    // THE KNOWN ISSUE. If this ever reads 0/0, check WHY before updating it:
    // discharging the obligations properly is the fix, concealing them is not.
    const g = (await groupDashboard(cycleOwner, cycleGroup, ALL))!;
    const totals = viewerPositionTotals(g.detailed, g.viewerParticipantId);
    expect(totals.receive).toBeGreaterThan(0);
    expect(totals.pay).toBeGreaterThan(0);
    // Honest in the only sense that matters for the summary: it still nets right.
    expect(totals.receive - totals.pay).toBe(g.youNet);
  });

  it("the group statement export keeps the group-wide aggregate, unaffected", async () => {
    // youAreOwed/youOwe on the dashboard are NOT the viewer's bilateral pair —
    // the export prints them above a members table it must reconcile with, so
    // they stay the aggregate over member nets. A squared group exports 0/0.
    const g = (await groupDashboard(cycleOwner, cycleGroup, ALL))!;
    expect({ owed: g.youAreOwed, owe: g.youOwe }).toEqual({ owed: 0, owe: 0 });
  });
});
