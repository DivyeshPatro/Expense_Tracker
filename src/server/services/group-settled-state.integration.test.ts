// The `settled` flag and the card's three numbers, exercised through the real
// service rather than a restatement of the rule.
//
// A unit test that re-implements the predicate proves only that the test agrees
// with itself: the version of these checks written against a local helper
// happily passed while `settled` was `Math.abs(youNet) <= SETTLED_THRESHOLD`,
// the rule that calls a group settled when ₹600 owed to you and ₹600 owed by
// you cancel out. These go through listGroupSummaries and groupDashboard, so
// they fail if the production rule changes.

import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../db";
import { addExpense } from "./transactions";
import { groupDashboard, listGroupSummaries } from "./group-dashboard";
import { recordSettlement } from "./shared";
import { parsePeriod } from "@/lib/period";
import { currentMonthKey } from "@/lib/dates";

const EMAIL = "group-settled-state@ledgerly.app";
const YMD = `${currentMonthKey()}-05`;

let userId: string, accountId: string, categoryId: string;
let ana: string, ben: string;
let offsettingId: string, dustId: string, owedId: string;

beforeAll(async () => {
  const ex = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (ex) await prisma.user.delete({ where: { id: ex.id } });
  userId = (await prisma.user.create({ data: { name: "Owner", email: EMAIL, emailVerified: true } })).id;
  accountId = (await prisma.account.create({ data: { userId, name: "Cash", type: "CASH" } })).id;
  categoryId = (await prisma.category.create({ data: { userId, name: "Travel", kind: "EXPENSE" } })).id;
  const mk = async (n: string) => (await prisma.participant.create({ data: { ownerId: userId, displayName: n } })).id;
  ana = await mk("Ana");
  ben = await mk("Ben");

  const mkGroup = async (name: string) =>
    (await prisma.group.create({ data: { name, createdById: userId, members: { create: [{ participantId: ana }, { participantId: ben }] } } })).id;
  offsettingId = await mkGroup("Offsetting");
  dustId = await mkGroup("Dust");
  owedId = await mkGroup("Owed");

  /** An equal two-way split between the owner and one friend: each side takes
   *  half, so `half` is exactly what that friend's balance moves by. */
  const twoWay = (merchant: string, groupId: string, friend: string, half: number, payer: string | null) =>
    addExpense(userId, {
      amount: half * 2,
      accountId,
      categoryId,
      merchant,
      date: YMD,
      groupId,
      split: { mode: "EQUAL", participantIds: [friend], payerParticipantId: payer },
    });

  // Ana owes ₹600 and Ben is owed ₹600: a net of zero with ₹1,200 outstanding.
  await twoWay("Ana's half", offsettingId, ana, 60_000, null);
  await twoWay("Ben fronted", offsettingId, ben, 60_000, ben);

  // Rounding residue only — 40 paise each way.
  await twoWay("Residue", dustId, ana, 40, null);
  await twoWay("Residue back", dustId, ben, 40, ben);

  // One real balance sitting beside dust.
  await twoWay("Trip", owedId, ana, 25_000, null);
  await twoWay("Rounding", owedId, ben, 34, null);
});

describe("a group is settled when no PERSON owes anything worth acting on", () => {
  const find = async (name: string) => (await listGroupSummaries(userId)).find((g) => g.name === name)!;

  it("₹600 each way nets to zero but is NOT settled", async () => {
    const g = await find("Offsetting");
    expect(g.youNet).toBe(0); // the trap: a net-based rule would call this settled
    expect(g.youAreOwed).toBe(60_000);
    expect(g.youOwe).toBe(60_000);
    expect(g.settled).toBe(false);
  });

  it("sub-rupee residue on both sides IS settled", async () => {
    const g = await find("Dust");
    expect(g.settled).toBe(true);
    // and the dust is still reported rather than silently dropped
    expect(g.youAreOwed).toBe(40);
    expect(g.youOwe).toBe(40);
  });

  it("one real balance beside dust is not settled", async () => {
    const g = await find("Owed");
    expect(g.settled).toBe(false);
    expect(g.youAreOwed).toBe(25_034);
  });
});

describe("You'll get − You'll pay = Net, everywhere the aggregate is shown", () => {
  it("holds on every group card", async () => {
    const summaries = await listGroupSummaries(userId);
    expect(summaries.length).toBeGreaterThan(0);
    for (const g of summaries) {
      expect({ group: g.name, diff: g.youAreOwed - g.youOwe }).toEqual({ group: g.name, diff: g.youNet });
    }
  });

  it("the card and the group detail page report the same three numbers", async () => {
    // They call computeMemberBalances separately; the export sheet reads its
    // "You are owed"/"You owe" rows straight off the dashboard, so agreeing
    // here is what makes all three surfaces agree.
    for (const g of await listGroupSummaries(userId)) {
      const dash = (await groupDashboard(userId, g.id, parsePeriod({ p: "all" })))!;
      expect({ owed: dash.youAreOwed, owe: dash.youOwe, net: dash.youNet }).toEqual({ owed: g.youAreOwed, owe: g.youOwe, net: g.youNet });
    }
  });

  it("still holds after an owner↔member settlement", async () => {
    await recordSettlement(userId, ana, "TO_OWNER", 30_000, "CASH", undefined, offsettingId);
    const g = (await listGroupSummaries(userId)).find((x) => x.name === "Offsetting")!;
    expect(g.youAreOwed - g.youOwe).toBe(g.youNet);
    expect(g.youAreOwed).toBe(30_000); // Ana's remainder
    expect(g.settled).toBe(false);
  });
});
