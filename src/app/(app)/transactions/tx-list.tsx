"use client";

// Transaction list: All/Expenses/Income/Transfers tabs, live text filter,
// month/category chips (set by "Ask Ledgerly" / Analytics drill-down), the
// shared period picker (header), day grouping. Tapping a row opens its detail
// sheet (view, edit, or delete-with-confirm-then-5s-undo — see
// transaction-detail.tsx); rows themselves carry no destructive action.
// Filtering and pagination happen server-side (queryTransactionsAction) —
// this screen can be browsing years of imported history, so it never loads
// more than one page of rows into the browser at a time.

import { useEffect, useRef, useState } from "react";
import { queryTransactionsAction } from "@/app/actions";
import { useOffline } from "@/components/shell/offline-context";
import { useUI } from "@/components/shell/ui-context";
import { friendlyDay, MONTH_NAMES } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
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
  initialBatch,
  period,
}: {
  initialRows: LedgerRow[];
  initialHasMore: boolean;
  initialQ: string;
  initialTab: TxType | null;
  initialMonth: string | null;
  initialCategory: CategoryRef | null;
  initialBatch: string | null;
  period: Period;
}) {
  const { openModal } = useUI();
  const { pending, needsAttention } = useOffline();
  const [rows, setRows] = useState(initialRows);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [page, setPage] = useState(0);
  const [q, setQ] = useState(initialQ);
  const [tab, setTab] = useState<TxType | null>(initialTab);
  const [month, setMonth] = useState<string | null>(initialMonth);
  const [category, setCategory] = useState<CategoryRef | null>(initialCategory);
  const [batch, setBatch] = useState<string | null>(initialBatch);
  const [loading, setLoading] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What filters produced the `rows` currently on screen — compared against
  // live q/tab/month/category to decide whether a debounced refetch is
  // actually needed. (A boolean "skip the next fetch" flag doesn't work here:
  // a server resync that doesn't happen to change q/tab/month/category, e.g.
  // switching the period picker with no active search, never gets "consumed"
  // by the fetch effect — leaving it armed to silently swallow the *next*
  // real change instead, such as a search typed right after switching period.)
  const appliedFilter = useRef({ q: initialQ, tab: initialTab, month: initialMonth, categoryId: initialCategory?.id ?? null, batch: initialBatch });
  const periodKey = `${period.p ?? ""}|${period.from ?? ""}|${period.to ?? ""}`;

  async function refetch(filter: { type?: TxType; monthKey?: string | null; categoryId?: string | null; textQuery?: string; batch?: string | null }) {
    setLoading(true);
    const result = await queryTransactionsAction(
      {
        type: filter.type,
        monthKey: filter.monthKey ?? undefined,
        categoryId: filter.categoryId ?? undefined,
        period,
        textQuery: filter.textQuery,
        importBatchId: filter.batch ?? undefined,
      },
      0
    );
    setRows(result.rows);
    setHasMore(result.hasMore);
    setPage(0);
    setLoading(false);
  }

  // palette navigation ("Ask Ledgerly"), an Analytics category drill-down, the
  // header period picker, or a router.refresh() after editing/deleting a
  // transaction from its detail sheet all re-push/re-render this route with
  // a fresh initialRows — resync every time so the list never goes stale.
  useEffect(() => {
    setQ(initialQ);
    setTab(initialTab);
    setMonth(initialMonth);
    setCategory(initialCategory);
    setBatch(initialBatch);
    setRows(initialRows);
    setHasMore(initialHasMore);
    setPage(0);
    appliedFilter.current = { q: initialQ, tab: initialTab, month: initialMonth, categoryId: initialCategory?.id ?? null, batch: initialBatch };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQ, initialTab, initialMonth, initialCategory?.id, initialBatch, periodKey, initialRows]);

  useEffect(() => {
    const categoryId = category?.id ?? null;
    const applied = appliedFilter.current;
    if (applied.q === q && applied.tab === tab && applied.month === month && applied.categoryId === categoryId && applied.batch === batch) {
      return; // matches what's already loaded — nothing to refetch
    }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      appliedFilter.current = { q, tab, month, categoryId, batch };
      refetch({ type: tab ?? undefined, monthKey: month, categoryId, textQuery: q, batch });
    }, 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, tab, month, category?.id, batch]);

  async function loadMore() {
    setLoading(true);
    const next = page + 1;
    const result = await queryTransactionsAction(
      { type: tab ?? undefined, monthKey: month ?? undefined, categoryId: category?.id, period, textQuery: q, importBatchId: batch ?? undefined },
      next
    );
    setRows((r) => [...r, ...result.rows]);
    setHasMore(result.hasMore);
    setPage(next);
    setLoading(false);
  }

  // a synced row can still have a queued edit/delete against it (spec §7):
  // at most one outstanding intent per entity, so a plain id lookup suffices
  const queuedByEntity = new Map([...needsAttention, ...pending].filter((i) => !i.kind.endsWith(".create")).map((i) => [i.entityId, i]));

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
        {batch && (
          <div className="flex items-center gap-[7px] px-[13px] py-[7px] rounded-full bg-accsoft text-acc text-xs font-bold">
            📥 Import batch
            <button onClick={() => setBatch(null)} className="cursor-pointer bg-transparent border-none text-acc font-bold p-0" aria-label="Clear import filter">✕</button>
          </div>
        )}
      </div>

      <PendingRows />

      {!loading && rows.length === 0 && (
        <div className="text-center py-[60px] px-5 text-mut2 text-[13px]">Nothing matches — try a different search or filter.</div>
      )}

      {groups.map((g) => (
        <div key={g.label}>
          <div className="text-[11px] font-bold text-mut2 tracking-[.06em] mx-0.5 mt-1 mb-2 uppercase">{g.label}</div>
          <div className="card px-4 py-1.5">
            {g.items.map((t) => {
              const queued = queuedByEntity.get(t.id);
              const attention = queued?.status === "needs-attention";
              return (
                <button
                  key={t.id}
                  onClick={() => openModal("txDetail", { transactionId: t.id })}
                  aria-label={`${t.name}, ${t.meta}, ${t.amtF}${queued ? (attention ? ", needs attention" : queued.kind === "tx.delete" ? ", removing" : ", waiting to sync") : ""}`}
                  className="w-full flex items-center gap-3 py-[11px] border-b border-line last:border-b-0 bg-transparent border-x-0 border-t-0 cursor-pointer text-left min-h-[44px]"
                  style={attention ? { borderLeft: "2px solid var(--red)", paddingLeft: 10, marginLeft: -12 } : undefined}
                >
                  <div className="w-9 h-9 rounded-[11px] grid place-items-center text-[15px] flex-none" style={{ background: t.iconBg }}>{t.icon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold truncate">{t.name}</div>
                    <div className="text-[11.5px] text-mut2 truncate">{t.meta}</div>
                  </div>
                  {queued && (
                    <span className="text-[13px] flex-none" style={{ color: attention ? "var(--red)" : "var(--mut)" }} aria-hidden="true">
                      {attention ? "⚠" : "⏳"}
                    </span>
                  )}
                  <div className="text-[13px] font-bold flex-none" style={{ color: t.amtColor }}>{t.amtF}</div>
                </button>
              );
            })}
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

/** Local echo (offline-sync spec §6/§7): creates that haven't reached the
 * server yet, rendered from this device's outbox with the ⏳/⚠ badge. Tapping
 * a row opens the outbox-sourced detail sheet (edit coalesces, remove
 * cancels — spec §11). Rows disappear when the drain lands and
 * router.refresh() brings the real row in. Needs-attention pinned first,
 * matching actual sync order (spec §11 "what happens next"). */
function PendingRows() {
  const { pending, needsAttention } = useOffline();
  const { refData, openModal } = useUI();
  // create-kind only: a mutation-kind intent's entity already has a real row
  // below (badged there instead, via entityId cross-reference) — showing it
  // here too would duplicate the transaction on screen
  const rows = [...needsAttention, ...pending].filter((i) => i.kind.endsWith(".create"));
  if (rows.length === 0) return null;

  const accountName = (id: unknown) => refData.accounts.find((a) => a.id === id)?.name ?? "account";
  return (
    <div>
      <div className="text-[11px] font-bold text-mut2 tracking-[.06em] mx-0.5 mt-1 mb-2 uppercase">Waiting to sync</div>
      <div className="card px-4 py-1.5">
        {rows.map((i) => {
          const p = i.payload as { amount?: string; merchant?: string; fromAccountId?: string; toAccountId?: string };
          const paise = Math.round((Number(p.amount) || 0) * 100);
          const isTransfer = i.kind === "transfer.create";
          const attention = i.status === "needs-attention";
          const name = isTransfer
            ? `${accountName(p.fromAccountId)} → ${accountName(p.toAccountId)}`
            : p.merchant || (i.kind === "income.create" ? "Income" : "Expense");
          const amtF = `${i.kind === "income.create" ? "+" : i.kind === "expense.create" ? "−" : ""}${formatPaise(paise)}`;
          return (
            <button
              key={i.intentId}
              onClick={() => openModal("pendingDetail", { intentId: i.intentId })}
              aria-label={`${name}, ${attention ? "needs attention" : "waiting to sync"}, ${amtF}`}
              className="w-full flex items-center gap-3 py-[11px] border-b border-line last:border-b-0 bg-transparent border-x-0 border-t-0 cursor-pointer text-left min-h-[44px]"
              style={attention ? { borderLeft: "2px solid var(--red)", paddingLeft: 10, marginLeft: -12 } : undefined}
            >
              <div
                className="w-9 h-9 rounded-[11px] grid place-items-center text-[15px] flex-none"
                style={{ background: attention ? "var(--redSoft)" : "var(--accSoft)" }}
                aria-hidden="true"
              >
                {attention ? "⚠" : "⏳"}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold truncate">{name}</div>
                <div className="text-[11.5px] truncate" style={{ color: attention ? "var(--red)" : "var(--mut2)" }}>
                  {attention ? "Needs your attention" : typeof navigator !== "undefined" && !navigator.onLine ? "Waiting for internet" : "Waiting to sync"}
                </div>
              </div>
              <div className="text-[13px] font-bold flex-none text-mut">{amtF}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
