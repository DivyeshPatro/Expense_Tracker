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
