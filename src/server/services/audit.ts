import type { Prisma } from "@prisma/client";

export type Db = Prisma.TransactionClient;

/** Append an audit row inside the same DB transaction as the money-bearing write.
 * `userId` keeps its original meaning — whose ledger this is filed under — unchanged
 * by collaboration-architecture-rfc.md. `actorUserId` is new (§5): who actually
 * performed the action, only ever different from `userId` when an authorized group
 * member edits a transaction they don't own. Omit it (or pass the same id) for every
 * owner-acting-on-their-own-data call site — which is still every call site outside
 * the group-authorization path. */
export async function audit(
  db: Db,
  userId: string,
  action: string,
  entity: string,
  entityId: string,
  before?: unknown,
  after?: unknown,
  actorUserId?: string
) {
  await db.auditLog.create({
    data: {
      userId,
      action,
      entity,
      entityId,
      before: before === undefined ? undefined : JSON.parse(JSON.stringify(before, bigintSafe)),
      after: after === undefined ? undefined : JSON.parse(JSON.stringify(after, bigintSafe)),
      actorUserId: actorUserId && actorUserId !== userId ? actorUserId : null,
    },
  });
}

function bigintSafe(_k: string, v: unknown) {
  return typeof v === "bigint" ? Number(v) : v;
}
