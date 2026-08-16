// Shared expenses: participants (ghost or linked), net balances from unsettled
// splits minus settlements, and the deterministic settlement suggestions.

import { cache } from "react";
import { minimizeSettlements, type SettleTransfer } from "@/lib/settlement";
import { prisma } from "../db";
import { audit } from "./audit";

const AVATAR_COLORS = ["#6d5ae6", "#0f766e", "#d1497e", "#b97d10", "#1d4ed8", "#dc2626"];

export interface ParticipantView {
  id: string;
  name: string;
  initial: string;
  color: string;
  net: number; // paise: positive ⇒ they owe you, negative ⇒ you owe them
  linkedUserId: string | null;
}

// cache()-wrapped: the layout (sidebar friend list) and netBalances() both need
// every participant for the same request — dedupes the second fetch instead of
// hitting Postgres twice for the same userId.
export const listParticipants = cache(async (userId: string) => {
  return prisma.participant.findMany({ where: { ownerId: userId }, orderBy: { displayName: "asc" } });
});

/** Participants with relation counts so callers can tell a Shared friend from a
 * Lending-only contact (v2.1 #69). A contact imported for lending has loan
 * entries but no splits / group memberships / settlements — Shared surfaces
 * (the split picker) hide those, while the Lending entry form still sees all.
 * Counts on the small participant table, not a transaction scan, so the
 * per-navigation layout stays cheap. */
export const listParticipantsWithUsage = cache(async (userId: string) => {
  return prisma.participant.findMany({
    where: { ownerId: userId },
    orderBy: { displayName: "asc" },
    include: { _count: { select: { loanEntries: true, splits: true, groupMembers: true, settlements: true } } },
  });
});

export async function addParticipant(userId: string, displayName: string) {
  const count = await prisma.participant.count({ where: { ownerId: userId } });
  return prisma.participant.create({
    data: { ownerId: userId, displayName, color: AVATAR_COLORS[count % AVATAR_COLORS.length] },
  });
}

/**
 * Net balance per participant, owner's perspective:
 *   + their owed share on expenses the owner paid
 *   − the owner's owed share on expenses they paid
 *   adjusted by settlements (TO_OWNER reduces what they owe; FROM_OWNER reduces what the owner owes).
 */
// Wrapped in React's per-request cache: layout.tsx computes this for the sidebar
// badge on every navigation, and sharedSummary() (Dashboard/Shared pages) needs
// the identical query set again in the same request — cache() dedupes the
// second call instead of hitting Postgres twice for the same userId.
export const netBalances = cache(async (userId: string): Promise<ParticipantView[]> => {
  const [participants, txs, settlements] = await Promise.all([
    listParticipants(userId),
    prisma.transaction.findMany({
      where: { userId, type: "EXPENSE", deletedAt: null, splits: { some: {} } },
      select: { paidByParticipantId: true, splits: { select: { participantId: true, owedAmount: true } } },
    }),
    prisma.settlement.findMany({ where: { userId } }),
  ]);

  const nets = new Map<string, number>(participants.map((p) => [p.id, 0]));
  for (const t of txs) {
    const myShare = Number(t.splits.find((s) => s.participantId === null)?.owedAmount ?? 0);
    if (t.paidByParticipantId === null) {
      for (const s of t.splits) {
        if (s.participantId && nets.has(s.participantId)) {
          nets.set(s.participantId, nets.get(s.participantId)! + Number(s.owedAmount));
        }
      }
    } else if (nets.has(t.paidByParticipantId)) {
      nets.set(t.paidByParticipantId, nets.get(t.paidByParticipantId)! - myShare);
    }
  }
  for (const s of settlements) {
    if (!nets.has(s.participantId)) continue;
    const delta = s.direction === "TO_OWNER" ? -Number(s.amount) : Number(s.amount);
    nets.set(s.participantId, nets.get(s.participantId)! + delta);
  }

  return participants.map((p) => ({
    id: p.id,
    name: p.displayName,
    initial: p.displayName.charAt(0).toUpperCase(),
    color: p.color ?? AVATAR_COLORS[0],
    net: nets.get(p.id) ?? 0,
    linkedUserId: p.linkedUserId,
  }));
});

export interface SharedSummary {
  youOwe: number;
  owedToYou: number;
  net: number;
  members: ParticipantView[];
  suggestions: SettleTransfer[];
}

export async function sharedSummary(userId: string): Promise<SharedSummary> {
  const members = await netBalances(userId);
  const youOwe = members.filter((m) => m.net < 0).reduce((s, m) => s - m.net, 0);
  const owedToYou = members.filter((m) => m.net > 0).reduce((s, m) => s + m.net, 0);
  const suggestions = minimizeSettlements([
    { id: "me", net: youOwe - owedToYou },
    ...members.map((m) => ({ id: m.id, net: m.net })),
  ]);
  return { youOwe, owedToYou, net: owedToYou - youOwe, members, suggestions };
}

export async function recordSettlement(
  userId: string,
  participantId: string,
  direction: "TO_OWNER" | "FROM_OWNER",
  amount: number,
  method: "UPI" | "CASH" | "BANK",
  note?: string,
  groupId?: string
) {
  await prisma.$transaction(async (db) => {
    const p = await db.participant.findFirst({ where: { id: participantId, ownerId: userId } });
    if (!p) throw new Error("Participant not found");
    // A group-scoped settlement must belong to a group the caller owns and that
    // this participant is actually in — otherwise it's ignored (recorded as a
    // general settlement) rather than silently mis-attributed.
    let scopedGroupId: string | null = null;
    if (groupId) {
      const member = await db.groupMember.findUnique({ where: { groupId_participantId: { groupId, participantId } }, include: { group: { select: { createdById: true } } } });
      if (member && member.group.createdById === userId) scopedGroupId = groupId;
    }
    const s = await db.settlement.create({
      data: { userId, participantId, direction, amount, method, note: note || null, groupId: scopedGroupId },
    });
    await audit(db, userId, "create", "Settlement", s.id, undefined, s);
  });
}

/** Delete a settlement (v2.0 P3). Balances are read live from the settlement
 * rows, so removing the row automatically reverses its effect — no separate
 * balance write, single source of truth. Audited like every other mutation. */
export async function deleteSettlement(userId: string, settlementId: string) {
  await prisma.$transaction(async (db) => {
    const s = await db.settlement.findFirst({ where: { id: settlementId, userId }, include: { participant: { select: { displayName: true } } } });
    if (!s) throw new Error("Settlement not found");
    await db.settlement.delete({ where: { id: settlementId } });
    await audit(db, userId, "delete", "Settlement", settlementId, {
      participantId: s.participantId,
      participantName: s.participant.displayName,
      direction: s.direction,
      amount: Number(s.amount),
      method: s.method,
    }, undefined);
  });
}

export interface SettlementHistoryRow {
  id: string;
  text: string;
  ymd: string;
}

export async function settlementHistory(userId: string): Promise<{ id: string; participantName: string; direction: string; amount: number; method: string; settledAt: Date }[]> {
  const rows = await prisma.settlement.findMany({
    where: { userId },
    include: { participant: { select: { displayName: true } } },
    orderBy: { settledAt: "desc" },
    take: 10,
  });
  return rows.map((s) => ({
    id: s.id,
    participantName: s.participant.displayName,
    direction: s.direction,
    amount: Number(s.amount),
    method: s.method,
    settledAt: s.settledAt,
  }));
}

/** Thrown when a merge is asked to do something it cannot do safely. */
export class MergeConflictError extends Error {}

export interface MergeResult {
  repointedSplits: string[];
  repointedLoanEntries: string[];
  repointedSettlements: string[];
  /** Memberships moved to the canonical record. */
  movedMemberships: string[];
  /** Memberships dropped because the canonical record was already a member. */
  redundantMemberships: string[];
  duplicateDeleted: boolean;
}

/**
 * v2.1 — fold a duplicate Participant into a canonical one.
 *
 * Two records for one human is not hypothetical: an imported lending contact
 * was hidden from the split picker, a second record was created under the same
 * name, and one person ended up carrying two separate balances instead of one.
 * This is the repair, made first-class so it is testable and repeatable rather
 * than a one-off script.
 *
 * ORDER IS LOAD-BEARING. `ExpenseSplit.participantId` is nullable with
 * ON DELETE SET NULL, and every balance reader treats a null participant as
 * *the owner's own share*. Deleting the duplicate before repointing would
 * therefore not error — it would silently convert that person's debt into the
 * owner's own and quietly shrink what everyone owes. Every reference is
 * repointed and asserted to zero BEFORE the delete is even attempted.
 *
 * No amount is ever written. Only which participant a row points at changes,
 * so every balance is the arithmetic sum of the two originals.
 */
export async function mergeParticipants(userId: string, canonicalId: string, duplicateId: string): Promise<MergeResult> {
  if (canonicalId === duplicateId) throw new MergeConflictError("Cannot merge a contact into itself.");

  return prisma.$transaction(async (db) => {
    const [canonical, duplicate] = await Promise.all([
      db.participant.findFirst({ where: { id: canonicalId, ownerId: userId } }),
      db.participant.findFirst({ where: { id: duplicateId, ownerId: userId } }),
    ]);
    if (!canonical) throw new MergeConflictError("Canonical contact not found.");
    if (!duplicate) throw new MergeConflictError("Duplicate contact not found.");

    // Both linked to real — and different — users means these are provably two
    // different people, whatever the display names say. Never merge those.
    if (canonical.linkedUserId && duplicate.linkedUserId && canonical.linkedUserId !== duplicate.linkedUserId) {
      throw new MergeConflictError("These contacts are linked to two different user accounts — they are not the same person.");
    }

    // A single expense holding both records would collapse into two split rows
    // for one person. That is a real conflict, not something to guess at.
    const shared = await db.expenseSplit.findMany({ where: { participantId: canonicalId }, select: { txId: true } });
    const dupSplits = await db.expenseSplit.findMany({ where: { participantId: duplicateId }, select: { id: true, txId: true } });
    const canonicalTxIds = new Set(shared.map((s) => s.txId));
    const collision = dupSplits.find((s) => canonicalTxIds.has(s.txId));
    if (collision) {
      throw new MergeConflictError(
        "Both contacts appear on the same expense, so they are not the same person — resolve that expense first."
      );
    }

    // ── repoint everything BEFORE any delete ──────────────────────────────
    await db.expenseSplit.updateMany({ where: { participantId: duplicateId }, data: { participantId: canonicalId } });
    const loans = await db.loanEntry.findMany({ where: { participantId: duplicateId }, select: { id: true } });
    await db.loanEntry.updateMany({ where: { participantId: duplicateId }, data: { participantId: canonicalId } });
    const setts = await db.settlement.findMany({ where: { participantId: duplicateId }, select: { id: true } });
    await db.settlement.updateMany({ where: { participantId: duplicateId }, data: { participantId: canonicalId } });
    await db.transaction.updateMany({ where: { paidByParticipantId: duplicateId }, data: { paidByParticipantId: canonicalId } });

    // Group membership is a composite primary key, so a straight update would
    // collide wherever the canonical record is already a member. Move the ones
    // it isn't in; drop the redundant ones. The canonical membership always wins
    // and is never removed.
    const dupMemberships = await db.groupMember.findMany({ where: { participantId: duplicateId } });
    const canonMemberships = new Set(
      (await db.groupMember.findMany({ where: { participantId: canonicalId }, select: { groupId: true } })).map((m) => m.groupId)
    );
    const moved: string[] = [];
    const redundant: string[] = [];
    for (const m of dupMemberships) {
      if (canonMemberships.has(m.groupId)) {
        redundant.push(m.groupId);
        await db.groupMember.delete({ where: { groupId_participantId: { groupId: m.groupId, participantId: duplicateId } } });
      } else {
        moved.push(m.groupId);
        await db.groupMember.create({ data: { groupId: m.groupId, participantId: canonicalId, role: m.role } });
        await db.groupMember.delete({ where: { groupId_participantId: { groupId: m.groupId, participantId: duplicateId } } });
      }
    }

    // ── prove nothing points at the duplicate before removing it ──────────
    const [remainingSplits, remainingLoans, remainingSetts, remainingGm, remainingPaid] = await Promise.all([
      db.expenseSplit.count({ where: { participantId: duplicateId } }),
      db.loanEntry.count({ where: { participantId: duplicateId } }),
      db.settlement.count({ where: { participantId: duplicateId } }),
      db.groupMember.count({ where: { participantId: duplicateId } }),
      db.transaction.count({ where: { paidByParticipantId: duplicateId } }),
    ]);
    const stragglers = remainingSplits + remainingLoans + remainingSetts + remainingGm + remainingPaid;
    if (stragglers > 0) {
      // Aborts the whole transaction — never delete while anything still refers
      // to it, or SET NULL turns a real debt into the owner's own share.
      throw new MergeConflictError(`${stragglers} references to the duplicate remain — refusing to delete it.`);
    }

    await audit(db, userId, "merge", "Participant", canonicalId, {
      canonical: { id: canonicalId, displayName: canonical.displayName },
      duplicate: { id: duplicateId, displayName: duplicate.displayName },
    }, {
      canonical: { id: canonicalId, displayName: canonical.displayName },
      duplicateDeleted: duplicateId,
      repointedExpenseSplitIds: dupSplits.map((s) => s.id),
      movedMemberships: moved,
      redundantMemberships: redundant,
    });

    await db.participant.delete({ where: { id: duplicateId } });

    return {
      repointedSplits: dupSplits.map((s) => s.id),
      repointedLoanEntries: loans.map((l) => l.id),
      repointedSettlements: setts.map((s) => s.id),
      movedMemberships: moved,
      redundantMemberships: redundant,
      duplicateDeleted: true,
    };
  });
}

/** First group (e.g. "Flat 402") with member names, for the Shared screen header. */
export async function firstGroup(userId: string) {
  const group = await prisma.group.findFirst({
    where: { createdById: userId },
    include: { members: { include: { participant: { select: { displayName: true } } } } },
  });
  if (!group) return null;
  return { id: group.id, name: group.name, memberNames: group.members.map((m) => m.participant.displayName) };
}
