"use client";

// Client half of the Activity Timeline: chip filtering, day grouping,
// diff rows (3 visible, expandable), Load more. Mirrors tx-list.tsx's
// server-paginated pattern — the page never holds more than the rows the
// user has actually asked for.

import { useState } from "react";
import { activityPageAction } from "@/app/actions";
import { ACTIVITY_CHIPS, CHIP_LABELS, formatDiffRow, type ActivityChip, type TimelineEvent } from "@/lib/activity";
import { friendlyDay } from "@/lib/dates";

const MAX_VISIBLE_DIFF = 3;

function localYmd(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function ActivityList({
  initialEvents,
  initialCursor,
  period,
}: {
  initialEvents: TimelineEvent[];
  initialCursor: string | null;
  period: { p?: string; from?: string; to?: string };
}) {
  const [chip, setChip] = useState<ActivityChip>("all");
  const [events, setEvents] = useState(initialEvents);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  async function selectChip(next: ActivityChip) {
    setChip(next);
    setLoading(true);
    const page = await activityPageAction({ chip: next, period });
    setEvents(page.events);
    setCursor(page.nextCursor);
    setLoading(false);
  }

  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    const page = await activityPageAction({ chip, period, cursor });
    setEvents((e) => [...e, ...page.events]);
    setCursor(page.nextCursor);
    setLoading(false);
  }

  // group into day sections, preserving server order (newest first)
  const groups: { label: string; items: TimelineEvent[] }[] = [];
  for (const ev of events) {
    const label = friendlyDay(localYmd(ev.ts));
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(ev);
    else groups.push({ label, items: [ev] });
  }

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      <div className="flex gap-1 bg-card border border-line rounded-[9px] p-[3px] self-start max-w-full overflow-x-auto">
        {ACTIVITY_CHIPS.map((c) => (
          <button
            key={c}
            onClick={() => selectChip(c)}
            className="px-3 py-1.5 rounded-[7px] text-xs font-semibold cursor-pointer border-none whitespace-nowrap"
            style={{ background: chip === c ? "var(--acc)" : "transparent", color: chip === c ? "#fff" : "var(--mut)" }}
          >
            {CHIP_LABELS[c]}
          </button>
        ))}
      </div>

      {!loading && events.length === 0 && (
        <div className="text-center py-[60px] px-5 text-mut2 text-[13px]">
          Your activity will appear here — every change to your money, in plain English.
        </div>
      )}

      {groups.map((g) => (
        <div key={g.label}>
          <div className="text-[11px] font-bold text-mut2 tracking-[.06em] mx-0.5 mt-1 mb-2 uppercase">{g.label}</div>
          <div className="card px-4 py-1.5">
            {g.items.map((ev) => {
              const showAll = !!expanded[ev.activityId];
              const visible = showAll ? ev.diff : ev.diff.slice(0, MAX_VISIBLE_DIFF);
              const hidden = ev.diff.length - MAX_VISIBLE_DIFF;
              return (
                <div key={ev.activityId} className="flex items-start gap-3 py-[11px] border-b border-line last:border-b-0">
                  <div className="w-9 h-9 rounded-[11px] grid place-items-center text-[15px] flex-none bg-accsoft" aria-hidden="true">
                    {ev.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <div className="text-[13px] font-semibold flex-1 truncate">{ev.summary}</div>
                      <time dateTime={ev.ts} className="text-[11px] text-mut2 flex-none">
                        {timeOfDay(ev.ts)}
                      </time>
                    </div>
                    <div className="text-[12.5px] text-mut truncate">
                      {ev.entityLabel}
                      {ev.detail ? <span className="text-mut2"> · {ev.detail}</span> : null}
                    </div>
                    {visible.map((d) => (
                      <div key={d.field} className="text-[11.5px] text-mut2 mt-0.5">
                        <span className="font-semibold text-mut">{d.fieldLabel}</span> {formatDiffRow(d)}
                      </div>
                    ))}
                    {hidden > 0 && !showAll && (
                      <button
                        onClick={() => setExpanded((s) => ({ ...s, [ev.activityId]: true }))}
                        className="text-[11.5px] text-acc font-semibold bg-transparent border-none p-0 mt-0.5 cursor-pointer"
                      >
                        +{hidden} more change{hidden === 1 ? "" : "s"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {cursor && (
        <button
          disabled={loading}
          onClick={loadMore}
          className="self-center px-4 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-acc cursor-pointer hover:bg-accsoft disabled:opacity-50"
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
