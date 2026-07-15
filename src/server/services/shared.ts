// Shared expenses: participants (ghost or linked), net balances from unsettled
// splits minus settlements, and the deterministic settlement suggestions.

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

export async function listParticipants(userId: string) {
  return prisma.participant.findMany({ where: { ownerId: userId }, orderBy: { displayName: "asc" } });
}

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
export async function netBalances(userId: string): Promise<ParticipantView[]> {
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
}

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
  note?: string
) {
  await prisma.$transaction(async (db) => {
    const p = await db.participant.findFirst({ where: { id: participantId, ownerId: userId } });
    if (!p) throw new Error("Participant not found");
    const s = await db.settlement.create({
      data: { userId, participantId, direction, amount, method, note: note || null },
    });
    await audit(db, userId, "create", "Settlement", s.id, undefined, s);
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

/** First group (e.g. "Flat 402") with member names, for the Shared screen header. */
export async function firstGroup(userId: string) {
  const group = await prisma.group.findFirst({
    where: { createdById: userId },
    include: { members: { include: { participant: { select: { displayName: true } } } } },
  });
  if (!group) return null;
  return { id: group.id, name: group.name, memberNames: group.members.map((m) => m.participant.displayName) };
}
