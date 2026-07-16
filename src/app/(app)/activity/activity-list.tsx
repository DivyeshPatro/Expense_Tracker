"use client";

// Client half of the Activity Timeline: chip filtering, day grouping,
// diff rows (3 visible, expandable), collapsed edit chains (net diff +
// step-through), import related-chips expansion (the one bounded query,
// fetched on demand), and Load more. Mirrors tx-list.tsx's server-paginated
// pattern — the page never holds more than the rows the user asked for.

import Link from "next/link";
import { useState } from "react";
import { activityPageAction, importPreviewAction } from "@/app/actions";
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
  entityFilter,
}: {
  initialEvents: TimelineEvent[];
  initialCursor: string | null;
  period: { p?: string; from?: string; to?: string };
  entityFilter: string | null;
}) {
  const [chip, setChip] = useState<ActivityChip>("all");
  const [events, setEvents] = useState(initialEvents);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({}); // "+N more changes"
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({}); // collapsed-chain step-through
  const [related, setRelated] = useState<Record<string, { open: boolean; merchants?: string[] }>>({}); // import expansion

  async function selectChip(next: ActivityChip) {
    setChip(next);
    setLoading(true);
    const page = await activityPageAction({ chip: next, period, entity: entityFilter ?? undefined });
    setEvents(page.events);
    setCursor(page.nextCursor);
    setLoading(false);
  }

  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    const page = await activityPageAction({ chip, period, cursor, entity: entityFilter ?? undefined });
    setEvents((e) => [...e, ...page.events]);
    setCursor(page.nextCursor);
    setLoading(false);
  }

  async function toggleRelated(ev: TimelineEvent) {
    const cur = related[ev.activityId];
    if (cur?.open) {
      setRelated((s) => ({ ...s, [ev.activityId]: { ...cur, open: false } }));
      return;
    }
    setRelated((s) => ({ ...s, [ev.activityId]: { open: true, merchants: cur?.merchants } }));
    if (ev.entityType === "import" && ev.verb === "imported" && !cur?.merchants) {
      const preview = await importPreviewAction(ev.entityId);
      setRelated((s) => ({ ...s, [ev.activityId]: { open: true, merchants: preview.merchants } }));
    }
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
      {entityFilter ? (
        <div className="flex items-center gap-2 text-[12.5px] text-mut">
          Showing one item’s full history
          <Link href="/activity" className="font-semibold text-acc no-underline">Show all activity</Link>
        </div>
      ) : (
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
      )}

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
              const rel = related[ev.activityId];
              const isImport = ev.entityType === "import" && ev.verb === "imported";
              return (
                <div key={ev.activityId} className="flex items-start gap-3 py-[11px] border-b border-line last:border-b-0">
                  <div className="w-9 h-9 rounded-[11px] grid place-items-center text-[15px] flex-none bg-accsoft" aria-hidden="true">
                    {ev.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <div className="text-[13px] font-semibold flex-1 truncate">
                        {ev.summary}
                        {ev.collapsed && <span className="text-mut2 font-medium"> · {ev.collapsed.count} changes</span>}
                      </div>
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
                    {ev.collapsed && (
                      <>
                        <button
                          onClick={() => setOpenSteps((s) => ({ ...s, [ev.activityId]: !s[ev.activityId] }))}
                          className="text-[11.5px] text-acc font-semibold bg-transparent border-none p-0 mt-0.5 cursor-pointer block"
                        >
                          {openSteps[ev.activityId] ? "Hide steps" : "Show each change"}
                        </button>
                        {openSteps[ev.activityId] && (
                          <div className="mt-1 pl-2.5 border-l-2 border-line flex flex-col gap-1.5">
                            {ev.collapsed.members.map((m) => (
                              <div key={m.activityId}>
                                <div className="text-[11px] text-mut2">{timeOfDay(m.ts)}</div>
                                {m.diff.map((d) => (
                                  <div key={d.field} className="text-[11.5px] text-mut2">
                                    <span className="font-semibold text-mut">{d.fieldLabel}</span> {formatDiffRow(d)}
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                    {isImport && (
                      <>
                        <button
                          onClick={() => toggleRelated(ev)}
                          className="text-[11.5px] text-acc font-semibold bg-transparent border-none p-0 mt-0.5 cursor-pointer block"
                        >
                          {rel?.open ? "Hide related" : "Related"}
                        </button>
                        {rel?.open && (
                          <div className="flex gap-1.5 flex-wrap mt-1.5">
                            {ev.related.map((r) => (
                              <Link
                                key={r.href}
                                href={r.href}
                                className="px-2.5 py-1 rounded-full bg-accsoft text-acc text-[11.5px] font-semibold no-underline"
                              >
                                {r.label}
                              </Link>
                            ))}
                            {rel.merchants === undefined && <span className="text-[11.5px] text-mut2">…</span>}
                            {rel.merchants?.map((m) => (
                              <Link
                                key={m}
                                href={`/transactions?q=${encodeURIComponent(m)}&p=all`}
                                className="px-2.5 py-1 rounded-full border border-line2 text-mut text-[11.5px] font-semibold no-underline"
                              >
                                {m}
                              </Link>
                            ))}
                          </div>
                        )}
                      </>
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
