// Phase 2.5 Finance Hub: the dashboard's Recent Activity panel — the most
// recent financial events regardless of module, reusing the Activity
// Timeline's already-presented TimelineEvent shape (icon/summary/ts) rather
// than re-deriving anything. Server component; rows link to /activity.

import Link from "next/link";
import type { TimelineEvent } from "@/lib/activity";
import { EmptyState } from "@/components/shell/empty-state";
import { SectionHeader } from "@/components/shell/section-header";

function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
}

export function RecentActivityPanel({ events }: { events: TimelineEvent[] }) {
  return (
    <section className="card p-[var(--pad)] flex-[1_1_280px] flex flex-col gap-1 min-w-0">
      <SectionHeader title="Recent activity" href="/activity" />
      {events.length === 0 && <EmptyState icon="🕐" title="No activity yet" detail="Every change to your money shows up here." compact />}
      {events.map((ev) => (
        <Link
          key={ev.activityId}
          href="/activity"
          className="flex items-center gap-2.5 py-[7px] border-b border-line last:border-b-0 no-underline text-ink hover:bg-accsoft -mx-1 px-1 rounded"
        >
          <span className="w-8 h-8 rounded-[9px] grid place-items-center text-[13px] flex-none bg-accsoft" aria-hidden="true">
            {ev.icon}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] font-semibold truncate">{ev.summary}</div>
            <div className="text-[11px] text-mut2 truncate">{ev.entityLabel}</div>
          </div>
          <time dateTime={ev.ts} className="text-[10.5px] text-mut2 flex-none">
            {timeOfDay(ev.ts)}
          </time>
        </Link>
      ))}
    </section>
  );
}
