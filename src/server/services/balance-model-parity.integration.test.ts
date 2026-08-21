// The per-friend list and the group cards must answer with the same numbers.
//
// They didn't. computeMemberBalances was fixed years-of-commits ago against a
// real Splitwise export: a friend who fronts a ₹1,240 bill split five ways has
// consumed ₹248 and is owed ₹992. netBalances kept the older rule, which
// credited a non-owner payer with the OWNER's share alone — ₹248 — and left the
// other ₹744 attached to them as debt.
//
// It survived because every fixture that asserted netBalances had the OWNER pay
// (paidByParticipantId: null), the one case both rules agree on. The bug only
// appears when a member pays, so that is what these tests do.
//
// Live symptom: a group card reading SETTLED while the same four people showed
// ₹248, ₹248, ₹248 and ₹744 in the per-person list — one debt cycle summing to
// zero, counted from the wrong end.

import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../db";
import { addExpense } from "./transactions";
import { netBalances, recordSettlement } from "./shared";
import { groupDashboard } from "./group-dashboard";
import { parsePeriod } from "@/lib/period";
import { currentMonthKey } from "@/lib/dates";

const EMAIL = "balance-parity@ledgerly.app";
const YMD = `${currentMonthKey()}-05`;
const BILL = 124_000; // ₹1,240 — five ways, ₹248 each, no remainder
const SHARE = BILL / 5;

let userId: string, accountId: string, categoryId: string, groupId: string;
let ana: string, ben: string, cara: string, dan: string;

const netOf = async (pid: string) => (await netBalances(userId)).find((p) => p.id === pid)!.net;

beforeAll(async () => {
  const ex = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (ex) await prisma.user.delete({ where: { id: ex.id } });
  userId = (await prisma.user.create({ data: { name: "Owner", email: EMAIL, emailVerified: true } })).id;
  accountId = (await prisma.account.create({ data: { userId, name: "Cash", type: "CASH" } })).id;
  categoryId = (await prisma.category.create({ data: { userId, name: "Travel", kind: "EXPENSE" } })).id;
  const mk = async (n: string) => (await prisma.participant.create({ data: { ownerId: userId, displayName: n } })).id;
  ana = await mk("Ana");
  ben = await mk("Ben");
  cara = await mk("Cara");
  dan = await mk("Dan");
  groupId = (
    await prisma.group.create({
      data: { name: "Trip", createdById: userId, members: { create: [ana, ben, cara, dan].map((participantId) => ({ participantId })) } },
    })
  ).id;

  const bill = (merchant: string, payer: string | null) =>
    addExpense(userId, {
      amount: BILL,
      accountId,
      categoryId,
      merchant,
      date: YMD,
      groupId,
      split: { mode: "EQUAL", participantIds: [ana, ben, cara, dan], payerParticipantId: payer },
    });

  await bill("You paid", null); // owner fronts one
  await bill("Ana paid", ana); // and a member fronts one — the case that was wrong
});

describe("a member who fronts a bill is credited what they actually put in", () => {
  it("Ana is owed ₹992, not ₹248", async () => {
    // She put up ₹1,240 and consumed ₹248 of it across the two bills:
    // owes 248 + 248 = 496, paid 1240 → net −744.
    // The old rule credited her only the owner's ₹248 share, giving 0.
    expect(await netOf(ana)).toBe(2 * SHARE - BILL); // −74_400 = −₹744
  });

  it("the others owe their two shares", async () => {
    for (const pid of [ben, cara, dan]) expect(await netOf(pid)).toBe(2 * SHARE); // +₹496
  });

  it("the balances sum to the owner's own position", async () => {
    // Σ(owes − paid) over everyone is zero, so the friends' total is exactly
    // what the owner is owed. This is the identity the group card relies on.
    const all = await netBalances(userId);
    const sum = all.reduce((s, p) => s + p.net, 0);
    expect(sum).toBe(BILL - 2 * SHARE); // owner paid 1240, consumed 496 → owed ₹744
  });
});

describe("the per-friend list and the group dashboard agree", () => {
  it("every friend's balance matches their group member net", async () => {
    // This user's only splits are in this group, so the two views cover the
    // same expenses and must produce identical numbers.
    const list = await netBalances(userId);
    const g = (await groupDashboard(userId, groupId, parsePeriod({ p: "all" })))!;
    for (const m of g.members.filter((x) => x.participantId !== null)) {
      const person = list.find((p) => p.id === m.participantId)!;
      expect({ who: m.name, net: person.net }).toEqual({ who: m.name, net: m.net });
    }
  });
});

describe("settling the group empties the per-person list", () => {
  it("nobody is left owing anything once the group is square", async () => {
    // The reported symptom: SETTLED on the card, four amounts still listed.
    await recordSettlement(userId, ana, "FROM_OWNER", BILL - 2 * SHARE, "CASH", undefined, groupId);
    for (const pid of [ben, cara, dan]) {
      await recordSettlement(userId, pid, "TO_OWNER", 2 * SHARE, "CASH", undefined, groupId);
    }

    for (const p of await netBalances(userId)) expect({ who: p.name, net: p.net }).toEqual({ who: p.name, net: 0 });

    const g = (await groupDashboard(userId, groupId, parsePeriod({ p: "all" })))!;
    expect({ owed: g.youAreOwed, owe: g.youOwe, net: g.youNet }).toEqual({ owed: 0, owe: 0, net: 0 });
  });
});
