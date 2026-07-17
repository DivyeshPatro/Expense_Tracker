// Shareable-link invitations — no email provider is wired up, so createInvitation
// just returns a token the caller shares (copy-link) rather than sending mail.
// Invitation.participantId has no declared Prisma relation, so the participant
// lookup below is a plain second query, not an `include`.
//
// Collaboration-architecture-rfc §9: an invitation can optionally carry a
// groupId + role, in which case accepting it atomically grants group
// membership alongside the existing linkedUserId link. Plain 1:1 friend
// invitations (no groupId) behave exactly as before.

import type { GroupRole } from "@prisma/client";
import { prisma } from "../db";
import { assertGroupRole } from "./authorization";

const TTL_DAYS = 7;

export async function createInvitation(
  userId: string,
  participantId: string,
  groupId?: string,
  role: GroupRole = "MEMBER"
): Promise<{ token: string }> {
  // group invitations grant access to something the inviter doesn't
  // necessarily own outright — ADMIN+ only (same tier as addGroupMember)
  let participantOwnerId = userId;
  if (groupId) {
    const group = await assertGroupRole(prisma, userId, groupId, "ADMIN");
    // a group's member roster has one canonical identity source — the
    // creator's contact list (rfc §1) — so the invited participant must
    // come from there, not necessarily the inviting admin's own contacts
    participantOwnerId = group.createdById;
  }

  const participant = await prisma.participant.findFirst({ where: { id: participantId, ownerId: participantOwnerId } });
  if (!participant) throw new Error("Friend not found");
  if (participant.linkedUserId) throw new Error("Already linked to an account");

  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000);
  await prisma.invitation.create({
    data: { email: "", invitedById: userId, participantId, token, expiresAt, groupId: groupId ?? null, role: groupId ? role : null },
  });
  return { token };
}

export interface InvitationView {
  status: "PENDING" | "ACCEPTED" | "EXPIRED";
  inviterName: string;
  participantName: string;
  groupName: string | null;
}

export async function getInvitation(token: string): Promise<InvitationView | null> {
  const invitation = await prisma.invitation.findUnique({ where: { token } });
  if (!invitation) return null;
  const [participant, inviter, group] = await Promise.all([
    prisma.participant.findUnique({ where: { id: invitation.participantId } }),
    prisma.user.findUnique({ where: { id: invitation.invitedById } }),
    invitation.groupId ? prisma.group.findUnique({ where: { id: invitation.groupId } }) : Promise.resolve(null),
  ]);
  if (!participant || !inviter) return null;
  const expired = invitation.status === "PENDING" && invitation.expiresAt < new Date();
  return {
    status: expired ? "EXPIRED" : invitation.status,
    inviterName: inviter.name,
    participantName: participant.displayName,
    groupName: group?.name ?? null,
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
    if (invitation.groupId) {
      await db.groupMember.upsert({
        where: { groupId_participantId: { groupId: invitation.groupId, participantId: invitation.participantId } },
        create: { groupId: invitation.groupId, participantId: invitation.participantId, role: invitation.role ?? "MEMBER" },
        update: {},
      });
    }
  });
}
