// Who a group expense may be split with (P0-2).
//
// This is a DATA-INTEGRITY check, deliberately separate from authorization.
// authorization.ts answers "may this caller write here?"; this module answers
// "do these people belong here?". They fail for different reasons and deserve
// different errors: one is a permission problem, the other is a malformed
// expense. Conflating them would let a legitimate member quietly file a split
// against somebody outside the roster.
//
// Until now the only thing standing between the ledger and that state was
// inferGroupForMembers() in the expense form — a React component. Anything
// that does not run that component reaches the writers directly: the offline
// outbox replaying a payload composed against a since-changed roster, an
// import, a server action called straight, or simply an older client. The
// server has to be the boundary, because it is the only participant in this
// system that every path goes through.

import type { Prisma } from "@prisma/client";

type Db = Prisma.TransactionClient;

/**
 * A split names somebody who is not in the group it is filed under.
 *
 * Separate from NotAuthorizedError on purpose: nothing is being forbidden to
 * the caller, the expense itself does not describe a possible arrangement.
 */
export class GroupMembershipError extends Error {
  readonly participantNames: string[];

  constructor(groupName: string, participantNames: string[]) {
    const who =
      participantNames.length === 1
        ? `${participantNames[0]} is not a member`
        : `${participantNames.slice(0, -1).join(", ")} and ${participantNames.at(-1)} are not members`;
    super(`${who} of ${groupName}. Add them to the group, or remove them from the split.`);
    this.participantNames = participantNames;
  }
}

/**
 * Every participant a group expense touches must currently be in that group.
 *
 * `participantIds` may contain nulls — the owner's own share is stored that
 * way — and those are skipped: the owner's standing in the group is settled by
 * the authorization check that runs alongside this one, and a group always has
 * its creator. Duplicates are fine; they collapse.
 *
 * The roster is read inside the caller's transaction, so a concurrent removal
 * cannot slip between validation and write.
 */
export async function assertParticipantsInGroup(
  db: Db,
  groupId: string,
  participantIds: (string | null | undefined)[]
): Promise<void> {
  const ids = [...new Set(participantIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return;

  const members = await db.groupMember.findMany({
    where: { groupId, participantId: { in: ids } },
    select: { participantId: true },
  });
  const roster = new Set(members.map((m) => m.participantId));
  const outsiders = ids.filter((id) => !roster.has(id));
  if (outsiders.length === 0) return;

  // Name them. "cmt1au…is not a member" is useless to the person who has to
  // fix it, and ids have no business reaching a user-facing message.
  const [group, people] = await Promise.all([
    db.group.findUnique({ where: { id: groupId }, select: { name: true } }),
    db.participant.findMany({ where: { id: { in: outsiders } }, select: { id: true, displayName: true } }),
  ]);
  const byId = new Map(people.map((p) => [p.id, p.displayName]));
  throw new GroupMembershipError(
    group?.name ?? "that group",
    outsiders.map((id) => byId.get(id) ?? "Someone")
  );
}
