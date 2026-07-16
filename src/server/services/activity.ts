// Activity Timeline read path (RFC Phase 1). The audit log's first-ever
// reader: one cursor-paginated query with the event allowlist pushed into
// SQL, plus three small label lookups (categories/accounts/participants)
// per page — labels for *live* entities; deleted ones fall back to the
// names embedded in the audit snapshots. No joins, no writes.

import {
  ACTIVITY_ALLOWLIST,
  CHIP_ENTITIES,
  presentAuditRow,
  type ActivityChip,
  type LabelMaps,
  type TimelineEvent,
} from "@/lib/activity";
import { prisma } from "../db";
import { listCategories } from "./categories";

const PAGE_SIZE = 50;

export interface ActivityPageResult {
  events: TimelineEvent[];
  nextCursor: string | null;
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

export async function activityPage(
  userId: string,
  opts: { chip?: ActivityChip; start?: Date; end?: Date; cursor?: string } = {}
): Promise<ActivityPageResult> {
  const entities = opts.chip && opts.chip !== "all" ? new Set(CHIP_ENTITIES[opts.chip]) : null;
  const allow = ACTIVITY_ALLOWLIST.filter((a) => !entities || entities.has(a.entity));

  const [rows, maps] = await Promise.all([
    prisma.auditLog.findMany({
      where: {
        userId,
        OR: allow.map((a) => ({ entity: a.entity, action: { in: a.actions } })),
        ...(opts.start || opts.end
          ? { at: { ...(opts.start ? { gte: opts.start } : {}), ...(opts.end ? { lt: opts.end } : {}) } }
          : {}),
      },
      orderBy: [{ at: "desc" }, { id: "desc" }],
      take: PAGE_SIZE + 1, // +1 = hasMore probe
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    }),
    labelMaps(userId),
  ]);

  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  const events: TimelineEvent[] = [];
  for (const r of page) {
    const ev = presentAuditRow(
      { id: r.id, action: r.action, entity: r.entity, entityId: r.entityId, before: r.before, after: r.after, at: r.at.toISOString() },
      maps
    );
    if (ev) events.push(ev); // nulls = no-op edits / unknown kinds, skipped by design
  }

  return { events, nextCursor: hasMore ? page[page.length - 1].id : null };
}
