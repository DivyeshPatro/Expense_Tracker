"use client";

// Cash flow card with the Citi-style 6M / 8W / 14D period toggle.
// Series are precomputed server-side; toggling is instant.

import { useState } from "react";

export interface CashFlowSeries {
  mode: "M" | "W" | "D";
  chip: string;
  bars: { label: string; incPct: number; expPct: number }[];
}

export function CashFlowCard({ series }: { series: CashFlowSeries[] }) {
  const [mode, setMode] = useState<"M" | "W" | "D">("M");
  const cur = series.find((s) => s.mode === mode) ?? series[0];
  return (
    <section className="card p-[var(--pad)] flex-[1.6_1_340px]">
      <div className="flex justify-between items-center flex-wrap gap-1.5">
        <h2 className="text-[13.5px] font-bold m-0">Cash flow</h2>
        <div className="flex gap-3 text-[11px] text-mut items-center">
          <span className="flex items-center gap-[5px]"><span className="w-2 h-2 rounded-sm bg-green" />Income</span>
          <span className="flex items-center gap-[5px]"><span className="w-2 h-2 rounded-sm bg-red" />Expense</span>
          <span className="flex gap-1 ml-1.5">
            {series.map((s) => (
              <button
                key={s.mode}
                onClick={() => setMode(s.mode)}
                className="px-2.5 py-1 rounded-full text-[10.5px] font-bold cursor-pointer border-none"
                style={{
                  background: mode === s.mode ? "var(--ink)" : "var(--accSoft)",
                  color: mode === s.mode ? "var(--bg)" : "var(--mut)",
                }}
              >
                {s.chip}
              </button>
            ))}
          </span>
        </div>
      </div>
      <div className="flex items-end gap-3 h-[140px] mt-4">
        {cur.bars.map((b, i) => (
          <div key={i} className="flex-1 flex gap-1 items-end h-full">
            <div className="flex-1 bg-green rounded opacity-90" style={{ height: `${b.incPct}%` }} />
            <div className="flex-1 bg-red rounded opacity-85" style={{ height: `${b.expPct}%` }} />
          </div>
        ))}
      </div>
      <div className="flex gap-3 mt-2.5">
        {cur.bars.map((b, i) => (
          <div key={i} className="flex-1 text-center text-[10.5px] text-mut2">{b.label}</div>
        ))}
      </div>
    </section>
  );
}
