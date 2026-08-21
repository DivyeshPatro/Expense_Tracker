// P0-2 — the server decides who a group expense may name.
//
// Until now the only thing between the ledger and a split filed against
// somebody outside the roster was inferGroupForMembers(), which runs in the
// expense form. Everything that does not render that form reaches the writers
// directly: the offline outbox replaying a payload composed before a member
// was removed, an import, an older client, a server action called straight.
// The form is a convenience; this is the boundary.
//
// The related failure — a group expense saved with groupId = null — is covered
// by group-inference.test.ts. This file covers the opposite direction: a
// groupId that is set, naming people who do not belong to it.

import { beforeEach, describe, expect, it } from "vitest";
import { addExpense, rehomeExpense, updateExpense } from "./transactions";
import { GroupMembershipError } from "./group-membership";
import { prisma } from "../db";

const EMAIL = "group-membership@ledgerly.app";
const rup = (n: number) => Math.round(n * 100);

let userId: string, categoryId: string, accountId: string;
let anaId: string, benId: string, outsiderId: string;
let tripId: string;

const expenseInput = (over: Partial<Parameters<typeof addExpense>[1]> = {}) => ({
  amount: rup(900),
  accountId,
  categoryId,
  merchant: "Dinner",
  date: "2026-08-16",
  groupId: tripId,
  split: { mode: "EQUAL" as const, participantIds: [anaId, benId], payerParticipantId: null },
  ...over,
});

describe("group membership is enforced by the server", () => {
  beforeEach(async () => {
    const ex = await prisma.user.findUnique({ where: { email: EMAIL } });
    if (ex) await prisma.user.delete({ where: { id: ex.id } });
    userId = (await prisma.user.create({ data: { name: "Owner", email: EMAIL, emailVerified: true } })).id;
    categoryId = (await prisma.category.create({ data: { userId, name: "Trip", kind: "EXPENSE", icon: "🧳", color: "#000" } })).id;
    accountId = (await prisma.account.create({ data: { userId, name: "Cash", type: "CASH", openingBalance: 0, icon: "💵", color: "#000" } })).id;
    anaId = (await prisma.participant.create({ data: { ownerId: userId, displayName: "Ana" } })).id;
    benId = (await prisma.participant.create({ data: { ownerId: userId, displayName: "Ben" } })).id;
    outsiderId = (await prisma.participant.create({ data: { ownerId: userId, displayName: "Priya" } })).id;
    tripId = (
      await prisma.group.create({
        data: { name: "Srisailam", createdById: userId, members: { create: [{ participantId: anaId }, { participantId: benId }] } },
      })
    ).id;
  });

  // ── create ───────────────────────────────────────────────────────────────
  it("accepts a group expense whose participants are all members", async () => {
    const id = await addExpense(userId, expenseInput());
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id }, include: { splits: true } });
    expect(tx.groupId).toBe(tripId);
    expect(tx.splits).toHaveLength(3); // owner + Ana + Ben
    expect(tx.splits.reduce((s, r) => s + Number(r.owedAmount), 0)).toBe(rup(900));
  });

  it("rejects a split naming somebody outside the group", async () => {
    await expect(
      addExpense(userId, expenseInput({ split: { mode: "EQUAL", participantIds: [anaId, outsiderId], payerParticipantId: null } }))
    ).rejects.toBeInstanceOf(GroupMembershipError);
  });

  it("names the person and the group, without leaking ids", async () => {
    const err = await addExpense(
      userId,
      expenseInput({ split: { mode: "EQUAL", participantIds: [anaId, outsiderId], payerParticipantId: null } })
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Priya");
    expect((err as Error).message).toContain("Srisailam");
    expect((err as Error).message).not.toContain(outsiderId);
    expect((err as Error).message).not.toContain(tripId);
  });

  it("rejects a payer who is not a member, even when every sharer is", async () => {
    // The payer is not necessarily one of the sharers, so it needs its own check.
    await expect(
      addExpense(
        userId,
        expenseInput({
          split: { mode: "EXACT", participantIds: [anaId, benId], payerParticipantId: outsiderId, exactAmounts: { [anaId]: rup(300), [benId]: rup(300) } },
        })
      )
    ).rejects.toBeInstanceOf(GroupMembershipError);
  });

  it("writes nothing when it rejects", async () => {
    const before = await prisma.transaction.count({ where: { userId } });
    await addExpense(userId, expenseInput({ split: { mode: "EQUAL", participantIds: [outsiderId], payerParticipantId: null } })).catch(() => {});
    expect(await prisma.transaction.count({ where: { userId } })).toBe(before);
    expect(await prisma.expenseSplit.count({ where: { participantId: outsiderId } })).toBe(0);
  });

  it("leaves personal expenses alone — no group, no roster to check", async () => {
    const id = await addExpense(
      userId,
      expenseInput({ groupId: null, split: { mode: "EQUAL", participantIds: [anaId, outsiderId], payerParticipantId: null } })
    );
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id }, include: { splits: true } });
    expect(tx.groupId).toBeNull();
    expect(tx.splits).toHaveLength(3);
  });

  // ── edit ─────────────────────────────────────────────────────────────────
  it("an edit cannot introduce an outsider", async () => {
    const id = await addExpense(userId, expenseInput());
    await expect(
      updateExpense(userId, id, expenseInput({ split: { mode: "EQUAL", participantIds: [anaId, outsiderId], payerParticipantId: null } }))
    ).rejects.toBeInstanceOf(GroupMembershipError);
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id }, include: { splits: true } });
    expect(tx.splits.map((s) => s.participantId).filter(Boolean).sort()).toEqual([anaId, benId].sort());
  });

  it("an ordinary edit of a valid group expense still succeeds", async () => {
    const id = await addExpense(userId, expenseInput());
    await updateExpense(userId, id, expenseInput({ amount: rup(1200), merchant: "Lunch" }));
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id }, include: { splits: true } });
    expect(Number(tx.amount)).toBe(rup(1200));
    expect(tx.splits.reduce((s, r) => s + Number(r.owedAmount), 0)).toBe(rup(1200));
  });

  it("a member removed from the group afterwards blocks the next edit", async () => {
    // The offline case in miniature: a payload composed against a roster that
    // has since changed must not apply just because it once would have.
    const id = await addExpense(userId, expenseInput());
    await prisma.groupMember.delete({ where: { groupId_participantId: { groupId: tripId, participantId: benId } } });
    await expect(updateExpense(userId, id, expenseInput())).rejects.toBeInstanceOf(GroupMembershipError);
  });

  // ── reassignment ─────────────────────────────────────────────────────────
  it("a personal expense can be moved into a group its participants belong to", async () => {
    const id = await addExpense(userId, expenseInput({ groupId: null }));
    await rehomeExpense(userId, id, tripId);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id } })).groupId).toBe(tripId);
  });

  it("a re-home is NOT gated on the roster — repairs must stay possible", async () => {
    // Deliberate asymmetry, and the one place this differs from a literal
    // reading of "reassignment cannot create an invalid combination". Re-homing
    // exists to repair attribution on history, and the rows that need it most
    // are the awkward ones: a member who has since left, or one real person
    // held as two participant records with only one on the roster. Refusing
    // here would have made the five orphaned Srisailam expenses unrepairable.
    // Nothing financial is rewritten, and the dashboard already shows such a
    // share under "(left group)" so no debt disappears.
    const id = await addExpense(
      userId,
      expenseInput({ groupId: null, split: { mode: "EQUAL", participantIds: [anaId, outsiderId], payerParticipantId: null } })
    );
    await rehomeExpense(userId, id, tripId);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id } })).groupId).toBe(tripId);
    // the outsider's share is still on the books, not silently dropped
    const splits = await prisma.expenseSplit.findMany({ where: { txId: id } });
    expect(splits.some((s) => s.participantId === outsiderId)).toBe(true);
  });

  it("but a later EDIT of that repaired row is still refused", async () => {
    // The repair is allowed; carrying the bad combination forward is not.
    const id = await addExpense(
      userId,
      expenseInput({ groupId: null, split: { mode: "EQUAL", participantIds: [anaId, outsiderId], payerParticipantId: null } })
    );
    await rehomeExpense(userId, id, tripId);
    await expect(
      updateExpense(userId, id, expenseInput({ split: { mode: "EQUAL", participantIds: [anaId, outsiderId], payerParticipantId: null } }))
    ).rejects.toBeInstanceOf(GroupMembershipError);
  });

  it("moving an expense OUT of a group is never blocked by the roster", async () => {
    // Leaving a group has no roster to satisfy — and a row whose participants
    // were removed must stay rescuable.
    const id = await addExpense(userId, expenseInput());
    await prisma.groupMember.deleteMany({ where: { groupId: tripId } });
    await rehomeExpense(userId, id, null);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id } })).groupId).toBeNull();
  });
});
