// Activity Timeline (RFC Phase 1): a curated, human-readable projection of
// the audit log — "what happened to my money?", in plain English, one page.
// Period-aware like Dashboard/Transactions (shared header picker); chips and
// pagination happen client-side against activityPageAction.

import { parsePeriod } from "@/lib/period";
import { activityPage } from "@/server/services/activity";
import { requireUser } from "@/server/session";
import { ActivityList } from "./activity-list";

export const dynamic = "force-dynamic";

export default async function ActivityPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const period = parsePeriod(sp);
  const { events, nextCursor } = await activityPage(user.id, { start: period.range.start, end: period.range.end });

  return (
    <ActivityList
      initialEvents={events}
      initialCursor={nextCursor}
      period={{ p: sp.p, from: sp.from, to: sp.to }}
    />
  );
}
