// Per-module Audit Log section (v2.1 #98): the recent audited changes scoped
// to one module's entity types, shown inside that module's page with a link to
// the full Audit Log. Server component — no client state; time is pinned to IST
// so the server-rendered output is deterministic.
import Link from "next/link";
import { activityPage } from "@/server/services/activity";
import { requireUser } from "@/server/session";

function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
}

/**
 * A module's recent audited changes. Scope it either by entity TYPE (`entities`,
 * e.g. the Cards / Bills sections) or by an explicit set of entity IDS
 * (`entityIds`, the Group Dashboard's per-group feed) — the latter wins when
 * both are given. An empty `entityIds` array is a real answer (a group with no
 * activity yet), not "unfiltered", so it correctly shows the empty state.
 */
export async function ModuleActivity({
  entities,
  entityIds,
  limit = 6,
}: {
  entities?: string[];
  entityIds?: string[];
  limit?: number;
}) {
  const user = await requireUser();
  const { events } = await activityPage(user.id, entityIds ? { entityIds, limit } : { entities, limit });

  return (
    <section className="card p-[var(--pad)]">
      <div className="flex justify-between items-baseline mb-1.5">
        <h2 className="text-[13.5px] font-bold m-0">Activity</h2>
        <Link href="/activity" className="text-[11.5px] font-semibold text-acc no-underline">View all →</Link>
      </div>
      {events.length === 0 ? (
        <div className="text-[12px] text-mut2 py-1.5">No recorded changes here yet.</div>
      ) : (
        <div className="flex flex-col">
          {events.map((ev) => (
            <div key={ev.activityId} className="flex items-start gap-3 py-2.5 border-t border-line first:border-t-0">
              <span className="w-8 h-8 rounded-[10px] grid place-items-center text-[14px] flex-none bg-accsoft" aria-hidden>{ev.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <div className="text-[12.5px] font-semibold flex-1 truncate">{ev.summary}</div>
                  <time dateTime={ev.ts} className="text-[10.5px] text-mut2 flex-none">{timeOfDay(ev.ts)}</time>
                </div>
                <div className="text-[11.5px] text-mut truncate">
                  {ev.entityLabel}
                  {ev.detail ? <span className="text-mut2"> · {ev.detail}</span> : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
