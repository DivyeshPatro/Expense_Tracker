"use client";

// Lending module Phase 2, Priority 6: a thin, deliberately simple consumer
// of the reminder data engine — grouped list, most urgent first, folded
// into the Overview tab rather than its own nav destination. Per spec this
// sprint is data-layer first; no notification delivery here.

import type { ReminderCandidate } from "@/lib/lending-reminders";
import { formatPaise } from "@/lib/money";
import { useUI } from "@/components/shell/ui-context";

const CATEGORY_META: Record<ReminderCandidate["category"], { label: string; color: string }> = {
  overdue: { label: "Overdue", color: "var(--red)" },
  due_today: { label: "Due today", color: "var(--red)" },
  due_tomorrow: { label: "Due tomorrow", color: "var(--acc)" },
  due_this_week: { label: "Due this week", color: "var(--acc)" },
  recover_before_card_due: { label: "Card recovery", color: "var(--mut2)" },
  card_due_tomorrow: { label: "Card due tomorrow", color: "var(--red)" },
  card_due_this_week: { label: "Card due this week", color: "var(--acc)" },
};

const VISIBLE_LIMIT = 5;

export function RemindersPanel({ reminders }: { reminders: ReminderCandidate[] }) {
  const { openModal } = useUI();
  if (reminders.length === 0) return null;

  const visible = reminders.slice(0, VISIBLE_LIMIT);
  const hidden = reminders.length - visible.length;

  return (
    <section className="card p-[var(--pad)] flex flex-col gap-1.5">
      <h2 className="text-[13.5px] font-bold m-0">Reminders</h2>
      {visible.map((r) => {
        const meta = CATEGORY_META[r.category];
        return (
          <button
            key={r.id}
            onClick={() => openModal("loanDetail", { loanEntryId: r.loanEntryId })}
            className="flex items-center justify-between gap-2 py-[7px] border-b border-line last:border-b-0 bg-transparent border-x-0 border-t-0 cursor-pointer text-left w-full hover:bg-accsoft -mx-1 px-1 rounded"
          >
            <div className="min-w-0">
              <div className="text-[12.5px] font-semibold truncate">{r.participantName}</div>
              <div className="text-[11px] font-semibold" style={{ color: meta.color }}>
                {meta.label}
              </div>
            </div>
            <div className="text-[12.5px] font-bold flex-none">{formatPaise(r.amount)}</div>
          </button>
        );
      })}
      {hidden > 0 && <div className="text-[11px] text-mut2 pt-0.5">+{hidden} more</div>}
    </section>
  );
}
