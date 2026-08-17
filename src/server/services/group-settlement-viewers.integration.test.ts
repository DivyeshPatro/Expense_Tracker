// Group Settlement is ONE canonical group-wide state.
//
// A group's settlements used to be read with `where: { userId, groupId }` while
// its expenses were read with `where: { groupId }`. Since only the group owner
// can attach a groupId to a settlement (recordSettlement enforces it), that
// filter returned every row for the owner and NOTHING for a linked member — so
// the moment anyone paid anyone back, members kept seeing a plan that still
// demanded money that had already changed hands. Owner said Cara owed ₹1,000;
// every other member said ₹1,500.
//
// These tests open the same group as three different accounts and assert the
// economic answer is byte-identical: same payments, same directions, same
// amounts, same count, same total, same shareable text.

import { beforeAll, describe, expect, it } from "vitest";
import { parsePeriod } from "@/lib/period";
import { namedPlan, planTotal, settlementHeadline, shareSettlementText } from "@/lib/settlement-plan";
import { groupDashboard, type GroupDashboardData } from "./group-dashboard";
import { recordSettlement } from "./shared";
import { prisma } from "../db";

const OWNER_EMAIL = "gsv-owner@ledgerly.app";
const A_EMAIL = "gsv-member-a@ledgerly.app";
const B_EMAIL = "gsv-member-b@ledgerly.app";
const rup = (n: number) => Math.round(n * 100);
const ALL = parsePeriod({ p: "all" });

let ownerId: string;
let anaUserId: string;
let benUserId: string;
let groupId: string;
let anaPid: string;
let benPid: string;
let caraPid: string;

/** The group as one account sees it. */
const viewFor = async (userId: string) => (await groupDashboard(userId, groupId, ALL))!;

/** The economic answer, stripped of anything viewer-specific. */
const economics = (g: GroupDashboardData) => {
  const rows = namedPlan(g.suggestions, g.ownerName);
  return {
    payments: rows.map((r) => `${r.fromName} → ${r.toName} ${r.amount}`),
    count: rows.length,
    total: planTotal(rows),
    headline: settlementHeadline(rows.length),
    share: shareSettlementText({ groupName: g.name, headline: settlementHeadline(rows.length), rows, total: planTotal(rows) }),
  };
};

describe("Group Settlement is identical for every member", () => {
  beforeAll(async () => {
    for (const e of [OWNER_EMAIL, A_EMAIL, B_EMAIL]) {
      const ex = await prisma.user.findUnique({ where: { email: e } });
      if (ex) await prisma.user.delete({ where: { id: ex.id } });
    }
    const owner = await prisma.user.create({ data: { name: "Olivia", email: OWNER_EMAIL, emailVerified: true } });
    const ana = await prisma.user.create({ data: { name: "Ana Account", email: A_EMAIL, emailVerified: true } });
    const ben = await prisma.user.create({ data: { name: "Ben Account", email: B_EMAIL, emailVerified: true } });
    ownerId = owner.id;
    anaUserId = ana.id;
    benUserId = ben.id;

    const category = await prisma.category.create({ data: { userId: ownerId, name: "Trip", kind: "EXPENSE", icon: "🧳", color: "#0ea5e9" } });

    // Ana and Ben have real accounts linked to their participant rows; Cara
    // does not, which is the ordinary case and must keep working.
    anaPid = (await prisma.participant.create({ data: { ownerId, displayName: "Ana", linkedUserId: anaUserId } })).id;
    benPid = (await prisma.participant.create({ data: { ownerId, displayName: "Ben", linkedUserId: benUserId } })).id;
    caraPid = (await prisma.participant.create({ data: { ownerId, displayName: "Cara" } })).id;

    const group = await prisma.group.create({
      data: { name: "Manali", createdById: ownerId, members: { create: [{ participantId: anaPid }, { participantId: benPid }, { participantId: caraPid }] } },
    });
    groupId = group.id;

    const mk = (merchant: string, total: number, paidBy: string | null, shares: [string | null, number][]) =>
      prisma.transaction.create({
        data: {
          userId: ownerId, type: "EXPENSE", amount: rup(total), categoryId: category.id,
          merchant, occurredAt: new Date(), groupId, paidByParticipantId: paidBy,
          splits: { create: shares.map(([participantId, owed]) => ({ participantId, owedAmount: rup(owed) })) },
        },
      });
    const eq4 = (amt: number): [string | null, number][] => {
      const e = amt / 4;
      return [[null, e], [anaPid, e], [benPid, e], [caraPid, e]];
    };

    await mk("Hotel", 4000, null, eq4(4000)); //     the owner paid
    await mk("Petrol", 1200, anaPid, eq4(1200)); //  a MEMBER paid
    await mk("Dinner", 800, null, eq4(800)); //      the owner paid
    // The owner records that Cara has paid ₹500 back.
    await recordSettlement(ownerId, caraPid, "TO_OWNER", rup(500), "UPI", undefined, groupId);
  });

  it("the settlement really is attributed to the group and to the owner", async () => {
    const s = await prisma.settlement.findFirstOrThrow({ where: { groupId } });
    expect(s.groupId).toBe(groupId);
    // The invariant the group-scoped read relies on: only the owner can create
    // one of these, so reading by groupId alone can never widen visibility.
    expect(s.userId).toBe(ownerId);
  });

  it("every member can open the group", async () => {
    for (const uid of [ownerId, anaUserId, benUserId]) {
      expect(await groupDashboard(uid, groupId, ALL)).not.toBeNull();
    }
  });

  it("all three see the same settlement plan", async () => {
    const owner = economics(await viewFor(ownerId));
    const ana = economics(await viewFor(anaUserId));
    const ben = economics(await viewFor(benUserId));
    expect(ana).toEqual(owner);
    expect(ben).toEqual(owner);
  });

  it("the recorded settlement is reflected for members, not just the owner", async () => {
    for (const uid of [ownerId, anaUserId, benUserId]) {
      const g = await viewFor(uid);
      expect(g.settlements).toHaveLength(1);
      expect(g.settlements[0]).toMatchObject({ participantName: "Cara", direction: "TO_OWNER", amount: rup(500) });
      // Cara consumed 1000+300+200 = 1500 and has paid 500 back.
      expect(g.members.find((m) => m.name === "Cara")!.net).toBe(rup(1000));
    }
  });

  it("the payment count and total agree across viewers", async () => {
    const seen = new Set<string>();
    for (const uid of [ownerId, anaUserId, benUserId]) {
      const e = economics(await viewFor(uid));
      seen.add(`${e.count}|${e.total}|${e.headline}`);
    }
    expect(seen.size).toBe(1);
  });

  it("the shareable WhatsApp text is character-for-character the same", async () => {
    const owner = economics(await viewFor(ownerId)).share;
    expect(economics(await viewFor(anaUserId)).share).toBe(owner);
    expect(economics(await viewFor(benUserId)).share).toBe(owner);
    // and it names the owner rather than addressing whoever is reading it
    expect(owner).toContain("Olivia");
    expect(owner).not.toMatch(/\bYou\b/);
  });

  it("a member who paid is still credited, from every viewpoint", async () => {
    // Ana fronted ₹1,200 and consumed ₹300 of it, so she is owed ₹900 against
    // the ₹1,200 she owes on the owner's two bills → net ₹300 owed to the owner.
    for (const uid of [ownerId, anaUserId, benUserId]) {
      const g = await viewFor(uid);
      expect(g.members.find((m) => m.name === "Ana")!.net).toBe(rup(300));
    }
  });

  it("detailed obligations match across viewers too", async () => {
    const gross = async (uid: string) =>
      (await viewFor(uid)).gross.map((x) => `${x.name}:${x.owesYou}:${x.youOwe}`).sort();
    const owner = await gross(ownerId);
    expect(await gross(anaUserId)).toEqual(owner);
    expect(await gross(benUserId)).toEqual(owner);
  });

  it("member-to-member payments survive and are the same for everyone", async () => {
    // Give Ben a big outlay so he becomes a creditor: the plan must then route
    // another member straight to Ben rather than through the owner.
    const category = await prisma.category.findFirstOrThrow({ where: { userId: ownerId, kind: "EXPENSE" } });
    const tx = await prisma.transaction.create({
      data: {
        userId: ownerId, type: "EXPENSE", amount: rup(8000), categoryId: category.id,
        merchant: "Flights", occurredAt: new Date(), groupId, paidByParticipantId: benPid,
        splits: { create: [[null, 2000], [anaPid, 2000], [benPid, 2000], [caraPid, 2000]].map(([participantId, owed]) => ({ participantId: participantId as string | null, owedAmount: rup(owed as number) })) },
      },
    });

    const owner = economics(await viewFor(ownerId));
    expect(owner.payments.some((p) => !p.includes("Olivia"))).toBe(true); // a member→member hop exists
    expect(economics(await viewFor(anaUserId))).toEqual(owner);
    expect(economics(await viewFor(benUserId))).toEqual(owner);

    await prisma.expenseSplit.deleteMany({ where: { txId: tx.id } });
    await prisma.transaction.delete({ where: { id: tx.id } });
  });

  it("the owner sees themselves as 'You'; everyone else sees their name", async () => {
    const ownerRow = (g: GroupDashboardData) => g.members.find((m) => m.participantId === null)!;
    expect(ownerRow(await viewFor(ownerId)).name).toBe("You");
    expect(ownerRow(await viewFor(anaUserId)).name).toBe("Olivia");
    expect(ownerRow(await viewFor(benUserId)).name).toBe("Olivia");
    // and the avatar initial follows the name rather than staying "Y"
    expect(ownerRow(await viewFor(anaUserId)).initial).toBe("O");
  });

  it("the same rule applies to who paid an expense", async () => {
    const hotel = (g: GroupDashboardData) => g.expenses.find((e) => e.merchant === "Hotel")!;
    expect(hotel(await viewFor(ownerId)).paidByName).toBe("You");
    expect(hotel(await viewFor(anaUserId)).paidByName).toBe("Olivia");
  });

  it("only the owner is offered a way to record settlements", async () => {
    expect((await viewFor(ownerId)).canRecordSettlements).toBe(true);
    expect((await viewFor(anaUserId)).canRecordSettlements).toBe(false);
    expect((await viewFor(benUserId)).canRecordSettlements).toBe(false);
  });

  it("members get no settle prefill, because the write path would reject it", async () => {
    const owner = await viewFor(ownerId);
    expect(owner.suggestions.some((s) => s.settle)).toBe(true);
    for (const uid of [anaUserId, benUserId]) {
      expect((await viewFor(uid)).suggestions.every((s) => !s.settle)).toBe(true);
    }
  });

  it("a member attempting to record one is still refused by the service", async () => {
    // The UI hides the action; this is the rule it is hiding, asserted directly
    // so the two can never drift apart.
    await expect(recordSettlement(anaUserId, caraPid, "TO_OWNER", rup(100), "UPI", undefined, groupId)).rejects.toThrow();
  });

  it("hiding the action does not change the plan anyone sees", async () => {
    // The capability is presentational; the economics stay identical.
    const owner = economics(await viewFor(ownerId));
    expect(economics(await viewFor(anaUserId))).toEqual(owner);
    expect(economics(await viewFor(benUserId))).toEqual(owner);
  });

  it("a settlement in ANOTHER group still never leaks in", async () => {
    const other = await prisma.group.create({
      data: { name: "Other", createdById: ownerId, members: { create: [{ participantId: caraPid }] } },
    });
    const leak = await recordSettlement(ownerId, caraPid, "TO_OWNER", rup(999), "CASH", undefined, other.id).then(() =>
      prisma.settlement.findFirstOrThrow({ where: { groupId: other.id } })
    );
    for (const uid of [ownerId, anaUserId, benUserId]) {
      const g = await viewFor(uid);
      expect(g.settlements.some((s) => s.id === leak.id)).toBe(false);
      expect(g.settlements).toHaveLength(1);
    }
    await prisma.settlement.delete({ where: { id: leak.id } });
    await prisma.groupMember.deleteMany({ where: { groupId: other.id } });
    await prisma.group.delete({ where: { id: other.id } });
  });
});
