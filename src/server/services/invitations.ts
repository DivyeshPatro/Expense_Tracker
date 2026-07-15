// Shareable-link invitations — no email provider is wired up, so createInvitation
// just returns a token the caller shares (copy-link) rather than sending mail.
// Invitation.participantId has no declared Prisma relation, so the participant
// lookup below is a plain second query, not an `include`.

import { prisma } from "../db";

const TTL_DAYS = 7;

export async function createInvitation(userId: string, participantId: string): Promise<{ token: string }> {
  const participant = await prisma.participant.findFirst({ where: { id: participantId, ownerId: userId } });
  if (!participant) throw new Error("Friend not found");
  if (participant.linkedUserId) throw new Error("Already linked to an account");

  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000);
  await prisma.invitation.create({
    data: { email: "", invitedById: userId, participantId, token, expiresAt },
  });
  return { token };
}

export interface InvitationView {
  status: "PENDING" | "ACCEPTED" | "EXPIRED";
  inviterName: string;
  participantName: string;
}

export async function getInvitation(token: string): Promise<InvitationView | null> {
  const invitation = await prisma.invitation.findUnique({ where: { token } });
  if (!invitation) return null;
  const [participant, inviter] = await Promise.all([
    prisma.participant.findUnique({ where: { id: invitation.participantId } }),
    prisma.user.findUnique({ where: { id: invitation.invitedById } }),
  ]);
  if (!participant || !inviter) return null;
  const expired = invitation.status === "PENDING" && invitation.expiresAt < new Date();
  return {
    status: expired ? "EXPIRED" : invitation.status,
    inviterName: inviter.name,
    participantName: participant.displayName,
  };
}

export async function acceptInvitation(token: string, userId: string): Promise<void> {
  await prisma.$transaction(async (db) => {
    const invitation = await db.invitation.findUnique({ where: { token } });
    if (!invitation) throw new Error("Invitation not found");
    if (invitation.status !== "PENDING") throw new Error("Invitation already used");
    if (invitation.expiresAt < new Date()) throw new Error("Invitation expired");
    await db.participant.update({ where: { id: invitation.participantId }, data: { linkedUserId: userId } });
    await db.invitation.update({ where: { token }, data: { status: "ACCEPTED" } });
  });
}
