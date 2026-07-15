// Group management — Group/GroupMember already existed in the schema (used
// read-only by shared.ts's firstGroup()) but had no CRUD until now.

import { prisma } from "../db";

export interface GroupView {
  id: string;
  name: string;
  members: { participantId: string; name: string; initial: string; color: string }[];
}

export async function listGroups(userId: string): Promise<GroupView[]> {
  const groups = await prisma.group.findMany({
    where: { createdById: userId },
    include: { members: { include: { participant: true } } },
    orderBy: { id: "asc" },
  });
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    members: g.members.map((m) => ({
      participantId: m.participantId,
      name: m.participant.displayName,
      initial: m.participant.displayName.charAt(0).toUpperCase(),
      color: m.participant.color ?? "#6d5ae6",
    })),
  }));
}

async function assertOwnedParticipants(userId: string, participantIds: string[]) {
  const count = await prisma.participant.count({ where: { id: { in: participantIds }, ownerId: userId } });
  if (count !== participantIds.length) throw new Error("Friend not found");
}

async function assertOwnedGroup(userId: string, groupId: string) {
  const group = await prisma.group.findFirst({ where: { id: groupId, createdById: userId } });
  if (!group) throw new Error("Group not found");
  return group;
}

export async function createGroup(userId: string, name: string, participantIds: string[]) {
  await assertOwnedParticipants(userId, participantIds);
  await prisma.group.create({
    data: {
      name,
      createdById: userId,
      members: { create: participantIds.map((participantId) => ({ participantId })) },
    },
  });
}

export async function renameGroup(userId: string, groupId: string, name: string) {
  await assertOwnedGroup(userId, groupId);
  await prisma.group.update({ where: { id: groupId }, data: { name } });
}

export async function addGroupMember(userId: string, groupId: string, participantId: string) {
  await assertOwnedGroup(userId, groupId);
  await assertOwnedParticipants(userId, [participantId]);
  await prisma.groupMember.upsert({
    where: { groupId_participantId: { groupId, participantId } },
    create: { groupId, participantId },
    update: {},
  });
}

export async function removeGroupMember(userId: string, groupId: string, participantId: string) {
  await assertOwnedGroup(userId, groupId);
  await prisma.groupMember.deleteMany({ where: { groupId, participantId } });
}

export async function deleteGroup(userId: string, groupId: string) {
  await assertOwnedGroup(userId, groupId);
  await prisma.group.delete({ where: { id: groupId } });
}
