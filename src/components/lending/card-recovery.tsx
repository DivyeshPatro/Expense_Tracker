"use client";

// Lending module Phase 2, Priority 4: per-card recovery status, already
// sorted by urgency (computeCardRecovery). Presentational only — data comes
// from the server (lending/page.tsx), same "server fetches, client renders"
// split as LendingWorkspace. Drill-down always opens the contact modal
// (like Loan Detail, this is a report-level jump, not part of the
// desktop/mobile two-pane system).

import { formatCardGuidance } from "@/lib/card-billing";
import type { CardRecoverySummary } from "@/lib/lending-reports";
import { formatPaise } from "@/lib/money";
import { useUI } from "@/components/shell/ui-context";
import { EmptyState } from "@/components/shell/empty-state";

export function CardRecoveryDashboard({ cards }: { cards: CardRecoverySummary[] }) {
  const { openModal } = useUI();

  if (cards.length === 0) {
    return (
      <EmptyState
        icon="💳"
        title="No card-funded loans to recover"
        detail="Loans funded from a credit card with billing details set will show recovery guidance here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {cards.map((c) => {
        const urgent = c.pastDue > 0 || c.daysUntilDue <= 3;
        return (
          <div key={c.accountId} className="card p-[var(--pad)] flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-9 h-9 rounded-[10px] grid place-items-center text-[16px] flex-none bg-accsoft">{c.icon}</div>
                <div className="min-w-0">
                  <div className="text-[13.5px] font-bold truncate">{c.accountName}</div>
                  <div className="text-[11px] text-mut2 truncate">
                    {c.cardNetwork ?? ""}
                    {c.cardLast4 ? ` •••• ${c.cardLast4}` : ""}
                  </div>
                </div>
              </div>
              {c.pastDue > 0 ? (
                <span className="text-[11px] font-bold px-2 py-1 rounded-full flex-none" style={{ background: "var(--redSoft)", color: "var(--red)" }}>
                  {formatPaise(c.pastDue)} past due
                </span>
              ) : (
                <span
                  className="text-[11px] font-bold px-2 py-1 rounded-full flex-none"
                  style={{ background: urgent ? "var(--redSoft)" : "var(--accSoft)", color: urgent ? "var(--red)" : "var(--acc)" }}
                >
                  {c.daysUntilDue}d to due
                </span>
              )}
            </div>

            <div className="grid grid-cols-3 gap-x-4 gap-y-2.5 bg-accsoft rounded-[10px] px-3.5 py-3">
              <Stat label="Given" value={formatPaise(c.lentThisCycle)} />
              <Stat label="Received" value={formatPaise(c.recoveredThisCycle)} />
              <Stat label="Outstanding" value={formatPaise(c.outstandingThisCycle)} valueColor={c.outstandingThisCycle > 0 ? "var(--red)" : undefined} />
            </div>

            <div className="text-[12px] font-semibold" style={{ color: urgent ? "var(--red)" : "var(--ink)" }}>
              {formatCardGuidance(c.dueDate)}
            </div>

            {c.affectedLoans.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <div className="label-caps">Affected loans</div>
                {c.affectedLoans.map((l) => (
                  <button
                    key={l.loanEntryId}
                    onClick={() => openModal("lendingContact", { participantId: l.participantId })}
                    className="flex items-center justify-between py-[7px] border-b border-line last:border-b-0 bg-transparent border-x-0 border-t-0 cursor-pointer text-left w-full hover:bg-accsoft -mx-1 px-1 rounded"
                  >
                    <span className="text-[12px] font-semibold">{l.participantName}</span>
                    <span className="text-[12px] font-bold">{formatPaise(l.remainingAmount)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Stat({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div>
      <div className="text-[9.5px] font-semibold text-mut tracking-[.04em] uppercase">{label}</div>
      <div className="text-[12.5px] font-bold mt-0.5" style={valueColor ? { color: valueColor } : undefined}>
        {value}
      </div>
    </div>
  );
}
