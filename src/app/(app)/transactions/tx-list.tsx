"use client";

// Transaction list: All/Expenses/Income/Transfers tabs, live text filter,
// month chip (set by "Ask Ledgerly"), day grouping, delete with 5s undo.

import { useEffect, useState } from "react";
import { DeleteTxButton } from "@/components/shell/buttons";
import { friendlyDay, MONTH_NAMES } from "@/lib/dates";
import { txDisplay, type TxRowInput } from "@/lib/tx-display";

export type TxListRow = TxRowInput;

const TABS = [
  { label: "All", value: null },
  { label: "Expenses", value: "EXPENSE" },
  { label: "Income", value: "INCOME" },
  { label: "Transfers", value: "TRANSFER" },
] as const;

export function TransactionsList({
  rows,
  initialQ,
  initialTab,
  initialMonth,
}: {
  rows: TxListRow[];
  initialQ: string;
  initialTab: TxListRow["type"] | null;
  initialMonth: string | null;
}) {
  const [q, setQ] = useState(initialQ);
  const [tab, setTab] = useState<TxListRow["type"] | null>(initialTab);
  const [month, setMonth] = useState<string | null>(initialMonth);

  // palette navigation re-pushes the route with new params
  useEffect(() => {
    setQ(initialQ);
    setTab(initialTab);
    setMonth(initialMonth);
  }, [initialQ, initialTab, initialMonth]);

  const ql = q.trim().toLowerCase();
  const filtered = rows.filter((t) => {
    if (tab && t.type !== tab) return false;
    if (month && !t.ymd.startsWith(month)) return false;
    if (!ql) return true;
    return [t.merchant, t.category ?? "", t.notes ?? "", String(Math.round(t.amount / 100)), t.accountName ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(ql);
  });

  const groups: { label: string; items: ReturnType<typeof txDisplay>[] }[] = [];
  for (const t of filtered.slice(0, 100)) {
    const label = friendlyDay(t.ymd);
    let g = groups[groups.length - 1];
    if (!g || g.label !== label) {
      g = { label, items: [] };
      groups.push(g);
    }
    g.items.push(txDisplay(t));
  }

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      <div className="flex gap-2.5 flex-wrap items-center">
        <div className="flex gap-1 bg-card border border-line rounded-[9px] p-[3px]">
          {TABS.map((t) => (
            <button
              key={t.label}
              onClick={() => setTab(t.value as TxListRow["type"] | null)}
              className="px-3 py-1.5 rounded-[7px] text-xs font-semibold cursor-pointer border-none"
              style={{
                background: tab === t.value ? "var(--acc)" : "transparent",
                color: tab === t.value ? "#fff" : "var(--mut)",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search merchant, category, notes, amount…"
          className="flex-1 min-w-[200px] box-border px-[13px] py-[9px] rounded-[9px] border border-line2 bg-card text-ink text-[13px] outline-none focus:border-acc"
        />
        {month && (
          <div className="flex items-center gap-[7px] px-[13px] py-[7px] rounded-full bg-accsoft text-acc text-xs font-bold">
            {MONTH_NAMES[Number(month.slice(5)) - 1]} {month.slice(0, 4)}
            <button onClick={() => setMonth(null)} className="cursor-pointer bg-transparent border-none text-acc font-bold p-0">✕</button>
          </div>
        )}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-[60px] px-5 text-mut2 text-[13px]">Nothing matches — try a different search or filter.</div>
      )}

      {groups.map((g) => (
        <div key={g.label}>
          <div className="text-[11px] font-bold text-mut2 tracking-[.06em] mx-0.5 mt-1 mb-2 uppercase">{g.label}</div>
          <div className="card px-4 py-1.5">
            {g.items.map((t) => (
              <div key={t.id} className="flex items-center gap-3 py-[11px] border-b border-line last:border-b-0">
                <div className="w-9 h-9 rounded-[11px] grid place-items-center text-[15px] flex-none" style={{ background: t.iconBg }}>{t.icon}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold truncate">{t.name}</div>
                  <div className="text-[11.5px] text-mut2 truncate">{t.meta}</div>
                </div>
                <div className="text-[13px] font-bold" style={{ color: t.amtColor }}>{t.amtF}</div>
                <DeleteTxButton id={t.id} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
