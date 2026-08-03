// Activity Timeline read path (RFC Phases 1–2). Two sources, one projection:
// the audit log (every user action) and the Notification table (the single
// notification-sourced kind, budget-exceeded), merged by timestamp with a
// composite per-source cursor. Labels come from small per-page lookups for
// live entities; deleted ones fall back to the audit snapshots. No joins.

import {
  ACTIVITY_ALLOWLIST,
  CHIP_ENTITIES,
  groupUpdateChains,
  presentAuditRow,
  presentChain,
  presentNotificationRow,
  type ActivityChip,
  type AuditRowInput,
  type LabelMaps,
  type TimelineEvent,
} from "@/lib/activity";
import { prisma } from "../db";
import { assertCanRead } from "./authorization";
import { listCategories } from "./categories";

const PAGE_SIZE = 50;
const HISTORY_CAP = 10; // RFC §4: detail-sheet history shows the 10 most recent entries

export interface ActivityPageResult {
  events: TimelineEvent[];
  nextCursor: string | null;
}

interface Cursor {
  a?: string; // last consumed audit row id
  n?: string; // last consumed notification id
}

function parseCursor(raw?: string): Cursor {
  if (!raw) return {};
  try {
    const c = JSON.parse(raw);
    return { a: typeof c.a === "string" ? c.a : undefined, n: typeof c.n === "string" ? c.n : undefined };
  } catch {
    return {};
  }
}

async function labelMaps(userId: string): Promise<LabelMaps> {
  const [categories, accounts, participants] = await Promise.all([
    listCategories(userId), // react-cache()d — shared with the layout's fetch
    prisma.account.findMany({ where: { userId }, select: { id: true, name: true } }),
    prisma.participant.findMany({ where: { ownerId: userId }, select: { id: true, displayName: true } }),
  ]);
  return {
    categories: new Map(categories.map((c) => [c.id, { name: c.name, icon: c.icon ?? "🏷" }])),
    accounts: new Map(accounts.map((a) => [a.id, a.name])),
    participants: new Map(participants.map((p) => [p.id, p.displayName])),
    actorNames: new Map(), // filled in by actorNameMap() below, once the actual rows are known
  };
}

/** collaboration-architecture-rfc §5: resolves whichever real users actually
 * show up as `actorUserId` in the current page/history slice — not scoped to
 * a single ledger owner the way categories/accounts/participants are, since
 * an actor can be any authorized group member. One batched query, skipped
 * entirely when nobody in this slice ever acted on someone else's row (the
 * overwhelmingly common case for a non-collaborating user). */
async function actorNameMap(actorIds: string[]): Promise<Map<string, string>> {
  if (actorIds.length === 0) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

const distinctActorIds = (rows: { actorUserId: string | null }[]): string[] => [
  ...new Set(rows.map((r) => r.actorUserId).filter((id): id is string => !!id)),
];

const toRowInput = (r: {
  id: string;
  action: string;
  entity: string;
  entityId: string;
  before: unknown;
  after: unknown;
  at: Date;
  actorUserId: string | null;
}): AuditRowInput => ({
  id: r.id,
  action: r.action,
  entity: r.entity,
  entityId: r.entityId,
  before: r.before,
  after: r.after,
  at: r.at.toISOString(),
  actorUserId: r.actorUserId,
});

export async function activityPage(
  userId: string,
  opts: { chip?: ActivityChip; entityId?: string; entityIds?: string[]; entities?: string[]; start?: Date; end?: Date; cursor?: string; limit?: number } = {}
): Promise<ActivityPageResult> {
  // Phase 2.5: `limit` caps both source fetches AND the emitted page — the
  // dashboard's Recent Activity panel needs 6 events, not 50. Chain
  // collapsing can shrink a page below the raw row count, never grow it,
  // so fetching limit+1 per stream still detects "has more" correctly.
  const pageSize = Math.min(opts.limit ?? PAGE_SIZE, PAGE_SIZE);
  const cursor = parseCursor(opts.cursor);
  // `entities` (explicit type list) wins over `chip` — the per-module Audit Log
  // sections need e.g. just Bill (not the combined "Budgets & Bills" chip).
  const entities = opts.entities
    ? new Set(opts.entities)
    : opts.chip && opts.chip !== "all"
      ? new Set(CHIP_ENTITIES[opts.chip])
      : null;
  const allow = ACTIVITY_ALLOWLIST.filter((a) => !entities || entities.has(a.entity));
  const timeRange =
    opts.start || opts.end ? { ...(opts.start ? { gte: opts.start } : {}), ...(opts.end ? { lt: opts.end } : {}) } : undefined;
  // budget-exceeded rides the "all" and "budgets" chips; an entity filter (single
  // id, explicit id set, or type list) is a scoped view where those notifications
  // don't belong — the Group Dashboard's per-group feed is one such scoped view.
  const includeNotifs =
    !opts.entityId && !opts.entityIds && !opts.entities && (!opts.chip || opts.chip === "all" || opts.chip === "budgets");

  const [auditRows, notifRows, maps] = await Promise.all([
    prisma.auditLog.findMany({
      where: {
        userId,
        OR: allow.map((a) => ({ entity: a.entity, action: { in: a.actions } })),
        ...(opts.entityId ? { entityId: opts.entityId } : {}),
        ...(opts.entityIds ? { entityId: { in: opts.entityIds } } : {}),
        ...(timeRange ? { at: timeRange } : {}),
      },
      orderBy: [{ at: "desc" }, { id: "desc" }],
      take: pageSize + 1,
      ...(cursor.a ? { cursor: { id: cursor.a }, skip: 1 } : {}),
    }),
    includeNotifs
      ? prisma.notification.findMany({
          where: { userId, kind: "BUDGET_EXCEEDED", ...(timeRange ? { createdAt: timeRange } : {}) },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: pageSize + 1,
          ...(cursor.n ? { cursor: { id: cursor.n }, skip: 1 } : {}),
        })
      : Promise.resolve([]),
    labelMaps(userId),
  ]);
  maps.actorNames = await actorNameMap(distinctActorIds(auditRows));

  const auditHasMore = auditRows.length > pageSize;
  const notifHasMore = notifRows.length > pageSize;

  // present both streams; each emitted event remembers which source row it
  // consumed last so the composite cursor can resume both streams exactly
  type Sourced = { ev: TimelineEvent; src: "a" | "n"; consumedId: string };
  const sourced: Sourced[] = [];

  for (const item of groupUpdateChains((auditHasMore ? auditRows.slice(0, pageSize) : auditRows).map(toRowInput))) {
    if (Array.isArray(item)) {
      const ev = presentChain(item, maps);
      if (ev) sourced.push({ ev, src: "a", consumedId: item[item.length - 1].id });
    } else {
      const ev = presentAuditRow(item, maps);
      if (ev) sourced.push({ ev, src: "a", consumedId: item.id });
    }
  }
  for (const n of notifHasMore ? notifRows.slice(0, pageSize) : notifRows) {
    const ev = presentNotificationRow({ id: n.id, kind: n.kind, payload: n.payload, createdAt: n.createdAt.toISOString() });
    if (ev) sourced.push({ ev, src: "n", consumedId: n.id });
  }

  sourced.sort((x, y) => (x.ev.ts === y.ev.ts ? (x.ev.activityId < y.ev.activityId ? 1 : -1) : x.ev.ts < y.ev.ts ? 1 : -1));

  const page = sourced.slice(0, pageSize);
  const leftovers = sourced.length > pageSize;
  const hasMore = auditHasMore || notifHasMore || leftovers;

  const next: Cursor = { a: cursor.a, n: cursor.n };
  for (const s of page) {
    if (s.src === "a") next.a = s.consumedId;
    else next.n = s.consumedId;
  }

  return { events: page.map((s) => s.ev), nextCursor: hasMore ? JSON.stringify(next) : null };
}

/** Per-entity slice for the detail sheet's History section (RFC §4): the
 * HISTORY_CAP most recent entries, oldest-first for the rail, no collapse —
 * history shows every step. `more` signals the "Full history" link.
 *
 * collaboration-architecture-rfc §5: AuditLog.userId is always filed under
 * the transaction's OWNER, never the acting editor — so a non-owning group
 * member's own userId never matches these rows as-is. Once assertCanRead
 * confirms group-membership access to the transaction itself, its full audit
 * trail (every authorized member's edits, not just the viewer's own) becomes
 * visible, and labels resolve against the OWNER's namespace (categories/
 * accounts/participants the diff actually references), never the viewer's
 * own unrelated ids. A transaction that's gone or not authorized falls back
 * to the pre-existing owner-only scoping, matching solo behavior byte for byte. */
export async function entityHistory(actingUserId: string, entityId: string): Promise<{ events: TimelineEvent[]; more: boolean }> {
  const tx = await prisma.transaction.findFirst({ where: { id: entityId }, select: { userId: true, groupId: true } });
  let ownerId = actingUserId;
  if (tx) {
    try {
      await assertCanRead(prisma, actingUserId, tx);
      ownerId = tx.userId;
    } catch {
      // not authorized — fall through to the strict self-scoped query below,
      // which correctly returns nothing for someone with no legitimate access
    }
  }
  const [rows, maps] = await Promise.all([
    prisma.auditLog.findMany({
      where: { userId: ownerId, entity: "Transaction", entityId },
      orderBy: [{ at: "desc" }, { id: "desc" }],
      take: HISTORY_CAP + 1,
    }),
    labelMaps(ownerId),
  ]);
  maps.actorNames = await actorNameMap(distinctActorIds(rows));
  const more = rows.length > HISTORY_CAP;
  const events: TimelineEvent[] = [];
  for (const r of rows.slice(0, HISTORY_CAP)) {
    const ev = presentAuditRow(toRowInput(r), maps);
    if (ev) events.push(ev);
  }
  events.reverse(); // oldest first — a single entity's history reads as a story
  return { events, more };
}

/** The one bounded related-events query (RFC §7): top merchants of an import
 * batch, LIMIT 5, run only when the user expands an import event. */
export async function importPreview(userId: string, batchId: string): Promise<{ merchants: string[] }> {
  const groups = await prisma.transaction.groupBy({
    by: ["merchant"],
    where: { userId, importBatchId: batchId, deletedAt: null },
    _count: { merchant: true },
    orderBy: { _count: { merchant: "desc" } },
    take: 5,
  });
  return { merchants: groups.map((g) => g.merchant) };
}
