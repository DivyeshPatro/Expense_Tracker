"use client";

// Transaction list: All/Expenses/Income/Transfers tabs, live text filter,
// month/category chips (set by "Ask Ledgerly" / Analytics drill-down), the
// shared period picker (header), day grouping, delete with a confirm step
// (then a 5s undo). Filtering and pagination happen server-side
// (queryTransactionsAction) — this screen can be browsing years of imported
// history, so it never loads more than one page of rows into the browser at
// a time.

import { useEffect, useRef, useState } from "react";
import { deleteTransactionAction, queryTransactionsAction, undoDeleteAction } from "@/app/actions";
import { useUI } from "@/components/shell/ui-context";
import { friendlyDay, MONTH_NAMES } from "@/lib/dates";
import type { LedgerRow } from "@/server/services/ledger";
import { txDisplay } from "@/lib/tx-display";

type TxType = "EXPENSE" | "INCOME" | "TRANSFER";
type Period = { p?: string; from?: string; to?: string };
type CategoryRef = { id: string; name: string; icon: string };

const TABS: { label: string; value: TxType | null }[] = [
  { label: "All", value: null },
  { label: "Expenses", value: "EXPENSE" },
  { label: "Income", value: "INCOME" },
  { label: "Transfers", value: "TRANSFER" },
];

export function TransactionsList({
  initialRows,
  initialHasMore,
  initialQ,
  initialTab,
  initialMonth,
  initialCategory,
  period,
}: {
  initialRows: LedgerRow[];
  initialHasMore: boolean;
  initialQ: string;
  initialTab: TxType | null;
  initialMonth: string | null;
  initialCategory: CategoryRef | null;
  period: Period;
}) {
  const { showToast } = useUI();
  const [rows, setRows] = useState(initialRows);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [page, setPage] = useState(0);
  const [q, setQ] = useState(initialQ);
  const [tab, setTab] = useState<TxType | null>(initialTab);
  const [month, setMonth] = useState<string | null>(initialMonth);
  const [category, setCategory] = useState<CategoryRef | null>(initialCategory);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What filters produced the `rows` currently on screen — compared against
  // live q/tab/month/category to decide whether a debounced refetch is
  // actually needed. (A boolean "skip the next fetch" flag doesn't work here:
  // a server resync that doesn't happen to change q/tab/month/category, e.g.
  // switching the period picker with no active search, never gets "consumed"
  // by the fetch effect — leaving it armed to silently swallow the *next*
  // real change instead, such as a search typed right after switching period.)
  const appliedFilter = useRef({ q: initialQ, tab: initialTab, month: initialMonth, categoryId: initialCategory?.id ?? null });
  const periodKey = `${period.p ?? ""}|${period.from ?? ""}|${period.to ?? ""}`;

  async function refetch(filter: { type?: TxType; monthKey?: string | null; categoryId?: string | null; textQuery?: string }) {
    setLoading(true);
    const result = await queryTransactionsAction(
      { type: filter.type, monthKey: filter.monthKey ?? undefined, categoryId: filter.categoryId ?? undefined, period, textQuery: filter.textQuery },
      0
    );
    setRows(result.rows);
    setHasMore(result.hasMore);
    setPage(0);
    setLoading(false);
  }

  // palette navigation ("Ask Ledgerly"), an Analytics category drill-down, or
  // the header period picker all re-push this route with new params
  useEffect(() => {
    setQ(initialQ);
    setTab(initialTab);
    setMonth(initialMonth);
    setCategory(initialCategory);
    setRows(initialRows);
    setHasMore(initialHasMore);
    setPage(0);
    setConfirmId(null);
    appliedFilter.current = { q: initialQ, tab: initialTab, month: initialMonth, categoryId: initialCategory?.id ?? null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQ, initialTab, initialMonth, initialCategory?.id, periodKey]);

  useEffect(() => {
    const categoryId = category?.id ?? null;
    const applied = appliedFilter.current;
    if (applied.q === q && applied.tab === tab && applied.month === month && applied.categoryId === categoryId) {
      return; // matches what's already loaded — nothing to refetch
    }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      appliedFilter.current = { q, tab, month, categoryId };
      refetch({ type: tab ?? undefined, monthKey: month, categoryId, textQuery: q });
    }, 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, tab, month, category?.id]);

  async function loadMore() {
    setLoading(true);
    const next = page + 1;
    const result = await queryTransactionsAction(
      { type: tab ?? undefined, monthKey: month ?? undefined, categoryId: category?.id, period, textQuery: q },
      next
    );
    setRows((r) => [...r, ...result.rows]);
    setHasMore(result.hasMore);
    setPage(next);
    setLoading(false);
  }

  async function handleDelete(id: string) {
    setConfirmId(null);
    const res = await deleteTransactionAction(id);
    if (!res.ok) {
      showToast(res.error);
      return;
    }
    setRows((r) => r.filter((row) => row.id !== id));
    showToast("Transaction deleted", async () => {
      const undo = await undoDeleteAction(id);
      if (undo.ok) refetch({ type: tab ?? undefined, monthKey: month, categoryId: category?.id, textQuery: q });
      showToast(undo.ok ? "Restored" : "Could not restore");
    });
  }

  const groups: { label: string; items: (ReturnType<typeof txDisplay> & { id: string })[] }[] = [];
  for (const t of rows) {
    const label = friendlyDay(t.ymd);
    let g = groups[groups.length - 1];
    if (!g || g.label !== label) {
      g = { label, items: [] };
      groups.push(g);
    }
    g.items.push({ ...txDisplay(t), id: t.id });
  }

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      <div className="flex gap-2.5 flex-wrap items-center">
        <div className="flex gap-1 bg-card border border-line rounded-[9px] p-[3px]">
          {TABS.map((t) => (
            <button
              key={t.label}
              onClick={() => setTab(t.value)}
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
        {category && (
          <div className="flex items-center gap-[7px] px-[13px] py-[7px] rounded-full bg-accsoft text-acc text-xs font-bold">
            {category.icon} {category.name}
            <button onClick={() => setCategory(null)} className="cursor-pointer bg-transparent border-none text-acc font-bold p-0">✕</button>
          </div>
        )}
      </div>

      {!loading && rows.length === 0 && (
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
                {confirmId === t.id ? (
                  <div className="flex items-center gap-1.5 flex-none">
                    <span className="text-[11.5px] text-mut2 whitespace-nowrap">Delete?</span>
                    <button
                      onClick={() => handleDelete(t.id)}
                      className="px-2 py-1 rounded-lg bg-red text-white text-[11px] font-bold cursor-pointer border-none"
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setConfirmId(null)}
                      className="px-2 py-1 rounded-lg border border-line2 text-[11px] font-semibold cursor-pointer bg-card"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="text-[13px] font-bold" style={{ color: t.amtColor }}>{t.amtF}</div>
                    <button
                      title="Delete"
                      aria-label="Delete transaction"
                      onClick={() => setConfirmId(t.id)}
                      className="text-[13px] text-mut2 cursor-pointer p-1 bg-transparent border-none hover:text-red"
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {hasMore && (
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
