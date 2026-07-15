"use client";

// Bell dropdown for the Notification model — budgets.ts and recurring.ts
// already write rows (BUDGET_EXCEEDED/WARNING, RECURRING_CREATED); this is
// the first and only place anything reads them back.

import { useEffect, useRef, useState } from "react";
import { listNotificationsAction, markNotificationsReadAction } from "@/app/actions";
import { formatPaise } from "@/lib/money";
import type { NotificationView } from "@/server/services/notifications";

function timeAgo(d: Date): string {
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function describe(n: NotificationView): { icon: string; text: string } {
  const p = n.payload as Record<string, unknown>;
  switch (n.kind) {
    case "BUDGET_EXCEEDED":
      return { icon: "🔴", text: `${p.category} budget exceeded — ${formatPaise(Number(p.spent))} of ${formatPaise(Number(p.limit))}` };
    case "BUDGET_WARNING":
      return { icon: "🟠", text: `${p.category} budget at ${p.spent && p.limit ? Math.round((Number(p.spent) / Number(p.limit)) * 100) : ""}% — ${formatPaise(Number(p.spent))} of ${formatPaise(Number(p.limit))}` };
    case "RECURRING_CREATED":
      return { icon: "🔁", text: `${p.merchant ?? "Recurring transaction"} added — ${formatPaise(Number(p.amount))}` };
    default:
      return { icon: "🔔", text: n.kind };
  }
}

export function NotificationBell({ initialUnread }: { initialUnread: number }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationView[] | null>(null);
  const [unread, setUnread] = useState(initialUnread);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setUnread(initialUnread), [initialUnread]);

  useEffect(() => {
    if (!open) return;
    listNotificationsAction().then(setItems);
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const markRead = async () => {
    setUnread(0);
    await markNotificationsReadAction();
    setItems((cur) => cur?.map((n) => ({ ...n, readAt: n.readAt ?? new Date() })) ?? null);
  };

  return (
    <div ref={ref} className="relative">
      <button
        aria-label="Notifications"
        onClick={() => setOpen((v) => !v)}
        className="relative w-[34px] h-[34px] rounded-[9px] border border-line2 bg-card grid place-items-center text-sm cursor-pointer hover:border-acc"
      >
        🔔
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-[3px] rounded-full bg-red text-white text-[10px] font-bold grid place-items-center">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          className="absolute right-0 top-[42px] w-[320px] max-w-[85vw] bg-card border border-line rounded-[14px] overflow-hidden z-[80]"
          style={{ boxShadow: "var(--shLg)" }}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-line">
            <span className="text-[13px] font-bold text-ink">Notifications</span>
            {unread > 0 && (
              <button onClick={markRead} className="text-[11.5px] font-semibold text-acc bg-transparent border-none cursor-pointer">
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-[360px] overflow-auto">
            {items === null ? (
              <div className="px-4 py-6 text-center text-[12.5px] text-mut2">Loading…</div>
            ) : items.length === 0 ? (
              <div className="px-4 py-6 text-center text-[12.5px] text-mut2">No notifications yet</div>
            ) : (
              items.map((n) => {
                const { icon, text } = describe(n);
                return (
                  <div key={n.id} className={`flex gap-2.5 px-4 py-3 border-b border-line last:border-0 ${n.readAt ? "" : "bg-accsoft"}`}>
                    <span className="text-sm shrink-0">{icon}</span>
                    <div className="min-w-0">
                      <div className="text-[12.5px] text-ink leading-snug">{text}</div>
                      <div className="text-[10.5px] text-mut2 mt-0.5">{timeAgo(new Date(n.createdAt))}</div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
