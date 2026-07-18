// Privacy non-functional requirement (PRD §8): full data export and
// self-serve account deletion. "Clear transactions" resets the ledger back to
// a blank slate (e.g. before importing real history) without touching account
// setup, categories or budgets. Ordering here is deliberate — child rows are
// removed before parents so nothing relies on DB-level cascade ordering
// across sibling relations that reference the same target from two paths.

import { prisma } from "../db";
import { audit } from "./audit";

/** Wipes all transactional history; keeps accounts/categories/budgets/friends intact, balances reset to opening. */
export async function clearAllTransactions(userId: string): Promise<void> {
  await prisma.$transaction(async (db) => {
    const before = await db.transaction.count({ where: { userId } });

    await db.transactionTag.deleteMany({ where: { tx: { userId } } });
    await db.receipt.deleteMany({ where: { userId } });
    await db.expenseSplit.deleteMany({ where: { tx: { userId } } });
    await db.notification.deleteMany({ where: { userId } });
    await db.settlement.deleteMany({ where: { userId } });
    await db.transaction.deleteMany({ where: { userId } });
    await db.bill.deleteMany({ where: { userId } });
    await db.recurringRule.deleteMany({ where: { userId } });
    await db.importBatch.deleteMany({ where: { userId } });
    await db.importMapping.deleteMany({ where: { userId } });

    const accounts = await db.account.findMany({ where: { userId } });
    for (const a of accounts) {
      await db.account.update({ where: { id: a.id }, data: { balance: a.openingBalance } });
    }

    await audit(db, userId, "clear-transactions", "User", userId, { transactionCount: before }, { transactionCount: 0 });
  });
}

/** Full self-serve account deletion: every owned row, then the user itself. Irreversible. */
export async function deleteUserAccount(userId: string): Promise<void> {
  await prisma.$transaction(
    async (db) => {
      await db.transactionTag.deleteMany({ where: { tx: { userId } } });
      await db.receipt.deleteMany({ where: { userId } });
      await db.expenseSplit.deleteMany({ where: { tx: { userId } } });
      await db.notification.deleteMany({ where: { userId } });
      await db.settlement.deleteMany({ where: { userId } });
      await db.transaction.deleteMany({ where: { userId } }); // removes paidByParticipantId references too
      await db.bill.deleteMany({ where: { userId } });
      await db.recurringRule.deleteMany({ where: { userId } });
      await db.importBatch.deleteMany({ where: { userId } });
      await db.importMapping.deleteMany({ where: { userId } });
      await db.auditLog.deleteMany({ where: { userId } });

      // Intent.userId and Invitation.invitedById/participantId are plain
      // strings with no declared Prisma relation (see invitations.ts, and
      // Intent's own schema comment) — nothing DB-cascades these, so they'd
      // otherwise survive as orphans pointing at a userId that no longer
      // exists. Must run before participant deleteMany below, since
      // Invitation.participantId's cleanup depends on this user's own
      // participant rows still existing to look up.
      await db.intent.deleteMany({ where: { userId } });
      const ownedParticipantIds = (await db.participant.findMany({ where: { ownerId: userId }, select: { id: true } })).map((p) => p.id);
      await db.invitation.deleteMany({
        where: { OR: [{ invitedById: userId }, { participantId: { in: ownedParticipantIds } }] },
      });

      await db.groupMember.deleteMany({ where: { participant: { ownerId: userId } } });
      await db.group.deleteMany({ where: { createdById: userId } });
      await db.participant.deleteMany({ where: { ownerId: userId } });

      await db.merchantRule.deleteMany({ where: { userId } });
      await db.budget.deleteMany({ where: { userId } });
      await db.category.deleteMany({ where: { userId } });
      await db.tag.deleteMany({ where: { userId } });
      await db.account.deleteMany({ where: { userId } });

      await db.user.delete({ where: { id: userId } }); // cascades Session, AuthAccount
    },
    { timeout: 20000 }
  );
}
