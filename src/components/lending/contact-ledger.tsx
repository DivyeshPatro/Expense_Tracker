"use client";

// Lending module Phase 1.5: the shared per-contact ledger content — summary
// card, quick actions, grouped entry timeline, contact editing. One
// component, two hosts: the mobile modal sheet (src/components/shell/
// lending-detail.tsx) and the desktop inline pane (lending-workspace.tsx).
// Content is identical between the two; only the host supplies chrome
// (modal close button vs. an inline "onClose" affordance for the pane).

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { contactActivityAction, lendingDashboardAction, listLoanEntriesAction, undoDeleteLoanEntryAction, updateParticipantDetailsAction } from "@/app/actions";
import { friendlyDay, MONTH_NAMES } from "@/lib/dates";
import type { TimelineEvent } from "@/lib/activity";
import { balanceAfterLabel, computeContactSummary, type ContactSummary } from "@/lib/lending";
import { formatPaise } from "@/lib/money";
import { AccountOptions } from "@/components/shell/account-options";
import { DateField } from "@/components/shell/date-field";
import { EmptyState } from "@/components/shell/empty-state";
import { AmountInput, ErrorNote, Field, SubmitButton } from "@/components/shell/form-primitives";
import { useOffline } from "@/components/shell/offline-context";
import { useUI } from "@/components/shell/ui-context";
import type { LendingParticipantView, LoanEntryRow } from "@/server/services/lending";

const TIMELINE_PAGE_SIZE = 30;

export function ContactLedgerView({ participantId, onClose }: { participantId: string; onClose?: () => void }) {
  const { openModal, showToast } = useUI();
  const [contact, setContact] = useState<LendingParticipantView | null | undefined>(undefined);
  const [entries, setEntries] = useState<LoanEntryRow[] | undefined>(undefined);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDetails, setEditingDetails] = useState(false);
  // v2.0 contact tabs: Overview / Transactions / Reports / Activity log.
  const [tab, setTab] = useState<"overview" | "transactions" | "reports" | "activity">("overview");
  const [search, setSearch] = useState("");
  const [activity, setActivity] = useState<Awaited<ReturnType<typeof contactActivityAction>> | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  // The full history is already in `entries` (needed for ContactSummaryCard's
  // all-time stats — see listLoanEntries' own comment on why that fetch isn't
  // capped), but a contact with a long history shouldn't render every row's
  // worth of DOM at once. This only limits what's rendered, not what's
  // fetched — "Show more" just reveals more of the array already in memory.
  const [visibleCount, setVisibleCount] = useState(TIMELINE_PAGE_SIZE);

  const load = useCallback(async () => {
    const [summary, rows] = await Promise.all([lendingDashboardAction(), listLoanEntriesAction(participantId)]);
    setContact(summary.contacts.find((c) => c.id === participantId) ?? null);
    setEntries(rows);
  }, [participantId]);

  useEffect(() => {
    setContact(undefined);
    setEntries(undefined);
    setEditingId(null);
    setEditingDetails(false);
    setVisibleCount(TIMELINE_PAGE_SIZE);
    setTab("overview");
    setActivity(null);
    void load();
  }, [load]);

  // Lazy-load the Activity tab the first time it's opened (reuses activityPage
  // via contactActivityAction — no second activity implementation).
  useEffect(() => {
    if (tab !== "activity" || activity !== null || activityLoading) return;
    setActivityLoading(true);
    contactActivityAction(participantId)
      .then((ev) => setActivity(ev))
      .finally(() => setActivityLoading(false));
  }, [tab, activity, activityLoading, participantId]);

  const net = contact?.net ?? 0;
  // computed unconditionally (before any early return) so these hooks run in
  // the same order every render — Rules of Hooks — and guard internally
  // against entries still being undefined (initial load / route transition)
  const summary = useMemo<ContactSummary | null>(() => (entries ? computeContactSummary(entries, net) : null), [entries, net]);
  // Running balance as of each entry (objective: "the user should never have
  // to calculate balances mentally"). `entries` is already the full,
  // unbounded per-contact history (see the load-time comment on
  // TIMELINE_PAGE_SIZE), sorted newest-first — walk it in chronological
  // (oldest-first) order accumulating Σ GAVE − Σ GOT, the same sign
  // convention `net` itself already uses, so "balance after the very last
  // (newest) entry" always equals `net` exactly.
  const balanceAfterById = useMemo(() => {
    const map = new Map<string, number>();
    let running = 0;
    for (const e of [...(entries ?? [])].reverse()) {
      running += e.kind === "GAVE" ? e.amount : -e.amount;
      map.set(e.id, running);
    }
    return map;
  }, [entries]);

  if (entries === undefined || summary === null) return <ContactLedgerSkeleton />;
  if (contact === null && entries.length === 0) {
    return (
      <EmptyState
        icon="🤝"
        title="Start tracking money with this person"
        detail="Record money you gave them or money you got from them — Ledgerly keeps the running balance so you never have to."
        action={
          <div className="flex gap-2">
            <button
              onClick={() => openModal("lendingEntry", { participantId, loanKind: "GAVE" })}
              className="px-3.5 py-2 rounded-[10px] text-[13px] font-bold text-white cursor-pointer border-none bg-acc hover:brightness-108"
            >
              You gave money
            </button>
            <button
              onClick={() => openModal("lendingEntry", { participantId, loanKind: "GOT" })}
              className="px-3.5 py-2 rounded-[10px] text-[13px] font-bold text-white cursor-pointer border-none bg-green hover:brightness-108"
            >
              You got money
            </button>
          </div>
        }
      />
    );
  }

  if (editingId) {
    const entry = entries.find((e) => e.id === editingId);
    if (entry) {
      return (
        <EditEntryForm
          entry={entry}
          onDone={() => {
            setEditingId(null);
            void load();
          }}
          onCancel={() => setEditingId(null)}
        />
      );
    }
  }

  const name = contact?.name ?? entries[0]?.participantName ?? "Contact";
  const balanceState =
    net > 100
      ? { label: "You'll get", icon: "↗", color: "var(--green)" }
      : net < -100
        ? { label: "You'll pay", icon: "↘", color: "var(--red)" }
        : { label: "All settled", icon: "✓", color: "var(--mut2)" };

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .2s ease" }}>
      <div className="flex items-center gap-3">
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Back to Lending"
            className="w-9 h-9 rounded-lg grid place-items-center text-mut cursor-pointer bg-transparent border-none hover:bg-accsoft flex-none"
          >
            ←
          </button>
        )}
        <div
          className="w-11 h-11 rounded-full grid place-items-center text-[15px] font-bold text-white flex-none overflow-hidden"
          style={{ background: contact?.color ?? "var(--acc)" }}
        >
          {contact?.photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={contact.photo} alt="" className="w-full h-full object-cover" />
          ) : (
            name.charAt(0).toUpperCase()
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-bold truncate">{name}</div>
          {contact?.phone && <div className="text-[12px] text-mut2">{contact.phone}</div>}
        </div>
        <div className="text-right flex-none">
          <div className="text-[17px] font-extrabold" style={{ color: balanceState.color }}>{formatPaise(Math.abs(net))}</div>
          <div className="text-[11px] font-semibold flex items-center gap-1 justify-end" style={{ color: balanceState.color }}>
            <span aria-hidden="true">{balanceState.icon}</span>
            {balanceState.label}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-card border border-line rounded-[9px] p-[3px]" role="tablist" aria-label="Contact sections">
        {(["overview", "transactions", "reports", "activity"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className="flex-1 px-2 py-1.5 rounded-[7px] text-[11.5px] font-semibold cursor-pointer border-none capitalize"
            style={{ background: tab === t ? "var(--acc)" : "transparent", color: tab === t ? "#fff" : "var(--mut)" }}
          >
            {t === "activity" ? "Activity" : t}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <>
          {entries.length > 0 && <ContactSummaryCard summary={summary} />}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => openModal("lendingEntry", { participantId, participantName: name, loanKind: "GAVE" })}
              className="p-2.5 rounded-[10px] text-[12.5px] font-bold text-center cursor-pointer border-none text-white hover:brightness-108"
              style={{ background: "var(--acc)" }}
            >
              + You gave
            </button>
            <button
              onClick={() => openModal("lendingEntry", { participantId, participantName: name, loanKind: "GOT" })}
              className="p-2.5 rounded-[10px] text-[12.5px] font-bold text-center cursor-pointer border-none text-white hover:brightness-108"
              style={{ background: "var(--green)" }}
            >
              + You got
            </button>
            {Math.abs(net) > 100 && (
              <button
                onClick={() =>
                  openModal("lendingEntry", {
                    participantId,
                    participantName: name,
                    loanKind: net > 0 ? "GOT" : "GAVE",
                    dupAmountRupees: String(Math.round(Math.abs(net) / 100)),
                  })
                }
                className="p-2.5 rounded-[10px] text-[12.5px] font-bold text-center cursor-pointer border border-line2 bg-card text-acc hover:bg-accsoft"
              >
                ✓ Mark as paid
              </button>
            )}
            {entries.length > 0 && (
              <Link
                href={`/lending/statement/${participantId}`}
                className="p-2.5 rounded-[10px] text-[12.5px] font-bold text-center border border-line2 bg-card text-ink no-underline hover:bg-accsoft flex items-center justify-center gap-1.5"
              >
                📄 Export statement
              </Link>
            )}
          </div>

          {contact && (
            <>
              <button
                onClick={() => setEditingDetails((v) => !v)}
                className="text-[11.5px] font-semibold text-acc bg-transparent border-none cursor-pointer self-start p-0 hover:underline"
              >
                {editingDetails ? "Hide contact details" : "Edit contact details"}
              </button>
              {editingDetails && (
                <ContactDetailsForm
                  contact={contact}
                  onSaved={() => {
                    setEditingDetails(false);
                    showToast("Contact updated");
                    void load();
                  }}
                />
              )}
            </>
          )}
        </>
      )}

      {tab === "transactions" && (
        <TransactionsTab
          entries={entries}
          balanceAfterById={balanceAfterById}
          search={search}
          setSearch={setSearch}
          visibleCount={visibleCount}
          setVisibleCount={setVisibleCount}
          contactName={name}
          onEdit={setEditingId}
          onDeleted={(id) => setEntries((es) => es?.filter((x) => x.id !== id))}
          onRestored={() => void load()}
          onQuickAdd={() => openModal("lendingEntry", { participantId, participantName: name, loanKind: "GAVE" })}
        />
      )}

      {tab === "reports" && <ReportsTab entries={entries} summary={summary} />}

      {tab === "activity" && <ActivityTab loading={activityLoading} events={activity} />}
    </div>
  );
}

// ─────────── Transactions tab ───────────

function TransactionsTab({
  entries,
  balanceAfterById,
  search,
  setSearch,
  visibleCount,
  setVisibleCount,
  contactName,
  onEdit,
  onDeleted,
  onRestored,
  onQuickAdd,
}: {
  entries: LoanEntryRow[];
  balanceAfterById: Map<string, number>;
  search: string;
  setSearch: (s: string) => void;
  visibleCount: number;
  setVisibleCount: (fn: (c: number) => number) => void;
  contactName: string;
  onEdit: (id: string) => void;
  onDeleted: (id: string) => void;
  onRestored: () => void;
  onQuickAdd: () => void;
}) {
  if (entries.length === 0) {
    return (
      <EmptyState
        icon="📭"
        title="No transactions yet"
        detail="Record money you gave or got from this person and it builds a running ledger — you never do the maths yourself."
        action={
          <button onClick={onQuickAdd} className="btn-primary">
            Record money you gave
          </button>
        }
      />
    );
  }
  const q = search.trim().toLowerCase();
  const filtered = q
    ? entries.filter((e) => (e.reason ?? "").toLowerCase().includes(q) || (e.notes ?? "").toLowerCase().includes(q) || String(e.amount / 100).includes(q))
    : entries;
  const visible = filtered.slice(0, visibleCount);
  const groups: { label: string; items: LoanEntryRow[] }[] = [];
  for (const e of visible) {
    const label = `${MONTH_NAMES[Number(e.ymd.slice(5, 7)) - 1]} ${e.ymd.slice(0, 4)}`;
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(e);
    else groups.push({ label, items: [e] });
  }
  return (
    <div className="flex flex-col gap-0.5">
      <input
        className="field mb-1"
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by reason, note, or amount"
        aria-label="Search transactions"
      />
      {filtered.length === 0 && <div className="text-[12.5px] text-mut2 py-4 text-center">No transactions match “{search}”.</div>}
      {groups.map((g) => (
        <div key={g.label}>
          <div className="text-[11px] font-bold text-mut2 tracking-[.06em] mt-3 mb-1 uppercase first:mt-0">{g.label}</div>
          {g.items.map((e) => (
            <EntryRow
              key={e.id}
              entry={e}
              contactName={contactName}
              balanceAfter={balanceAfterById.get(e.id) ?? 0}
              onEdit={() => onEdit(e.id)}
              onDeleted={() => onDeleted(e.id)}
              onRestored={onRestored}
            />
          ))}
        </div>
      ))}
      {visible.length < filtered.length && (
        <button
          onClick={() => setVisibleCount((c) => c + TIMELINE_PAGE_SIZE)}
          className="mt-2 p-2 rounded-lg text-[12px] font-semibold text-acc text-center cursor-pointer border border-line2 bg-transparent hover:bg-accsoft"
        >
          Show more ({filtered.length - visible.length} older)
        </button>
      )}
    </div>
  );
}

// ─────────── Reports tab ───────────

function ReportsTab({ entries, summary }: { entries: LoanEntryRow[]; summary: ContactSummary | null }) {
  if (entries.length === 0 || !summary) {
    return <EmptyState icon="📊" title="No report yet" detail="Once you record money given or received, the monthly totals and settlement summary show up here." compact />;
  }
  const m = new Map<string, { given: number; received: number }>();
  for (const e of entries) {
    const key = e.ymd.slice(0, 7);
    const cur = m.get(key) ?? { given: 0, received: 0 };
    if (e.kind === "GAVE") cur.given += e.amount;
    else cur.received += e.amount;
    m.set(key, cur);
  }
  const months = [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 bg-accsoft rounded-[10px] px-3.5 py-3">
        <ReportStat label="Total given" value={formatPaise(summary.totalLent)} />
        <ReportStat label="Total received" value={formatPaise(summary.totalRecovered)} />
        <ReportStat label="Net" value={formatPaise(summary.totalLent - summary.totalRecovered)} />
        <ReportStat label="Received so far" value={summary.totalLent > 0 ? `${summary.recoveryPercentage}%` : "—"} />
      </div>
      <div className="card p-[var(--pad)]">
        <div className="label-caps mb-1">Monthly breakdown</div>
        <div className="flex text-[10.5px] font-bold text-mut2 uppercase tracking-wide py-1">
          <span className="flex-1">Month</span>
          <span className="w-[84px] text-right">You gave</span>
          <span className="w-[84px] text-right">You got</span>
        </div>
        {months.map(([key, v]) => (
          <div key={key} className="flex items-center py-1.5 border-t border-line text-[12.5px]">
            <span className="flex-1 font-semibold">{MONTH_NAMES[Number(key.slice(5, 7)) - 1]} {key.slice(0, 4)}</span>
            <span className="w-[84px] text-right tabular-nums" style={{ color: "var(--acc)" }}>{v.given > 0 ? formatPaise(v.given) : "—"}</span>
            <span className="w-[84px] text-right tabular-nums text-green">{v.received > 0 ? formatPaise(v.received) : "—"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReportStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold text-mut tracking-[.04em] uppercase">{label}</div>
      <div className="text-[13px] font-bold text-ink mt-0.5">{value}</div>
    </div>
  );
}

// ─────────── Activity tab ───────────

function ActivityTab({ loading, events }: { loading: boolean; events: TimelineEvent[] | null }) {
  if (loading || events === null) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="skeleton h-[46px] rounded-lg" />
        ))}
      </div>
    );
  }
  if (events.length === 0) {
    return <EmptyState icon="📋" title="No activity yet" detail="Changes to this contact — entries added, edited, deleted or restored — will show up here." compact />;
  }
  return (
    <div className="flex flex-col">
      {events.map((ev) => (
        <div key={ev.activityId} className="flex items-start gap-3 py-2.5 border-t border-line first:border-t-0">
          <span className="w-8 h-8 rounded-[10px] grid place-items-center text-[14px] flex-none bg-accsoft" aria-hidden>{ev.icon}</span>
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] font-semibold truncate">{ev.summary}</div>
            {ev.detail && <div className="text-[11.5px] text-mut2 truncate">{ev.detail}</div>}
          </div>
          <time className="text-[10.5px] text-mut2 flex-none" dateTime={ev.ts}>{friendlyDay(ev.ts.slice(0, 10))}</time>
        </div>
      ))}
    </div>
  );
}

function ContactSummaryCard({ summary }: { summary: ContactSummary }) {
  // Friendlier, non-jargon labels for a non-technical audience — outstandingLoanCount
  // is a plain count (how many entries are still open), not an amount, so it
  // keeps a count-shaped label ("Pending Entries") rather than "Pending to
  // Receive", which would misleadingly read as a rupee figure next to the
  // other currency stats in this same grid.
  const stats: { label: string; value: string }[] = [
    { label: "Pending Entries", value: String(summary.outstandingLoanCount) },
    { label: "Total Given", value: formatPaise(summary.totalLent) },
    { label: "Average Given", value: summary.averageLoan > 0 ? formatPaise(summary.averageLoan) : "—" },
    { label: "Largest Given", value: summary.largestLoan > 0 ? formatPaise(summary.largestLoan) : "—" },
    { label: "Total Received", value: formatPaise(summary.totalRecovered) },
    { label: "Received So Far", value: summary.totalLent > 0 ? `${summary.recoveryPercentage}%` : "—" },
    { label: "Last Transaction", value: summary.lastTransactionYmd ? friendlyDay(summary.lastTransactionYmd) : "—" },
    { label: "First Transaction", value: summary.firstTransactionYmd ? friendlyDay(summary.firstTransactionYmd) : "—" },
  ];
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 bg-accsoft rounded-[10px] px-3.5 py-3">
      {stats.map((s) => (
        <div key={s.label}>
          <div className="text-[10px] font-semibold text-mut tracking-[.04em] uppercase">{s.label}</div>
          <div className="text-[13px] font-bold text-ink mt-0.5">{s.value}</div>
        </div>
      ))}
    </div>
  );
}


function ContactLedgerSkeleton() {
  return (
    <div className="flex flex-col gap-3.5" aria-busy="true" aria-label="Loading contact">
      <div className="flex items-center gap-3">
        <div className="skeleton w-11 h-11 rounded-full flex-none" />
        <div className="flex-1 flex flex-col gap-1.5">
          <div className="skeleton h-4 w-24 rounded" />
          <div className="skeleton h-3 w-16 rounded" />
        </div>
        <div className="skeleton h-5 w-16 rounded" />
      </div>
      <div className="skeleton h-[92px] rounded-[10px]" />
      <div className="flex gap-2">
        <div className="skeleton h-10 flex-1 rounded-[10px]" />
        <div className="skeleton h-10 flex-1 rounded-[10px]" />
      </div>
      <div className="flex flex-col gap-2 mt-1">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="skeleton h-[52px] rounded-lg" />
        ))}
      </div>
    </div>
  );
}

function EntryRow({
  entry,
  contactName,
  balanceAfter,
  onEdit,
  onDeleted,
  onRestored,
}: {
  entry: LoanEntryRow;
  contactName: string;
  balanceAfter: number;
  onEdit: () => void;
  onDeleted: () => void;
  onRestored: () => void;
}) {
  const { enqueueMutation, cancelPending } = useOffline();
  const { showToast, openModal } = useUI();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const gave = entry.kind === "GAVE";
  const directionColor = gave ? "var(--acc)" : "var(--green)";

  async function handleDelete() {
    setBusy(true);
    const res = await enqueueMutation(
      "loan.delete",
      entry.id,
      { amount: String(entry.amount / 100), kind: entry.kind, participantName: entry.participantName },
      entry.version
    );
    setBusy(false);
    if (!res.ok) {
      showToast(res.error);
      return;
    }
    onDeleted();
    const intentId = res.intentId;
    showToast("Entry deleted", async () => {
      const restoredLocally = intentId ? await cancelPending(intentId) : null;
      if (restoredLocally) {
        showToast("Restored");
        onRestored();
        return;
      }
      const undo = await undoDeleteLoanEntryAction(entry.id);
      showToast(undo.ok ? "Restored" : "Could not restore");
      onRestored();
    });
  }

  return (
    <div className="flex items-center gap-2.5 py-[9px] border-b border-line last:border-b-0">
      <button
        onClick={() => openModal("loanDetail", { loanEntryId: entry.id })}
        aria-label={`View details for ${gave ? "You Gave" : "You Got"} entry of ${formatPaise(entry.amount)}${entry.reason ? ` for ${entry.reason}` : ""}`}
        className="flex items-center gap-2.5 flex-1 min-w-0 text-left bg-transparent border-none cursor-pointer p-0 rounded-lg hover:bg-accsoft"
      >
        <span className="w-9 h-9 rounded-[10px] grid place-items-center text-[14px] flex-none" style={{ background: gave ? "var(--accSoft)" : "var(--greenSoft)" }}>
          {gave ? "💸" : "💰"}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[11.5px] font-bold" style={{ color: directionColor }}>{gave ? "You Gave" : "You Got"}</div>
          <div className="text-[13px] font-semibold text-ink truncate">{entry.reason || "—"}</div>
          <div className="text-[11px] text-mut2 truncate">
            {entry.accountName ? (
              // Phase 2.5 cross-navigation: the funding source opens the
              // Accounts page instead of being dead text — stopPropagation so
              // the surrounding loan-detail button doesn't also fire
              <span
                role="link"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  router.push("/accounts");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.stopPropagation();
                    router.push("/accounts");
                  }
                }}
                className="hover:text-acc hover:underline cursor-pointer"
              >
                via {entry.accountName}
              </span>
            ) : (
              "Untracked / cash"
            )}
          </div>
          <div className="text-[11px] font-semibold truncate" style={{ color: balanceAfterLabel(balanceAfter, contactName).color }}>
            After this: {balanceAfterLabel(balanceAfter, contactName).text}
          </div>
        </div>
      </button>
      <div className="flex flex-col items-end gap-1.5 flex-none">
        <div className="text-[13.5px] font-bold" style={{ color: directionColor }}>{formatPaise(entry.amount)}</div>
        <div className="flex gap-0.5 -mr-1.5">
          <button
            onClick={onEdit}
            aria-label={`Edit ${gave ? "You Gave" : "You Got"} entry of ${formatPaise(entry.amount)}${entry.reason ? ` for ${entry.reason}` : ""}`}
            className="w-11 h-11 rounded-md grid place-items-center text-mut2 bg-transparent border-none cursor-pointer hover:bg-accsoft flex-none"
          >
            ✏️
          </button>
          <button
            onClick={handleDelete}
            disabled={busy}
            aria-label={`Delete ${gave ? "You Gave" : "You Got"} entry of ${formatPaise(entry.amount)}${entry.reason ? ` for ${entry.reason}` : ""}`}
            className="w-11 h-11 rounded-md grid place-items-center text-mut2 bg-transparent border-none cursor-pointer hover:text-red hover:bg-redsoft flex-none disabled:opacity-50"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

export function EditEntryForm({ entry, onDone, onCancel }: { entry: LoanEntryRow; onDone: () => void; onCancel: () => void }) {
  const { refData } = useUI();
  const { enqueueMutation } = useOffline();
  const [kind, setKind] = useState<"GAVE" | "GOT">(entry.kind);
  const [amount, setAmount] = useState(String(entry.amount / 100));
  const [accountId, setAccountId] = useState(entry.accountId ?? "");
  const [date, setDate] = useState(entry.ymd);
  const [dueDate, setDueDate] = useState(entry.dueDate ?? "");
  const [reason, setReason] = useState(entry.reason ?? "");
  const [notes, setNotes] = useState(entry.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // not useSubmit() — that unconditionally closes the WHOLE modal on
  // success, but this form lives nested inside ContactLedgerView and should
  // only exit its own inline edit state, leaving the ledger view open.
  async function save() {
    setBusy(true);
    setError(null);
    const res = await enqueueMutation(
      "loan.update",
      entry.id,
      {
        participantId: entry.participantId,
        kind,
        amount,
        accountId: accountId || null,
        reason: reason || undefined,
        notes: notes || undefined,
        date,
        dueDate: kind === "GAVE" && dueDate ? dueDate : null,
        participantName: entry.participantName,
      },
      entry.version
    );
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onDone();
  }

  return (
    <div className="flex flex-col gap-3" style={{ animation: "rise .18s ease" }}>
      <div className="flex gap-1.5">
        {(["GAVE", "GOT"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            aria-pressed={kind === k}
            className="flex-1 px-[13px] py-2 rounded-lg text-[13px] font-bold cursor-pointer border-none"
            style={{ background: kind === k ? "var(--acc)" : "var(--accSoft)", color: kind === k ? "#fff" : "var(--acc)" }}
          >
            {k === "GAVE" ? "You Gave" : "You Got"}
          </button>
        ))}
      </div>
      <Field label="AMOUNT (₹)">
        <AmountInput value={amount} onChange={setAmount} autoFocus />
      </Field>
      <div className="flex gap-2.5 flex-wrap">
        <Field label="FUNDING SOURCE">
          <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Untracked / cash in hand</option>
            <AccountOptions accounts={refData.accounts} />
          </select>
        </Field>
        <Field label="DATE">
          <DateField value={date} onChange={setDate} />
        </Field>
      </div>
      {kind === "GAVE" && (
        <Field label="DUE DATE (OPTIONAL)">
          <div className="flex items-center gap-2">
            <DateField value={dueDate} onChange={setDueDate} min={date} />
            {dueDate && (
              <button type="button" onClick={() => setDueDate("")} className="text-[11.5px] font-semibold text-mut2 bg-transparent border-none cursor-pointer hover:text-ink flex-none">
                Clear
              </button>
            )}
          </div>
        </Field>
      )}
      <Field label="REASON">
        <input className="field" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Dinner, rent help" />
      </Field>
      <Field label="NOTES">
        <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
      </Field>
      <ErrorNote error={error} />
      <div className="flex gap-2.5">
        <button onClick={onCancel} className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border border-line2 bg-card hover:bg-accsoft">
          Cancel
        </button>
        <div className="flex-[2]">
          <SubmitButton busy={busy} onClick={save}>
            Save changes
          </SubmitButton>
        </div>
      </div>
    </div>
  );
}

function ContactDetailsForm({ contact, onSaved }: { contact: LendingParticipantView; onSaved: () => void }) {
  const [displayName, setDisplayName] = useState(contact.name);
  const [photo, setPhoto] = useState(contact.photo ?? "");
  const [phone, setPhone] = useState(contact.phone ?? "");
  const [notes, setNotes] = useState(contact.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!displayName.trim()) {
      setError("Name is required");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await updateParticipantDetailsAction({
      participantId: contact.id,
      displayName: displayName.trim(),
      photo: photo || null,
      phone: phone || null,
      notes: notes || null,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onSaved();
  }

  return (
    <div className="flex flex-col gap-2.5 card p-3" style={{ animation: "rise .18s ease" }}>
      <Field label="NAME">
        <input className="field" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Contact name" />
      </Field>
      <Field label="PHOTO URL">
        <input className="field" value={photo} onChange={(e) => setPhoto(e.target.value)} placeholder="https://…" />
      </Field>
      <Field label="PHONE">
        <input className="field" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Optional" />
      </Field>
      <Field label="NOTES">
        <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
      </Field>
      <ErrorNote error={error} />
      <SubmitButton busy={busy} onClick={save}>
        Save contact details
      </SubmitButton>
    </div>
  );
}
