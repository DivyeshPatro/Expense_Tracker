"use client";

// Lending module Phase 2, Priority 2: a single loan's (GAVE) or repayment's
// (GOT) full drill-down — opened as a modal on both mobile and desktop (a
// layered drill-down on top of whatever's already open, not part of the
// two-pane contact-ledger system). One component, two render modes based on
// `detail.kind`, rather than two components duplicating the fetch/skeleton
// scaffolding.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { loanDetailAction, undoDeleteLoanEntryAction } from "@/app/actions";
import { friendlyDay } from "@/lib/dates";
import { balanceAfterLabel } from "@/lib/lending";
import type { LoanStatus } from "@/lib/loan-settlement";
import { formatPaise } from "@/lib/money";
import type { LoanDetailView } from "@/server/services/lending";
import { EditEntryForm } from "./contact-ledger";
import { useOffline } from "@/components/shell/offline-context";
import { useUI } from "@/components/shell/ui-context";
import { EmptyState } from "@/components/shell/empty-state";

const STATUS_META: Record<LoanStatus, { label: string; color: string; bg: string; icon: string }> = {
  OPEN: { label: "Open", color: "var(--mut2)", bg: "var(--accSoft)", icon: "○" },
  PARTIAL: { label: "Partial", color: "var(--acc)", bg: "var(--accSoft)", icon: "◐" },
  SETTLED: { label: "Settled", color: "var(--green)", bg: "var(--greenSoft)", icon: "✓" },
  OVERDUE: { label: "Overdue", color: "var(--red)", bg: "var(--redSoft)", icon: "⚠" },
};

export function LoanDetailModal({ loanEntryId }: { loanEntryId: string }) {
  const { openModal, closeModal, showToast } = useUI();
  const { enqueueMutation, cancelPending } = useOffline();
  const router = useRouter();
  const [detail, setDetail] = useState<LoanDetailView | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // Phase 2.5 cross-navigation: funding source → Accounts page (close the
  // modal first so the destination isn't rendered underneath it)
  const goAccounts = () => {
    closeModal();
    router.push("/accounts");
  };

  const load = useCallback(async () => {
    try {
      setDetail(await loanDetailAction(loanEntryId));
    } catch {
      setDetail(null);
    }
  }, [loanEntryId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (detail === undefined) return <LoanDetailSkeleton />;
  if (detail === null) return <EmptyState icon="🤝" title="This entry could not be found" detail="It may have been deleted." />;

  if (editing) {
    return (
      <EditEntryForm
        entry={{
          id: detail.id,
          participantId: detail.participantId,
          participantName: detail.participantName,
          kind: detail.kind,
          amount: detail.amount,
          accountId: detail.accountId,
          accountName: detail.accountName,
          reason: detail.reason,
          notes: detail.notes,
          dueDate: detail.dueDate,
          ymd: detail.occurredAt.slice(0, 10),
          createdAt: detail.createdAt,
          version: detail.version,
        }}
        onDone={() => {
          setEditing(false);
          void load();
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  async function handleDelete() {
    if (!detail) return;
    setDeleteBusy(true);
    const res = await enqueueMutation(
      "loan.delete",
      detail.id,
      { amount: String(detail.amount / 100), kind: detail.kind, participantName: detail.participantName },
      detail.version
    );
    setDeleteBusy(false);
    if (!res.ok) {
      showToast(res.error);
      return;
    }
    closeModal();
    const intentId = res.intentId;
    showToast("Entry deleted", async () => {
      const restoredLocally = intentId ? await cancelPending(intentId) : null;
      if (restoredLocally) {
        showToast("Restored");
        router.refresh();
        return;
      }
      const undo = await undoDeleteLoanEntryAction(detail.id);
      showToast(undo.ok ? "Restored" : "Could not restore");
      router.refresh();
    });
  }

  function handleDuplicate() {
    if (!detail) return;
    closeModal();
    openModal("lendCompose", {
      participantId: detail.participantId,
      participantName: detail.participantName,
      loanKind: detail.kind,
      dupAmountRupees: String(detail.amount / 100),
      dupAccountId: detail.accountId,
      dupMerchant: detail.reason ?? undefined,
      dupNotes: detail.notes ?? undefined,
      dupDueDate: detail.kind === "GAVE" ? detail.dueDate : undefined,
    });
  }

  const actions = (
    <EntryActionsRow
      onEdit={() => setEditing(true)}
      onDuplicate={handleDuplicate}
      confirmingDelete={confirmingDelete}
      setConfirmingDelete={setConfirmingDelete}
      onDelete={handleDelete}
      deleteBusy={deleteBusy}
    />
  );

  if (detail.kind === "GOT") return <RepaymentDetail detail={detail} goAccounts={goAccounts} actions={actions} />;

  const status = detail.status ?? "OPEN";
  const meta = STATUS_META[status];

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .2s ease" }}>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[22px] font-extrabold">{formatPaise(detail.amount)}</div>
          <div className="text-[12px] text-mut2">You Gave · {detail.participantName}</div>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-bold" style={{ color: meta.color, background: meta.bg }}>
          <span aria-hidden="true">{meta.icon}</span>
          {meta.label}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 bg-accsoft rounded-[10px] px-3.5 py-3">
        <DetailStat label="Original Amount" value={formatPaise(detail.amount)} />
        <DetailStat label="Remaining Balance" value={formatPaise(detail.remainingAmount)} valueColor={detail.remainingAmount > 0 ? meta.color : undefined} />
        <DetailStat label="Settled So Far" value={formatPaise(detail.settledAmount)} />
        <DetailStat label="Funding Source" value={detail.accountName ?? "Untracked / cash"} onClick={detail.accountName ? goAccounts : undefined} />
        <DetailStat label="Created" value={friendlyDay(detail.occurredAt)} />
        <DetailStat label="Due Date" value={detail.dueDate ? friendlyDay(detail.dueDate) : "—"} />
      </div>

      <BalanceImpact before={detail.balanceBeforePaise} after={detail.balanceAfterPaise} participantName={detail.participantName} />

      {(detail.reason || detail.notes) && (
        <div className="flex flex-col gap-2">
          {detail.reason && <Field label="Reason" value={detail.reason} />}
          {detail.notes && <Field label="Notes" value={detail.notes} />}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <div className="label-caps">Payment History</div>
        {detail.relatedAllocations.length === 0 && (
          <div className="text-[12.5px] text-mut2 py-2">No money received against this yet.</div>
        )}
        {detail.relatedAllocations.map((a, i) => (
          <div key={`${a.loanEntryId}-${i}`} className="flex items-center gap-2.5 py-[9px] border-b border-line last:border-b-0">
            <span className="w-8 h-8 rounded-[9px] grid place-items-center text-[13px] flex-none" style={{ background: "var(--greenSoft)" }}>
              💰
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-semibold truncate">{a.reason || "Money received"}</div>
              <div className="text-[11px] text-mut2">{friendlyDay(a.ymd)}</div>
            </div>
            <div className="text-[13px] font-bold text-green">{formatPaise(a.amount)}</div>
          </div>
        ))}
      </div>

      {detail.remainingAmount > 0 && (
        <button
          onClick={() =>
            openModal("lendCompose", {
              participantId: detail.participantId,
              participantName: detail.participantName,
              loanKind: "GOT",
              targetLoanEntryId: detail.id,
              targetLoanRemainingRupees: String(detail.remainingAmount / 100),
            })
          }
          className="p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border-none text-white hover:brightness-108"
          style={{ background: "var(--green)" }}
        >
          Record Repayment
        </button>
      )}

      {actions}
    </div>
  );
}

function RepaymentDetail({
  detail,
  goAccounts,
  actions,
}: {
  detail: LoanDetailView;
  goAccounts: () => void;
  actions: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .2s ease" }}>
      <div>
        <div className="text-[22px] font-extrabold text-green">{formatPaise(detail.amount)}</div>
        <div className="text-[12px] text-mut2">You Got · {detail.participantName}</div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 bg-accsoft rounded-[10px] px-3.5 py-3">
        <DetailStat label="Funding Source" value={detail.accountName ?? "Untracked / cash"} onClick={detail.accountName ? goAccounts : undefined} />
        <DetailStat label="Received" value={friendlyDay(detail.occurredAt)} />
      </div>

      <BalanceImpact before={detail.balanceBeforePaise} after={detail.balanceAfterPaise} participantName={detail.participantName} />

      {(detail.reason || detail.notes) && (
        <div className="flex flex-col gap-2">
          {detail.reason && <Field label="Reason" value={detail.reason} />}
          {detail.notes && <Field label="Notes" value={detail.notes} />}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <div className="label-caps">Applied To</div>
        {detail.relatedAllocations.length === 0 && (
          <div className="text-[12.5px] text-mut2 py-2">This repayment wasn&apos;t applied to any specific loan.</div>
        )}
        {detail.relatedAllocations.map((a, i) => (
          <div key={`${a.loanEntryId}-${i}`} className="flex items-center gap-2.5 py-[9px] border-b border-line last:border-b-0">
            <span className="w-8 h-8 rounded-[9px] grid place-items-center text-[13px] flex-none" style={{ background: "var(--accSoft)" }}>
              💸
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-semibold truncate">{a.reason || "Loan"}</div>
              <div className="text-[11px] text-mut2">{friendlyDay(a.ymd)}</div>
            </div>
            <div className="text-[13px] font-bold">{formatPaise(a.amount)}</div>
          </div>
        ))}
      </div>

      {actions}
    </div>
  );
}

function EntryActionsRow({
  onEdit,
  onDuplicate,
  confirmingDelete,
  setConfirmingDelete,
  onDelete,
  deleteBusy,
}: {
  onEdit: () => void;
  onDuplicate: () => void;
  confirmingDelete: boolean;
  setConfirmingDelete: (v: boolean) => void;
  onDelete: () => void;
  deleteBusy: boolean;
}) {
  if (confirmingDelete) {
    return (
      <div className="flex items-center gap-2.5 bg-redsoft rounded-[10px] px-3.5 py-3">
        <span className="flex-1 text-[13px] font-semibold text-red">Delete this entry?</span>
        <button
          onClick={() => setConfirmingDelete(false)}
          className="px-3 py-1.5 rounded-lg border border-line2 text-[12px] font-semibold cursor-pointer bg-card"
        >
          Cancel
        </button>
        <button
          onClick={onDelete}
          disabled={deleteBusy}
          className="px-3 py-1.5 rounded-lg text-[12px] font-bold cursor-pointer border-none text-white disabled:opacity-60"
          style={{ background: "var(--red)" }}
        >
          {deleteBusy ? "…" : "Delete"}
        </button>
      </div>
    );
  }
  return (
    <div className="flex gap-2.5">
      <button
        onClick={onEdit}
        className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border border-line2 bg-card hover:bg-accsoft"
      >
        Edit
      </button>
      <button
        onClick={onDuplicate}
        className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border border-line2 bg-card hover:bg-accsoft"
      >
        Duplicate
      </button>
      <button
        onClick={() => setConfirmingDelete(true)}
        className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border-none text-white hover:brightness-108"
        style={{ background: "var(--red)" }}
      >
        Delete
      </button>
    </div>
  );
}

/** Objective: "instead of only showing the current balance, also show how
 * it changed" — a before → after visual, plus the plain-language result
 * (the same phrasing the contact ledger's per-row line uses), so a user
 * never has to do the arithmetic themselves. */
function BalanceImpact({ before, after, participantName }: { before: number; after: number; participantName: string }) {
  const result = balanceAfterLabel(after, participantName);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="label-caps">Balance with {participantName}</div>
      <div className="flex flex-col items-center gap-1 bg-accsoft rounded-[10px] px-3.5 py-3.5">
        <div className="text-[15px] font-bold text-mut2">{formatPaise(Math.abs(before))}</div>
        <div className="text-[15px] text-mut2 leading-none" aria-hidden="true">↓</div>
        <div className="text-[19px] font-extrabold" style={{ color: result.color }}>{formatPaise(Math.abs(after))}</div>
        <div className="text-[12px] font-semibold mt-0.5" style={{ color: result.color }}>{result.text}</div>
      </div>
    </div>
  );
}

function DetailStat({ label, value, valueColor, onClick }: { label: string; value: string; valueColor?: string; onClick?: () => void }) {
  const body = (
    <>
      <div className="text-[10px] font-semibold text-mut tracking-[.04em] uppercase">{label}</div>
      <div
        className={`text-[13px] font-bold mt-0.5 ${onClick ? "text-acc hover:underline" : "text-ink"}`}
        style={valueColor ? { color: valueColor } : undefined}
      >
        {value}
      </div>
    </>
  );
  if (onClick) {
    return (
      <button onClick={onClick} className="text-left bg-transparent border-none cursor-pointer p-0">
        {body}
      </button>
    );
  }
  return <div>{body}</div>;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold text-mut tracking-[.04em] uppercase">{label}</div>
      <div className="text-[13px] text-ink mt-0.5">{value}</div>
    </div>
  );
}

function LoanDetailSkeleton() {
  return (
    <div className="flex flex-col gap-3.5" aria-busy="true" aria-label="Loading loan details">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1.5">
          <div className="skeleton h-6 w-28 rounded" />
          <div className="skeleton h-3 w-32 rounded" />
        </div>
        <div className="skeleton h-6 w-20 rounded-full" />
      </div>
      <div className="skeleton h-[100px] rounded-[10px]" />
      <div className="flex flex-col gap-2 mt-1">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="skeleton h-[44px] rounded-lg" />
        ))}
      </div>
    </div>
  );
}
