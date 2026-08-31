"use client";

// Phase 2.5 cross-navigation: the dashboard's recent-transaction rows were
// plain divs — now each opens the same txDetail modal the Transactions page
// uses, so the dashboard is never a dead end. Client component only because
// openModal needs the UI context; rows receive already-computed display
// props from the server page.

import { EmptyState } from "@/components/shell/empty-state";
import { useUI } from "@/components/shell/ui-context";

export interface RecentTxRow {
  id: string;
  icon: string;
  iconBg: string;
  name: string;
  meta: string;
  amtF: string;
  amtColor: string;
}

export function RecentTxList({ rows }: { rows: RecentTxRow[] }) {
  const { openModal } = useUI();
  // With no rows this card used to render its heading and an "All →" link over
  // nothing at all — 146 characters of markup and no content. A new user's
  // first impression of the dashboard included one card that just looked
  // broken. Every other empty surface in the app says something; this one now
  // does too, and offers the action instead of only naming the absence.
  if (rows.length === 0) {
    return (
      <EmptyState
        compact
        icon="🧾"
        title="No transactions yet"
        detail="Add one and it shows up here, on your budgets, and in Insights."
        action={
          <button onClick={() => openModal("compose")} className="btn-primary text-[12.5px] font-bold px-3.5 min-h-[40px]">
            Add your first expense
          </button>
        }
      />
    );
  }
  return (
    <>
      {rows.map((t) => (
        <button
          key={t.id}
          onClick={() => openModal("txDetail", { transactionId: t.id })}
          className="flex items-center gap-[11px] w-full text-left bg-transparent border-none cursor-pointer p-0 hover:bg-accsoft -mx-1 px-1 rounded-lg py-0.5"
        >
          <div className="w-[34px] h-[34px] rounded-[10px] grid place-items-center text-sm flex-none" style={{ background: t.iconBg }}>{t.icon}</div>
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] font-semibold truncate">{t.name}</div>
            <div className="text-[11px] text-mut2 truncate">{t.meta}</div>
          </div>
          <div className="text-[12.5px] font-bold" style={{ color: t.amtColor }}>{t.amtF}</div>
        </button>
      ))}
    </>
  );
}
