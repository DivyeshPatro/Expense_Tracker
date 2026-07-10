import type { Prisma } from "@prisma/client";

type Db = Prisma.TransactionClient;

/** Append an audit row inside the same DB transaction as the money-bearing write. */
export async function audit(
  db: Db,
  userId: string,
  action: string,
  entity: string,
  entityId: string,
  before?: unknown,
  after?: unknown
) {
  await db.auditLog.create({
    data: {
      userId,
      action,
      entity,
      entityId,
      before: before === undefined ? undefined : JSON.parse(JSON.stringify(before, bigintSafe)),
      after: after === undefined ? undefined : JSON.parse(JSON.stringify(after, bigintSafe)),
    },
  });
}

function bigintSafe(_k: string, v: unknown) {
  return typeof v === "bigint" ? Number(v) : v;
}
