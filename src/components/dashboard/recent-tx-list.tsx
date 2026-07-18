"use client";

// Phase 2.5 cross-navigation: the dashboard's recent-transaction rows were
// plain divs — now each opens the same txDetail modal the Transactions page
// uses, so the dashboard is never a dead end. Client component only because
// openModal needs the UI context; rows receive already-computed display
// props from the server page.

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
