"use client";

// Full category breakdown for the selected period (not just top 5), with an
// Expense/Income toggle and a click-through to the matching transactions —
// clicking "Groceries" takes you to Transactions pre-filtered to that
// category and the same period, instead of just showing a static number.

import Link from "next/link";
import { useState } from "react";
import { formatPaise } from "@/lib/money";
import { EmptyState } from "@/components/shell/empty-state";

export interface CategoryRow {
  id: string | null;
  name: string;
  icon: string;
  color: string;
  total: number;
}

export function CategoryBreakdown({
  expense,
  income,
  periodQuery,
  periodLabel,
}: {
  expense: CategoryRow[];
  income: CategoryRow[];
  periodQuery: string; // e.g. "p=2026-06" or "from=...&to=..." or "" for this month
  periodLabel: string;
}) {
  const [tab, setTab] = useState<"EXPENSE" | "INCOME">("EXPENSE");
  const rows = tab === "EXPENSE" ? expense : income;
  const max = rows[0]?.total ?? 1;
  const total = rows.reduce((s, c) => s + c.total, 0);

  const txHref = (categoryId: string, txTab: "EXPENSE" | "INCOME") => {
    const params = new URLSearchParams(periodQuery);
    params.set("category", categoryId);
    params.set("tab", txTab);
    return `/transactions?${params.toString()}`;
  };

  return (
    <section className="card p-[var(--pad)] flex-[1_1_280px] flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[13.5px] font-bold m-0">Categories · {periodLabel}</h2>
        <div className="flex gap-1 p-[3px] rounded-[8px] bg-accsoft">
          {(["EXPENSE", "INCOME"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              aria-pressed={tab === k}
              className="px-2.5 py-1 rounded-[6px] text-[11px] font-bold cursor-pointer border-none"
              style={{ background: tab === k ? "var(--acc)" : "transparent", color: tab === k ? "#fff" : "var(--acc)" }}
            >
              {k === "EXPENSE" ? "Expense" : "Income"}
            </button>
          ))}
        </div>
      </div>
      {rows.length > 0 && <CategoryDonut rows={rows} total={total} />}
      <div className="flex flex-col gap-3 max-h-[340px] overflow-auto pr-1">
        {rows.map((c) => {
          const content = (
            <>
              <div className="flex justify-between text-xs font-semibold">
                <span>{c.icon} {c.name}</span>
                <span>{formatPaise(c.total)}</span>
              </div>
              <div className="h-[5px] rounded bg-accsoft mt-[5px]">
                <div className="h-full rounded" style={{ width: `${Math.round((c.total / max) * 100)}%`, background: c.color }} />
              </div>
            </>
          );
          return c.id ? (
            <Link key={c.name} href={txHref(c.id, tab)} prefetch={false} className="no-underline text-ink hover:opacity-80">
              {content}
            </Link>
          ) : (
            <div key={c.name}>{content}</div>
          );
        })}
        {rows.length === 0 && (
          <EmptyState
            icon="📊"
            title={`No ${tab === "EXPENSE" ? "expenses" : "income"} in this period`}
            detail="Try a different date range or category."
            compact
          />
        )}
      </div>
    </section>
  );
}

// Composition donut: the top 6 categories keep their own colour (so a slice
// matches its bar below — the bar list is the legend/table, identity is never
// colour-alone), everything past that folds into "Other". A 2px surface gap
// separates slices; the centre carries the period total.
function CategoryDonut({ rows, total }: { rows: CategoryRow[]; total: number }) {
  const TOP = 6;
  const top = rows.slice(0, TOP);
  const otherTotal = rows.slice(TOP).reduce((s, c) => s + c.total, 0);
  const segments = otherTotal > 0 ? [...top, { id: null, name: "Other", icon: "", color: "var(--mut2)", total: otherTotal }] : top;
  const sum = segments.reduce((s, c) => s + c.total, 0) || 1;

  const R = 52;
  const C = 2 * Math.PI * R;
  const GAP = 2; // px of surface between slices
  let acc = 0;

  return (
    <div className="flex justify-center py-1" role="img" aria-label={`Category composition, total ${formatPaise(total)}`}>
      <svg width="150" height="150" viewBox="0 0 140 140">
        <circle cx="70" cy="70" r={R} fill="none" stroke="var(--side)" strokeWidth="16" />
        {segments.map((c) => {
          const frac = c.total / sum;
          const len = Math.max(0, frac * C - GAP);
          const seg = (
            <circle
              key={c.name}
              cx="70"
              cy="70"
              r={R}
              fill="none"
              stroke={c.color}
              strokeWidth="16"
              strokeDasharray={`${len} ${C - len}`}
              transform={`rotate(${acc * 360 - 90} 70 70)`}
            >
              <title>{`${c.icon ? c.icon + " " : ""}${c.name} · ${formatPaise(c.total)} (${Math.round(frac * 100)}%)`}</title>
            </circle>
          );
          acc += frac;
          return seg;
        })}
        <text x="70" y="66" textAnchor="middle" className="fill-mut2" style={{ fontSize: "9px", fontWeight: 700, letterSpacing: ".04em" }}>TOTAL</text>
        <text x="70" y="82" textAnchor="middle" className="fill-ink" style={{ fontSize: "14px", fontWeight: 800 }}>{formatPaise(total)}</text>
      </svg>
    </div>
  );
}
