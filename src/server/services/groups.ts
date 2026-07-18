// Group management (collaboration-architecture-rfc.md §3). A group's creator
// is its implicit OWNER — no GroupMember row of their own (§3.1) — every
// other member's role lives in GroupMember.role, resolved against the real
// user behind a linked Participant. Every mutating function here re-derives
// the caller's role live; nothing is cached or trusted from the client.

import { cache } from "react";
import type { GroupRole } from "@prisma/client";
import { GROUP_DEFAULT_CATEGORIES } from "@/lib/categories";
import { prisma } from "../db";
import { assertGroupRole, NotAuthorizedError } from "./authorization";

export interface GroupView {
  id: string;
  name: string;
  role: GroupRole;
  members: { participantId: string; name: string; initial: string; color: string; role: GroupRole }[];
}

/** Groups the user created, plus groups they've been added to as a linked
 * member (collaboration-architecture-rfc §9) — a group is no longer purely
 * "mine," so listing needs both paths. cache()-wrapped (Phase 2.5): the
 * layout's refData AND the Finance Hub dashboard both need this in the same
 * request — per-request read memoization only, mutations are unaffected. */
export const listGroups = cache(async (userId: string): Promise<GroupView[]> => {
  const groups = await prisma.group.findMany({
    where: { OR: [{ createdById: userId }, { members: { some: { participant: { linkedUserId: userId } } } }] },
    include: { members: { include: { participant: true } } },
    orderBy: { id: "asc" },
  });
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    role: g.createdById === userId ? "OWNER" : (g.members.find((m) => m.participant.linkedUserId === userId)?.role ?? "MEMBER"),
    members: g.members.map((m) => ({
      participantId: m.participantId,
      name: m.participant.displayName,
      initial: m.participant.displayName.charAt(0).toUpperCase(),
      color: m.participant.color ?? "#6d5ae6",
      role: m.role,
    })),
  }));
});

async function assertParticipantsOwnedBy(ownerId: string, participantIds: string[]) {
  const count = await prisma.participant.count({ where: { id: { in: participantIds }, ownerId } });
  if (count !== participantIds.length) throw new Error("Friend not found");
}

/** group-expenses-sprint: every new group gets its own EXPENSE category
 * namespace, seeded once at creation — never derived from the creator's
 * personal list (that would tie the group's categories to whoever happened
 * to create it, contradicting "categories belong to the group, not the
 * creator"). One $transaction so a group never exists half-seeded. */
export async function createGroup(userId: string, name: string, participantIds: string[]) {
  await assertParticipantsOwnedBy(userId, participantIds);
  await prisma.$transaction(async (db) => {
    const group = await db.group.create({
      data: {
        name,
        createdById: userId,
        members: { create: participantIds.map((participantId) => ({ participantId })) },
      },
    });
    await db.category.createMany({
      data: GROUP_DEFAULT_CATEGORIES.map((c) => ({ groupId: group.id, name: c.name, kind: c.kind, icon: c.icon, color: c.color })),
    });
  });
}

/** OWNER-only: renaming/deleting the group and changing roles are the one
 * tier ADMIN doesn't reach (rfc §3's table). */
export async function renameGroup(userId: string, groupId: string, name: string) {
  await assertGroupRole(prisma, userId, groupId, "OWNER");
  await prisma.group.update({ where: { id: groupId }, data: { name } });
}

/** ADMIN+ may add members, but only from the GROUP'S OWN CREATOR's contact
 * list — a group's member roster has one canonical identity source (rfc
 * §1), so an admin manages membership from the existing roster rather than
 * reaching into the creator's private contacts to invent new entries. */
export async function addGroupMember(userId: string, groupId: string, participantId: string) {
  const group = await assertGroupRole(prisma, userId, groupId, "ADMIN");
  await assertParticipantsOwnedBy(group.createdById, [participantId]);
  await prisma.groupMember.upsert({
    where: { groupId_participantId: { groupId, participantId } },
    create: { groupId, participantId },
    update: {},
  });
}

/** ADMIN+ may remove a MEMBER; only the OWNER may remove an ADMIN. Nobody
 * removes the OWNER this way — that's leaveGroup()/ownership transfer. */
export async function removeGroupMember(userId: string, groupId: string, participantId: string) {
  const group = await assertGroupRole(prisma, userId, groupId, "ADMIN");
  const target = await prisma.groupMember.findUnique({ where: { groupId_participantId: { groupId, participantId } } });
  if (!target) return; // already not a member — idempotent
  if (target.role === "ADMIN" && group.role !== "OWNER") throw new NotAuthorizedError("Only the group owner can remove an admin.");
  await prisma.groupMember.delete({ where: { groupId_participantId: { groupId, participantId } } });
}

/** OWNER-only. */
export async function changeGroupMemberRole(userId: string, groupId: string, participantId: string, role: GroupRole) {
  await assertGroupRole(prisma, userId, groupId, "OWNER");
  await prisma.groupMember.update({ where: { groupId_participantId: { groupId, participantId } }, data: { role } });
}

/** OWNER-only. */
export async function deleteGroup(userId: string, groupId: string) {
  await assertGroupRole(prisma, userId, groupId, "OWNER");
  await prisma.group.delete({ where: { id: groupId } });
}

/**
 * Self-removal (rfc §3.1). Any MEMBER/ADMIN may leave at will — you never
 * need someone else's permission to remove yourself. The OWNER cannot leave
 * while other members remain (ownership transfer is a real schema question —
 * Participant rows always represent *someone else*, and there is currently
 * no way to represent "the former owner" as a member of their own former
 * group without a self-referential Participant; deliberately not built in
 * this pass — see the collaboration-architecture-rfc.md follow-up note).
 * If the OWNER is the only member left, leaving deletes the group, reusing
 * deleteGroup's own authorization-free internal path since "the sole owner
 * of an otherwise-empty group" is definitionally authorized to remove it.
 */
export async function leaveGroup(userId: string, groupId: string) {
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) throw new Error("Group not found");

  if (group.createdById === userId) {
    const otherMembers = await prisma.groupMember.count({ where: { groupId } });
    if (otherMembers > 0) {
      throw new Error(
        "Ownership transfer isn't available yet — remove the other members first if you want to delete the group instead."
      );
    }
    await prisma.group.delete({ where: { id: groupId } });
    return;
  }

  const membership = await prisma.groupMember.findFirst({ where: { groupId, participant: { linkedUserId: userId } } });
  if (!membership) throw new Error("You're not a member of this group.");
  await prisma.groupMember.delete({ where: { groupId_participantId: { groupId, participantId: membership.participantId } } });
}
