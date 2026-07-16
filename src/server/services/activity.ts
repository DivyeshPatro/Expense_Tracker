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
  };
}

const toRowInput = (r: { id: string; action: string; entity: string; entityId: string; before: unknown; after: unknown; at: Date }): AuditRowInput => ({
  id: r.id,
  action: r.action,
  entity: r.entity,
  entityId: r.entityId,
  before: r.before,
  after: r.after,
  at: r.at.toISOString(),
});

export async function activityPage(
  userId: string,
  opts: { chip?: ActivityChip; entityId?: string; start?: Date; end?: Date; cursor?: string } = {}
): Promise<ActivityPageResult> {
  const cursor = parseCursor(opts.cursor);
  const entities = opts.chip && opts.chip !== "all" ? new Set(CHIP_ENTITIES[opts.chip]) : null;
  const allow = ACTIVITY_ALLOWLIST.filter((a) => !entities || entities.has(a.entity));
  const timeRange =
    opts.start || opts.end ? { ...(opts.start ? { gte: opts.start } : {}), ...(opts.end ? { lt: opts.end } : {}) } : undefined;
  // budget-exceeded rides the "all" and "budgets" chips; an entity filter is
  // a transaction-history view, where notifications don't belong
  const includeNotifs = !opts.entityId && (!opts.chip || opts.chip === "all" || opts.chip === "budgets");

  const [auditRows, notifRows, maps] = await Promise.all([
    prisma.auditLog.findMany({
      where: {
        userId,
        OR: allow.map((a) => ({ entity: a.entity, action: { in: a.actions } })),
        ...(opts.entityId ? { entityId: opts.entityId } : {}),
        ...(timeRange ? { at: timeRange } : {}),
      },
      orderBy: [{ at: "desc" }, { id: "desc" }],
      take: PAGE_SIZE + 1,
      ...(cursor.a ? { cursor: { id: cursor.a }, skip: 1 } : {}),
    }),
    includeNotifs
      ? prisma.notification.findMany({
          where: { userId, kind: "BUDGET_EXCEEDED", ...(timeRange ? { createdAt: timeRange } : {}) },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: PAGE_SIZE + 1,
          ...(cursor.n ? { cursor: { id: cursor.n }, skip: 1 } : {}),
        })
      : Promise.resolve([]),
    labelMaps(userId),
  ]);

  const auditHasMore = auditRows.length > PAGE_SIZE;
  const notifHasMore = notifRows.length > PAGE_SIZE;

  // present both streams; each emitted event remembers which source row it
  // consumed last so the composite cursor can resume both streams exactly
  type Sourced = { ev: TimelineEvent; src: "a" | "n"; consumedId: string };
  const sourced: Sourced[] = [];

  for (const item of groupUpdateChains((auditHasMore ? auditRows.slice(0, PAGE_SIZE) : auditRows).map(toRowInput))) {
    if (Array.isArray(item)) {
      const ev = presentChain(item, maps);
      if (ev) sourced.push({ ev, src: "a", consumedId: item[item.length - 1].id });
    } else {
      const ev = presentAuditRow(item, maps);
      if (ev) sourced.push({ ev, src: "a", consumedId: item.id });
    }
  }
  for (const n of notifHasMore ? notifRows.slice(0, PAGE_SIZE) : notifRows) {
    const ev = presentNotificationRow({ id: n.id, kind: n.kind, payload: n.payload, createdAt: n.createdAt.toISOString() });
    if (ev) sourced.push({ ev, src: "n", consumedId: n.id });
  }

  sourced.sort((x, y) => (x.ev.ts === y.ev.ts ? (x.ev.activityId < y.ev.activityId ? 1 : -1) : x.ev.ts < y.ev.ts ? 1 : -1));

  const page = sourced.slice(0, PAGE_SIZE);
  const leftovers = sourced.length > PAGE_SIZE;
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
 * history shows every step. `more` signals the "Full history" link. */
export async function entityHistory(userId: string, entityId: string): Promise<{ events: TimelineEvent[]; more: boolean }> {
  const [rows, maps] = await Promise.all([
    prisma.auditLog.findMany({
      where: { userId, entity: "Transaction", entityId },
      orderBy: [{ at: "desc" }, { id: "desc" }],
      take: HISTORY_CAP + 1,
    }),
    labelMaps(userId),
  ]);
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
