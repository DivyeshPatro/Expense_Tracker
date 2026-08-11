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
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { queryTransactionsAction, txTotalsAction } from "@/app/actions";
import { EmptyState } from "@/components/shell/empty-state";
import { useOffline } from "@/components/shell/offline-context";
import { ModuleTabs, SPENDING_TABS } from "@/components/shell/module-tabs";
import { useUI } from "@/components/shell/ui-context";
import { friendlyDay, MONTH_NAMES } from "@/lib/dates";
import { BasisToggle } from "@/components/dashboard/basis-toggle";
import { BASIS_FIGURE_LABEL, EXPENSE_BASIS, type ExpenseBasisPref } from "@/lib/expense-basis";
import { formatPaise } from "@/lib/money";
import type { LedgerRow, TxTotals } from "@/server/services/ledger";
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


/** #213: stable key for a filter combination, including the period — two
 *  different periods with the same text query are different result sets. */
function makeFilterKey(period: Period) {
  return (f: { type?: TxType; monthKey?: string | null; categoryId?: string | null; accountId?: string | null; textQuery?: string; batch?: string | null }) =>
    JSON.stringify([
      f.type ?? "",
      f.monthKey ?? "",
      f.categoryId ?? "",
      f.accountId ?? "",
      (f.textQuery ?? "").trim().toLowerCase(),
      f.batch ?? "",
      period.p ?? "",
      period.from ?? "",
      period.to ?? "",
    ]);
}

export function TransactionsList({
  initialRows,
  initialHasMore,
  initialTotals,
  initialQ,
  initialTab,
  initialMonth,
  initialCategory,
  initialAccount,
  initialBatch,
  basisPref,
  period,
  initialOpenTransactionId,
}: {
  initialRows: LedgerRow[];
  initialHasMore: boolean;
  initialTotals: TxTotals;
  initialQ: string;
  initialTab: TxType | null;
  initialMonth: string | null;
  initialCategory: CategoryRef | null;
  initialAccount: CategoryRef | null;
  initialBatch: string | null;
  basisPref: ExpenseBasisPref;
  period: Period;
  initialOpenTransactionId?: string | null;
}) {
  const { openModal } = useUI();
  const filterKey = makeFilterKey(period);

  // ?tx=<id> deep link — same idea as "Full history"'s existing
  // /activity?entity=<id> link, just one hop deeper into the detail sheet
  // itself. getTransactionDetail already no-ops to "no longer exists" for an
  // id the viewer isn't authorized to read (rfc §10), so this never leaks
  // existence of a transaction the visitor can't already read.
  useEffect(() => {
    if (initialOpenTransactionId) openModal("txDetail", { transactionId: initialOpenTransactionId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { pending, needsAttention } = useOffline();
  const [rows, setRows] = useState(initialRows);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [totals, setTotals] = useState(initialTotals);
  const [page, setPage] = useState(0);
  const [q, setQ] = useState(initialQ);
  const [tab, setTab] = useState<TxType | null>(initialTab);
  const [month, setMonth] = useState<string | null>(initialMonth);
  const [category, setCategory] = useState<CategoryRef | null>(initialCategory);
  const [account, setAccount] = useState<CategoryRef | null>(initialAccount);
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
  const appliedFilter = useRef({ q: initialQ, tab: initialTab, month: initialMonth, categoryId: initialCategory?.id ?? null, accountId: initialAccount?.id ?? null, batch: initialBatch });
  // #213: filter combination → the page-0 result we already fetched for it.
  // Session-scoped and per-mount, so it is naturally bounded by how many
  // distinct searches one person runs on one screen.
  const resultCache = useRef(new Map<string, { rows: LedgerRow[]; hasMore: boolean; totals: TxTotals }>());
  const periodKey = `${period.p ?? ""}|${period.from ?? ""}|${period.to ?? ""}`;

  async function refetch(filter: { type?: TxType; monthKey?: string | null; categoryId?: string | null; accountId?: string | null; textQuery?: string; batch?: string | null }) {
    setLoading(true);
    const query = {
      type: filter.type,
      monthKey: filter.monthKey ?? undefined,
      categoryId: filter.categoryId ?? undefined,
      accountId: filter.accountId ?? undefined,
      period,
      textQuery: filter.textQuery,
      importBatchId: filter.batch ?? undefined,
    };
    const [result, tot] = await Promise.all([queryTransactionsAction(query, 0), txTotalsAction(query)]);
    resultCache.current.set(filterKey(filter), { rows: result.rows, hasMore: result.hasMore, totals: tot });
    setRows(result.rows);
    setHasMore(result.hasMore);
    setTotals(tot);
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
    setAccount(initialAccount);
    setBatch(initialBatch);
    setRows(initialRows);
    setHasMore(initialHasMore);
    setTotals(initialTotals);
    setPage(0);
    // #213: fresh server data means anything cached may now be stale — a
    // deleted or edited transaction must never reappear from the cache.
    resultCache.current.clear();
    appliedFilter.current = { q: initialQ, tab: initialTab, month: initialMonth, categoryId: initialCategory?.id ?? null, accountId: initialAccount?.id ?? null, batch: initialBatch };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQ, initialTab, initialMonth, initialCategory?.id, initialAccount?.id, initialBatch, periodKey, initialRows]);

  useEffect(() => {
    const categoryId = category?.id ?? null;
    const accountId = account?.id ?? null;
    const applied = appliedFilter.current;
    if (
      applied.q === q &&
      applied.tab === tab &&
      applied.month === month &&
      applied.categoryId === categoryId &&
      applied.accountId === accountId &&
      applied.batch === batch
    ) {
      return; // matches what's already loaded — nothing to refetch
    }
    const filter = { type: tab ?? undefined, monthKey: month, categoryId, accountId, textQuery: q, batch };

    // #213: a filter combination we have already fetched in this session is
    // applied immediately — no debounce, no round trip. Measured before this,
    // retyping an identical query cost the full ~600 ms again (1220 ms
    // throttled), which is what made backspacing through a search feel heavy.
    // The cache is dropped whenever the server sends fresh rows (see the
    // resync effect), so it can never outlive a mutation.
    const cached = resultCache.current.get(filterKey(filter));
    if (cached) {
      if (debounce.current) clearTimeout(debounce.current);
      appliedFilter.current = { q, tab, month, categoryId, accountId, batch };
      setRows(cached.rows);
      setHasMore(cached.hasMore);
      setTotals(cached.totals);
      setPage(0);
      setLoading(false);
      return;
    }

    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      appliedFilter.current = { q, tab, month, categoryId, accountId, batch };
      refetch(filter);
    }, 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, tab, month, category?.id, account?.id, batch]);

  async function loadMore() {
    setLoading(true);
    const next = page + 1;
    const result = await queryTransactionsAction(
      { type: tab ?? undefined, monthKey: month ?? undefined, categoryId: category?.id, accountId: account?.id, period, textQuery: q, importBatchId: batch ?? undefined },
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

  // Which OUT figure is large. Presentation only — `totals` carries both, so
  // switching never re-queries and never changes net/carryForward/balance.
  const cash = { key: "paidByYou" as const, label: BASIS_FIGURE_LABEL.cash, value: totals.paidByYouExpense };
  const share = { key: "personalShare" as const, label: BASIS_FIGURE_LABEL.personal, value: totals.expense };
  const headline = basisPref === "personal" ? share : cash;
  const other = basisPref === "personal" ? cash : share;
  // Identical whenever nothing in view is split — showing it twice is just noise.
  const secondary = other.value !== headline.value ? other : null;

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      <ModuleTabs tabs={SPENDING_TABS} />
      {/* Overall summary for the current view — income, expense and net update
          with the tabs, month, account, category and search filters. */}
      <section
        className="rounded-[18px] p-4 border border-line2"
        style={{ background: "radial-gradient(130% 120% at 90% -25%, color-mix(in oklab,var(--acc) 16%, transparent), transparent 55%), linear-gradient(160deg, var(--side), var(--card))", boxShadow: "var(--sh)" }}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[10.5px] font-bold text-mut2 tracking-[.07em] uppercase">Net · this view</div>
            <div className="text-[27px] font-extrabold tracking-[-.03em] tabular-nums leading-tight" style={{ color: totals.net < 0 ? "var(--red)" : "var(--green)" }}>
              {totals.net < 0 ? "−" : "+"}{formatPaise(totals.net)}
            </div>
          </div>
          <div className="text-[11px] text-mut2 font-semibold tabular-nums">{totals.count} txn{totals.count === 1 ? "" : "s"}</div>
        </div>
        <div className="flex gap-2.5 mt-3">
          <div className="flex-1 rounded-xl px-3 py-2" style={{ background: "var(--card)" }}>
            <div className="text-[10px] uppercase tracking-wide font-bold text-mut2">In</div>
            <div className="text-[15px] font-extrabold tabular-nums text-green">{formatPaise(totals.income)}</div>
          </div>
          {/* Cash outflow and your share answer different questions, so both are
              shown. `basis` only decides which is the large one — see
              lib/expense-basis.ts. When nothing is split the two are equal and
              the secondary line is suppressed as noise. */}
          <div className="flex-1 rounded-xl px-3 py-2" style={{ background: "var(--card)" }}>
            <div className="flex items-start justify-between gap-2">
              <div className="text-[10px] uppercase tracking-wide font-bold text-mut2" title={EXPENSE_BASIS[headline.key].hint}>
                Out · {headline.label}
              </div>
              {/* The always-visible home for the switch on mobile: the dashboard's
                  cash-flow card is collapsed by default, so a toggle there costs a
                  tap to even find. This summary is on screen the moment you open
                  Spending. */}
              <div className="shrink-0 -mt-0.5">
                <BasisToggle value={basisPref} />
              </div>
            </div>
            <div className="text-[15px] font-extrabold tabular-nums text-red">−{formatPaise(headline.value)}</div>
            {secondary && (
              <div className="text-[10.5px] text-mut2 tabular-nums mt-0.5" title={EXPENSE_BASIS[secondary.key].hint}>
                {secondary.label.toLowerCase()} {formatPaise(secondary.value)}
              </div>
            )}
          </div>
        </div>
        {period.p !== "all" && (
          <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-line2 text-[11.5px]">
            <span className="text-mut">
              Carry forward{" "}
              <b className="tabular-nums" style={{ color: totals.carryForward < 0 ? "var(--red)" : "var(--ink)" }}>
                {totals.carryForward < 0 ? "−" : "+"}{formatPaise(totals.carryForward)}
              </b>
            </span>
            {/* "Balance" is the right word again now that carry forward and net
                are cash movement rather than gross: on an unfiltered view this
                equals the Accounts total exactly. It used to be built from
                gross expense, which counts money a friend paid and your account
                never saw — that is what made it disagree. */}
            <span className="text-mut" title="Carry forward plus this view's cash movement. On an unfiltered view this matches your Accounts total.">
              Balance{" "}
              <b className="tabular-nums" style={{ color: totals.balance < 0 ? "var(--red)" : "var(--green)" }}>
                {totals.balance < 0 ? "−" : "+"}{formatPaise(totals.balance)}
              </b>
            </span>
          </div>
        )}
      </section>

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
        {account && (
          <div className="flex items-center gap-[7px] px-[13px] py-[7px] rounded-full bg-accsoft text-acc text-xs font-bold">
            {account.icon} {account.name}
            <button onClick={() => setAccount(null)} className="cursor-pointer bg-transparent border-none text-acc font-bold p-0" aria-label="Clear account filter">✕</button>
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
        (q || tab || month || category || account || batch) ? (
          <EmptyState icon="🔎" title="Nothing matches" detail="Try a different search, category, or date range." />
        ) : (
          <EmptyState
            icon="🧾"
            title="Track where your money goes"
            detail="Record an expense, income, or transfer and it lands here — searchable, categorised, and reconciled across your accounts."
            action={<button onClick={() => openModal("exp")} className="btn-primary">Add your first expense</button>}
          />
        )
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

      {/* #186: the default window is a rolling 30 days, which is right for
          someone logging regularly — but a user returning to older history
          would otherwise land on a near-empty screen and have to discover the
          period picker to find their own money. One tap out, only when the
          window is actually thin and no other filter explains it. */}
      {!loading && !hasMore && rows.length > 0 && rows.length < 5 && !q && !month && !category && !account && !batch && !period.p && !period.from && (
        <ThinWindowNudge count={rows.length} />
      )}
    </div>
  );
}

function ThinWindowNudge({ count }: { count: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <button
      onClick={() => {
        const next = new URLSearchParams(params.toString());
        next.set("p", "all");
        router.push(`${pathname}?${next.toString()}`);
      }}
      className="self-stretch flex items-center gap-2.5 px-4 py-3 rounded-[12px] border border-line2 border-dashed bg-card cursor-pointer text-left min-h-[44px] hover:bg-accsoft"
    >
      <span className="flex-1 text-[12.5px] text-mut">
        Only {count} transaction{count === 1 ? "" : "s"} in the last 30 days.
      </span>
      <span className="text-[12.5px] font-bold text-acc whitespace-nowrap">Show all time →</span>
    </button>
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
