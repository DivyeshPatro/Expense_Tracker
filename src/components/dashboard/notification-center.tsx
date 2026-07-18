"use client";

// Phase 2.5 Notification Center — one urgency-sorted feed on the dashboard
// (per user decision: a dashboard panel, not the header bell). The server
// builds the calendar-ish sources (lending reminders, bills, settlements);
// this client shell prepends offline sync issues from the outbox, which
// only exist in this browser's IndexedDB and can't be server-rendered.

import { buildFeed, type FeedItem, type SettlementForFeed, type BillForFeed } from "@/lib/notification-feed";
import type { ReminderCandidate } from "@/lib/lending-reminders";
import { EmptyState } from "@/components/shell/empty-state";
import { SectionHeader } from "@/components/shell/section-header";
import { intentLabel, useOffline } from "@/components/shell/offline-context";
import { useUI } from "@/components/shell/ui-context";
import Link from "next/link";

const VISIBLE_LIMIT = 6;

const URGENCY_COLORS: Record<number, string> = {
  0: "var(--red)",
  1: "var(--red)",
  2: "var(--amber)",
  3: "var(--mut2)",
};

export function NotificationCenter({
  reminders,
  bills,
  settlements,
}: {
  reminders: ReminderCandidate[];
  bills: BillForFeed[];
  settlements: SettlementForFeed[];
}) {
  const { needsAttention } = useOffline();
  const { openModal } = useUI();

  const feed = buildFeed({
    reminders,
    bills,
    settlements,
    syncIssues: needsAttention.map((i) => ({ intentId: i.intentId, label: intentLabel(i) })),
  });

  const visible = feed.slice(0, VISIBLE_LIMIT);
  const hidden = feed.length - visible.length;

  return (
    <section className="card p-[var(--pad)] flex-[1_1_280px] flex flex-col gap-1">
      <SectionHeader title="Needs your attention" />
      {feed.length === 0 && <EmptyState icon="✅" title="All caught up" detail="Reminders and pending items will show up here." compact />}
      {visible.map((item) => {
        const row = (
          <>
            <span className="w-8 h-8 rounded-[9px] grid place-items-center text-[13px] flex-none bg-accsoft" aria-hidden="true">
              {item.icon}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-semibold truncate">{item.title}</div>
              {item.detail && (
                <div className="text-[11px] font-semibold truncate" style={{ color: URGENCY_COLORS[item.urgency] }}>
                  {item.detail}
                </div>
              )}
            </div>
          </>
        );
        const rowClass =
          "flex items-center gap-2.5 py-[7px] border-b border-line last:border-b-0 w-full text-left no-underline text-ink bg-transparent border-x-0 border-t-0 cursor-pointer hover:bg-accsoft -mx-1 px-1 rounded";
        if (item.link.type === "route") {
          return (
            <Link key={item.id} href={item.link.href} className={rowClass}>
              {row}
            </Link>
          );
        }
        const link = item.link;
        return (
          <button
            key={item.id}
            onClick={() =>
              link.type === "loanDetail" ? openModal("loanDetail", { loanEntryId: link.loanEntryId }) : openModal("pendingDetail", { intentId: link.intentId })
            }
            className={rowClass}
          >
            {row}
          </button>
        );
      })}
      {hidden > 0 && <div className="text-[11px] text-mut2 pt-1">+{hidden} more</div>}
    </section>
  );
}

export type { FeedItem };
