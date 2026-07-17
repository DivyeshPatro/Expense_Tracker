// Group-collaborative authorization (collaboration-architecture-rfc.md §1–§3).
// A transaction's own `userId` can always read/write/delete it — that path is
// unchanged from the solo-owner model Phases 0–3 were built against. This
// module adds the SECOND path: an authorized member of `Transaction.groupId`.
// Every check here is re-derived live from the database on every call —
// never cached, never trusted from the client (§10 — the server is the sole
// authority, same non-negotiable the offline-sync spec already established).

import type { GroupRole, Prisma } from "@prisma/client";

type Db = Prisma.TransactionClient;

export class NotAuthorizedError extends Error {
  constructor(message = "You don't have permission to do that.") {
    super(message);
  }
}

export type WriteAction = "write" | "write-account" | "delete";

const ROLE_RANK: Record<GroupRole, number> = { MEMBER: 1, ADMIN: 2, OWNER: 3 };

export function roleAtLeast(role: GroupRole | null, min: GroupRole): boolean {
  return role !== null && ROLE_RANK[role] >= ROLE_RANK[min];
}

/** A real user's role within a group: implicit OWNER via `Group.createdById`
 * (the creator never gets a GroupMember row of their own — rfc §3.1),
 * otherwise resolved through GroupMember → Participant.linkedUserId. Null
 * means "not a member" — the caller is not authorized via this group. */
export async function resolveGroupRole(db: Db, groupId: string, actingUserId: string): Promise<GroupRole | null> {
  const group = await db.group.findUnique({ where: { id: groupId }, select: { createdById: true } });
  if (!group) return null;
  if (group.createdById === actingUserId) return "OWNER";
  const membership = await db.groupMember.findFirst({
    where: { groupId, participant: { linkedUserId: actingUserId } },
    select: { role: true },
  });
  return membership?.role ?? null;
}

/** Read authorization (rfc §2): the row's own userId, or any group member of
 * any role. */
export async function assertCanRead(db: Db, actingUserId: string, tx: { userId: string; groupId: string | null }): Promise<void> {
  if (tx.userId === actingUserId) return;
  if (tx.groupId) {
    const role = await resolveGroupRole(db, tx.groupId, actingUserId);
    if (role) return;
  }
  throw new NotAuthorizedError();
}

/**
 * Write authorization (rfc §1/§2/§3). The row's own userId can always write.
 * For anyone else:
 *   - "write-account" (setting/changing accountId) is refused outright — a
 *     real bank account reference is never editable by a non-owning member,
 *     regardless of role (rfc §1's field-level lock).
 *   - "write" (every other field) needs MEMBER role+ in the transaction's group.
 *   - "delete" needs ADMIN role+ in the transaction's group.
 * Callers pass "write-account" whenever the incoming payload's accountId
 * actually differs from the current value — an unchanged accountId in a
 * resubmitted form is not a write to that field (rfc §15's "field-level, not
 * request-level" requirement: the WHOLE write rejects if it contains a
 * disallowed accountId change, never silently dropped).
 */
export async function assertCanWrite(
  db: Db,
  actingUserId: string,
  tx: { userId: string; groupId: string | null },
  action: WriteAction
): Promise<void> {
  if (tx.userId === actingUserId) return;
  if (action === "write-account") {
    throw new NotAuthorizedError("Only the account's owner can change which account this is paid from.");
  }
  if (!tx.groupId) throw new NotAuthorizedError();
  const role = await resolveGroupRole(db, tx.groupId, actingUserId);
  const required: GroupRole = action === "delete" ? "ADMIN" : "MEMBER";
  if (!roleAtLeast(role, required)) throw new NotAuthorizedError();
}

/** Create authorization for a NEW transaction tagged with a group (rfc
 * §2/§4): any member, MEMBER role+. The creator becomes the row's own
 * userId, so no further per-field checks apply to their own create. */
export async function assertCanCreateInGroup(db: Db, actingUserId: string, groupId: string): Promise<void> {
  const role = await resolveGroupRole(db, groupId, actingUserId);
  if (!roleAtLeast(role, "MEMBER")) throw new NotAuthorizedError();
}

/** Group-management authorization (rfc §3): resolves the group (throwing a
 * plain not-found if it doesn't exist — group existence isn't sensitive the
 * way transaction contents are) and requires at least `minRole`. Returns the
 * group row so callers don't have to fetch it twice. */
export async function assertGroupRole(db: Db, actingUserId: string, groupId: string, minRole: GroupRole) {
  const group = await db.group.findUnique({ where: { id: groupId } });
  if (!group) throw new Error("Group not found");
  const role = await resolveGroupRole(db, groupId, actingUserId);
  if (!roleAtLeast(role, minRole)) throw new NotAuthorizedError();
  return { ...group, role: role! };
}
