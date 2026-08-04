// Database-backed tests for the Group Dashboard read model: balances, overview,
// period-scoped spending, settlement history and per-group activity ids, plus
// the visibility rule. Run with `npm run test:integration`.

import { beforeAll, describe, expect, it } from "vitest";
import { currentMonthKey, istNoon } from "@/lib/dates";
import { parsePeriod } from "@/lib/period";
import { groupDashboard } from "./group-dashboard";
import { addGroupMember, removeGroupMember } from "./groups";
import { deleteSettlement } from "./shared";
import { activityPage } from "./activity";
import { prisma } from "../db";

const EMAIL = "group-dash-test@ledgerly.app";
const OTHER_EMAIL = "group-dash-other@ledgerly.app";
const KEY = currentMonthKey();
const YMD = `${KEY}-05`;

let userId: string;
let otherUserId: string;
let groupId: string;
let karanId: string;
let priyaId: string;

async function groupExpense(amount: number, paidBy: string | null, shares: { pid: string | null; owed: number }[], categoryId: string) {
  return prisma.transaction.create({
    data: {
      userId,
      type: "EXPENSE",
      amount,
      groupId,
      categoryId,
      paidByParticipantId: paidBy,
      merchant: "Group spend",
      occurredAt: istNoon(YMD),
      splits: { create: shares.map((s) => ({ participantId: s.pid, owedAmount: s.owed })) },
    },
  });
}

describe("groupDashboard", () => {
  beforeAll(async () => {
    for (const e of [EMAIL, OTHER_EMAIL]) {
      const ex = await prisma.user.findUnique({ where: { email: e } });
      if (ex) await prisma.user.delete({ where: { id: ex.id } });
    }
    const user = await prisma.user.create({ data: { name: "Owner", email: EMAIL, emailVerified: true } });
    userId = user.id;
    const other = await prisma.user.create({ data: { name: "Other", email: OTHER_EMAIL, emailVerified: true } });
    otherUserId = other.id;

    const karan = await prisma.participant.create({ data: { ownerId: userId, displayName: "Karan", color: "#0f766e" } });
    const priya = await prisma.participant.create({ data: { ownerId: userId, displayName: "Priya", color: "#d1497e" } });
    karanId = karan.id;
    priyaId = priya.id;

    const group = await prisma.group.create({
      data: { name: "Flat 402", createdById: userId, members: { create: [{ participantId: karanId }, { participantId: priyaId }] } },
    });
    groupId = group.id;
    const food = await prisma.category.create({ data: { groupId, name: "Food", kind: "EXPENSE", icon: "🍔", color: "#f43f5e" } });

    // You paid ₹900 split 3 ways; Karan paid ₹600 split 3 ways; Priya settled ₹100.
    await groupExpense(90000, null, [{ pid: null, owed: 30000 }, { pid: karanId, owed: 30000 }, { pid: priyaId, owed: 30000 }], food.id);
    await groupExpense(60000, karanId, [{ pid: null, owed: 20000 }, { pid: karanId, owed: 20000 }, { pid: priyaId, owed: 20000 }], food.id);
    await prisma.settlement.create({ data: { userId, participantId: priyaId, groupId, direction: "TO_OWNER", amount: 10000, method: "UPI" } });
  });

  it("computes overview totals and last activity", async () => {
    const g = (await groupDashboard(userId, groupId, parsePeriod({ p: "all" })))!;
    expect(g.name).toBe("Flat 402");
    expect(g.memberCount).toBe(2);
    expect(g.overview.totalExpenseCount).toBe(2);
    expect(g.overview.totalExpenseSum).toBe(150000);
    expect(g.overview.totalSettlementCount).toBe(1);
    expect(g.overview.totalSettlementSum).toBe(10000);
  });

  it("computes settlement-aware member balances", async () => {
    const g = (await groupDashboard(userId, groupId, parsePeriod({ p: "all" })))!;
    const by = (name: string) => g.members.find((m) => m.name === name)!;
    expect(g.youNet).toBe(30000);
    expect(g.youAreOwed).toBe(30000);
    expect(g.youOwe).toBe(0);
    expect(by("Karan").net).toBe(10000);
    expect(by("Priya").net).toBe(20000);
    expect(by("You").contributionPct).toBe(60);
  });

  it("scopes spending to the period and exposes the category pie", async () => {
    const thisMonth = (await groupDashboard(userId, groupId, parsePeriod({ p: KEY })))!;
    expect(thisMonth.spending.totalSpent).toBe(150000);
    expect(thisMonth.spending.categories[0]).toMatchObject({ name: "Food", total: 150000 });

    // A past month with no group spend → empty pie, zero total.
    const past = KEY.endsWith("-01") ? `${Number(KEY.slice(0, 4)) - 1}-12` : `${KEY.slice(0, 4)}-01`;
    const empty = (await groupDashboard(userId, groupId, parsePeriod({ p: past })))!;
    expect(empty.spending.totalSpent).toBe(0);
    expect(empty.spending.categories).toEqual([]);
  });

  it("returns the settlement history and per-group activity ids", async () => {
    const g = (await groupDashboard(userId, groupId, parsePeriod({ p: "all" })))!;
    expect(g.settlements).toHaveLength(1);
    expect(g.settlements[0]).toMatchObject({ participantName: "Priya", direction: "TO_OWNER", amount: 10000 });
    // group id + 2 transactions + 1 settlement feed the scoped ModuleActivity
    // (the group id surfaces membership events, which are audited with entityId
    // = groupId).
    expect(g.activityEntityIds).toHaveLength(4);
    expect(g.activityEntityIds[0]).toBe(groupId);
  });

  it("audits linking an existing contact, adding a new member, and removing one", async () => {
    // An existing contact intentionally linked into the group (member-link)…
    const linked = await prisma.participant.create({ data: { ownerId: userId, displayName: "Ravi", color: "#2563eb" } });
    await addGroupMember(userId, groupId, linked.id, false);
    // …and a brand-new member created for the group (member-add).
    const fresh = await prisma.participant.create({ data: { ownerId: userId, displayName: "Sneha", color: "#7c3aed" } });
    await addGroupMember(userId, groupId, fresh.id, true);
    // Removing one (member-remove).
    await removeGroupMember(userId, groupId, linked.id);

    const rows = await prisma.auditLog.findMany({
      where: { userId, entity: "GroupMember", entityId: groupId },
      orderBy: { at: "asc" },
    });
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["member-link", "member-add", "member-remove"]));

    // Idempotent: re-adding the same member does not write a second event.
    const before = rows.length;
    await addGroupMember(userId, groupId, fresh.id, true);
    const after = await prisma.auditLog.count({ where: { userId, entity: "GroupMember", entityId: groupId } });
    expect(after).toBe(before);

    // The events project into the group's ModuleActivity feed.
    const feed = await activityPage(userId, { entityIds: [groupId] });
    const summaries = feed.events.map((i) => i.summary).join(" | ");
    expect(summaries).toContain("Sneha");
    expect(summaries).toContain("Ravi");
  });

  it("hides the group from a user who can't see it", async () => {
    expect(await groupDashboard(otherUserId, groupId, parsePeriod({ p: "all" }))).toBeNull();
  });

  it("surfaces the optimal settlement suggestions with You-side settle prefills", async () => {
    const g = (await groupDashboard(userId, groupId, parsePeriod({ p: "all" })))!;
    // You +₹300, Karan +₹100, Priya +₹200 → both members pay You.
    expect(g.suggestions).toHaveLength(2);
    expect(g.suggestions.every((s) => s.involvesYou && s.toName === "You")).toBe(true);
    const karan = g.suggestions.find((s) => s.fromName === "Karan")!;
    expect(karan.settle).toMatchObject({ direction: "TO_OWNER", amountRupees: "100", netPaise: 10000 });
  });

  it("flags a member with settlement history as partially settled", async () => {
    const g = (await groupDashboard(userId, groupId, parsePeriod({ p: "all" })))!;
    expect(g.members.find((m) => m.name === "Priya")!.hasSettlements).toBe(true); // Priya settled ₹100
    expect(g.members.find((m) => m.name === "Karan")!.hasSettlements).toBe(false);
  });

  it("a general (non-group) settlement with a group member does NOT leak into the group", async () => {
    const before = (await groupDashboard(userId, groupId, parsePeriod({ p: "all" })))!;
    const karanBefore = before.members.find((m) => m.name === "Karan")!.net;
    // A settlement recorded with no groupId (e.g. from the shared page).
    const leak = await prisma.settlement.create({ data: { userId, participantId: karanId, direction: "TO_OWNER", amount: 5000, method: "CASH" } });

    const after = (await groupDashboard(userId, groupId, parsePeriod({ p: "all" })))!;
    expect(after.members.find((m) => m.name === "Karan")!.net).toBe(karanBefore); // unchanged
    expect(after.settlements.some((s) => s.id === leak.id)).toBe(false);

    await prisma.settlement.delete({ where: { id: leak.id } });
  });

  it("deleteSettlement reverses the balance and audits it (run last — mutates state)", async () => {
    const before = (await groupDashboard(userId, groupId, parsePeriod({ p: "all" })))!;
    const settlementId = before.settlements[0].id;
    await deleteSettlement(userId, settlementId);

    const after = (await groupDashboard(userId, groupId, parsePeriod({ p: "all" })))!;
    // Priya's ₹100 settlement gone → her net returns to the full ₹300 owed.
    expect(after.members.find((m) => m.name === "Priya")!.net).toBe(30000);
    expect(after.settlements).toHaveLength(0);

    const auditRow = await prisma.auditLog.findFirst({ where: { userId, entity: "Settlement", action: "delete", entityId: settlementId } });
    expect(auditRow).not.toBeNull();
  });
});
