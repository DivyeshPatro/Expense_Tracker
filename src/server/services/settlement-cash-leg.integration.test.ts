// Settling is real money moving.
//
// A settlement used to be a debt record only — no transaction, no account
// touched. So the ₹1,240 you fronted was counted as spending and the ₹992
// repaid to you was not, and account balances drifted from the bank a little
// further with every settle-up.
//
// The two things that must stay true while fixing that:
//   • the cash leg must never re-enter the group's expense maths
//   • repaying a debt must not count a second time as "your share"

import { beforeEach, describe, expect, it } from "vitest";
import { parsePeriod } from "@/lib/period";
import { groupDashboard } from "./group-dashboard";
import { personalShareExpense } from "./ledger";
import { deleteSettlement, recordSettlement } from "./shared";
import { prisma } from "../db";

const EMAIL = "settle-cash@ledgerly.app";
const rup = (n: number) => Math.round(n * 100);
const ALL = parsePeriod({ p: "all" });

let userId: string, accountId: string, categoryId: string, groupId: string, anaId: string, benId: string;

async function balance() {
  return Number((await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).balance);
}

describe("settlement cash leg", () => {
  beforeEach(async () => {
    const ex = await prisma.user.findUnique({ where: { email: EMAIL } });
    if (ex) await prisma.user.delete({ where: { id: ex.id } });
    const user = await prisma.user.create({ data: { name: "Owner", email: EMAIL, emailVerified: true } });
    userId = user.id;
    accountId = (await prisma.account.create({ data: { userId, name: "Bank", type: "BANK", openingBalance: 0, balance: 0 } })).id;
    categoryId = (await prisma.category.create({ data: { userId, name: "Trip", kind: "EXPENSE", icon: "🧳", color: "#000" } })).id;
    anaId = (await prisma.participant.create({ data: { ownerId: userId, displayName: "Ana" } })).id;
    benId = (await prisma.participant.create({ data: { ownerId: userId, displayName: "Ben" } })).id;
    groupId = (await prisma.group.create({
      data: { name: "Trip", createdById: userId, members: { create: [{ participantId: anaId }, { participantId: benId }] } },
    })).id;
    // You paid ₹300 from the account, split three ways.
    await prisma.transaction.create({
      data: {
        userId, type: "EXPENSE", amount: rup(300), accountId, categoryId, merchant: "Dinner",
        occurredAt: new Date(), groupId, paidByParticipantId: null,
        splits: { create: [{ participantId: null, owedAmount: rup(100) }, { participantId: anaId, owedAmount: rup(100) }, { participantId: benId, owedAmount: rup(100) }] },
      },
    });
    await prisma.account.update({ where: { id: accountId }, data: { balance: rup(-300) } });
  });

  it("someone repaying you lands in the account as income", async () => {
    expect(await balance()).toBe(rup(-300));
    await recordSettlement(userId, anaId, "TO_OWNER", rup(100), "UPI", undefined, groupId, accountId);
    expect(await balance()).toBe(rup(-200));
    const cash = await prisma.transaction.findFirstOrThrow({ where: { userId, type: "INCOME" } });
    expect(Number(cash.amount)).toBe(rup(100));
    expect(cash.accountId).toBe(accountId);
  });

  it("the cash leg never becomes a group expense", async () => {
    // The trap: a FROM_OWNER row carrying groupId would come back from
    // `{ groupId, type: "EXPENSE" }` and corrupt the balances it settles.
    await recordSettlement(userId, anaId, "FROM_OWNER", rup(50), "UPI", undefined, groupId, accountId);
    const g = (await groupDashboard(userId, groupId, ALL))!;
    expect(g.overview.totalExpenseCount).toBe(1);
    expect(g.overview.totalExpenseSum).toBe(rup(300));
    const cash = await prisma.transaction.findFirstOrThrow({ where: { userId, merchant: { contains: "Settled up" } } });
    expect(cash.groupId).toBeNull();
  });

  it("repaying someone moves the money but is NOT counted as your spending", async () => {
    const shareBefore = await personalShareExpense(userId);
    expect(shareBefore).toBe(rup(100)); // your third of the dinner
    await recordSettlement(userId, anaId, "FROM_OWNER", rup(80), "UPI", undefined, groupId, accountId);
    expect(await balance()).toBe(rup(-380)); // money really left the account
    // You already bore your ₹100 when the dinner was recorded. Repaying a debt
    // is not consumption, so "your share" must not move.
    expect(await personalShareExpense(userId)).toBe(rup(100));
    // Recorded as a TRANSFER for exactly that reason — see recordSettlement.
    const cash = await prisma.transaction.findFirstOrThrow({ where: { userId, merchant: { contains: "Settled up" } } });
    expect(cash.type).toBe("TRANSFER");
  });

  it("repaying someone does not re-create the debt it just settled", async () => {
    // The trap a participant-side split would have sprung: netBalances sums
    // every split expense, group or not.
    await recordSettlement(userId, anaId, "FROM_OWNER", rup(80), "UPI", undefined, groupId, accountId);
    const g = (await groupDashboard(userId, groupId, ALL))!;
    expect(g.members.find((m) => m.name === "Ana")!.net).toBe(rup(180)); // 100 owed + 80 you paid her
  });

  it("the settlement still adjusts the group balance exactly as before", async () => {
    await recordSettlement(userId, anaId, "TO_OWNER", rup(100), "UPI", undefined, groupId, accountId);
    const g = (await groupDashboard(userId, groupId, ALL))!;
    expect(g.members.find((m) => m.name === "Ana")!.net).toBe(0);
    expect(g.members.find((m) => m.name === "Ben")!.net).toBe(rup(100));
  });

  it("without an account it stays a debt record only — the old behaviour", async () => {
    await recordSettlement(userId, anaId, "TO_OWNER", rup(100), "CASH", undefined, groupId);
    expect(await balance()).toBe(rup(-300));
    expect(await prisma.transaction.count({ where: { userId, type: "INCOME" } })).toBe(0);
    const s = await prisma.settlement.findFirstOrThrow({ where: { userId } });
    expect(s.transactionId).toBeNull();
    // the debt is still settled
    const g = (await groupDashboard(userId, groupId, ALL))!;
    expect(g.members.find((m) => m.name === "Ana")!.net).toBe(0);
  });

  it("deleting the settlement reverses the money too", async () => {
    await recordSettlement(userId, anaId, "TO_OWNER", rup(100), "UPI", undefined, groupId, accountId);
    expect(await balance()).toBe(rup(-200));
    const s = await prisma.settlement.findFirstOrThrow({ where: { userId } });
    await deleteSettlement(userId, s.id);
    expect(await balance()).toBe(rup(-300)); // back where it started
    expect(await prisma.transaction.count({ where: { userId, type: "INCOME" } })).toBe(0);
  });

  it("refuses an account belonging to somebody else", async () => {
    const other = await prisma.user.create({ data: { name: "X", email: `x-${Date.now()}@ledgerly.app`, emailVerified: true } });
    const theirs = await prisma.account.create({ data: { userId: other.id, name: "Theirs", type: "BANK", openingBalance: 0, balance: 0 } });
    await expect(recordSettlement(userId, anaId, "TO_OWNER", rup(100), "UPI", undefined, groupId, theirs.id)).rejects.toThrow();
    expect(await balance()).toBe(rup(-300)); // nothing moved
    await prisma.user.delete({ where: { id: other.id } });
  });

  it("cash in and cash out reconcile once everyone has settled", async () => {
    // You fronted ₹300 and bore ₹100 of it. After both repay, the account is
    // down exactly your own share — which is the whole point.
    await recordSettlement(userId, anaId, "TO_OWNER", rup(100), "UPI", undefined, groupId, accountId);
    await recordSettlement(userId, benId, "TO_OWNER", rup(100), "UPI", undefined, groupId, accountId);
    expect(await balance()).toBe(rup(-100));
    expect(await personalShareExpense(userId)).toBe(rup(100));
  });
});
