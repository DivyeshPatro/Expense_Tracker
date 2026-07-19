"use client";

// Lending module Phase 2, Priority 7 — reuses Ledgerly's existing hand-rolled
// chart patterns (SVG polyline for trend lines, flex/CSS bar columns for bar
// charts) from src/app/(app)/analytics/page.tsx rather than a new charting
// library. Presentational only: data comes from the server (lending/page.tsx).

import { monthName } from "@/lib/dates";
import type { LendingReportsData } from "@/server/services/lending";
import { formatPaise } from "@/lib/money";
import { useUI } from "@/components/shell/ui-context";
import { EmptyState } from "@/components/shell/empty-state";
import { StatCard } from "@/components/shell/stat-card";

export function LendingReports({ data }: { data: LendingReportsData }) {
  const { openModal } = useUI();
  const hasAnyActivity = data.monthlyLending.some((v) => v > 0) || data.monthlyRecoveries.some((v) => v > 0);

  if (!hasAnyActivity && data.receivable === 0 && data.payable === 0) {
    return <EmptyState icon="📊" title="No lending activity yet" detail="Reports build up once you start recording loans and repayments." />;
  }

  const maxBar = Math.max(...data.monthlyLending, ...data.monthlyRecoveries, 1);
  const minTrend = Math.min(...data.outstandingTrend, 0);
  const maxTrend = Math.max(...data.outstandingTrend, 1);
  const trendPts = data.outstandingTrend
    .map((v, i) => {
      const x = (i * 300) / Math.max(1, data.outstandingTrend.length - 1);
      const y = 105 - (maxTrend === minTrend ? 50 : ((v - minTrend) / (maxTrend - minTrend)) * 95);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <div className="flex flex-wrap gap-3.5">
      <div className="flex flex-wrap gap-3.5 flex-[1_1_100%]">
        <StatCard label="RECEIVABLE" value={<span className="text-green">{formatPaise(data.receivable)}</span>} />
        <StatCard label="PAYABLE" value={<span className="text-red">{formatPaise(data.payable)}</span>} />
        <StatCard label="RECEIVED SO FAR" value={`${data.recoveryRatePercent}%`} />
      </div>

      <section className="card flex-[1.4_1_320px] p-[var(--pad)]">
        <h2 className="text-[13.5px] font-bold m-0">Outstanding trend</h2>
        <div className="text-[11.5px] text-mut2 mt-1">{monthName(data.monthKeys[0])} – {monthName(data.monthKeys[data.monthKeys.length - 1])}</div>
        <svg viewBox="0 0 300 110" preserveAspectRatio="none" className="w-full h-[120px] block mt-2.5">
          <polyline points={trendPts} fill="none" stroke="var(--acc)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        <div className="flex mt-1.5">
          {data.monthKeys.map((k) => (
            <div key={k} className="flex-1 text-center text-[10.5px] text-mut2">{monthName(k)}</div>
          ))}
        </div>
      </section>

      <section className="card flex-[1.4_1_320px] min-w-0 p-[var(--pad)]">
        <h2 className="text-[13.5px] font-bold m-0">Given vs received, by month</h2>
        <div className="overflow-x-auto mt-4" tabIndex={0} role="region" aria-label="Monthly lending vs receipts chart, scrollable">
          <div className="flex items-end gap-3 h-[130px] w-max">
            {data.monthKeys.map((k, i) => (
              <div key={k} className="w-[60px] flex-none flex flex-col items-center gap-1.5 h-full justify-end">
                <div className="flex items-end gap-1 h-full">
                  <div className="w-[16px] bg-acc rounded-t-[3px] opacity-85" style={{ height: `${Math.max(2, Math.round((data.monthlyLending[i] / maxBar) * 100))}%` }} />
                  <div className="w-[16px] bg-green rounded-t-[3px] opacity-85" style={{ height: `${Math.max(2, Math.round((data.monthlyRecoveries[i] / maxBar) * 100))}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-3 mt-2 w-max">
            {data.monthKeys.map((k) => (
              <div key={k} className="w-[60px] flex-none text-center text-[10.5px] text-mut2">{monthName(k)}</div>
            ))}
          </div>
        </div>
        <div className="flex gap-4 mt-2.5 text-[11px] text-mut2">
          <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm inline-block bg-acc" /> Given</div>
          <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm inline-block bg-green" /> Received</div>
        </div>
      </section>

      <section className="card flex-[1_1_260px] p-[var(--pad)] flex flex-col gap-[11px]">
        <h2 className="text-[13.5px] font-bold m-0">Card exposure</h2>
        {data.cardExposure.length === 0 && <div className="text-[12px] text-mut2">No money currently tied up on any card.</div>}
        {data.cardExposure.map((c) => (
          <div key={c.accountId} className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-[9px] grid place-items-center text-[13px] flex-none bg-accsoft">{c.icon}</div>
            <div className="flex-1 min-w-0 text-[12.5px] font-semibold truncate">{c.accountName}</div>
            <div className="text-[12.5px] font-bold flex-none">{formatPaise(c.outstanding)}</div>
          </div>
        ))}
      </section>

      <section className="card flex-[1_1_260px] p-[var(--pad)] flex flex-col gap-[11px]">
        <h2 className="text-[13.5px] font-bold m-0">Overdue loans</h2>
        {data.overdueLoans.length === 0 && <div className="text-[12px] text-mut2">Nothing overdue.</div>}
        {data.overdueLoans.slice(0, 8).map((l) => (
          <button
            key={l.loanEntryId}
            onClick={() => openModal("loanDetail", { loanEntryId: l.loanEntryId })}
            className="flex items-center gap-2.5 bg-transparent border-none cursor-pointer text-left p-0 hover:opacity-80"
          >
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-semibold truncate">{l.participantName}</div>
              <div className="text-[11px] text-red font-semibold">{l.daysOverdue} day{l.daysOverdue === 1 ? "" : "s"} overdue</div>
            </div>
            <div className="text-[12.5px] font-bold text-red flex-none">{formatPaise(l.remainingAmount)}</div>
          </button>
        ))}
      </section>

      <section className="card flex-[1_1_260px] p-[var(--pad)] flex flex-col gap-[11px]">
        <h2 className="text-[13.5px] font-bold m-0">Top borrowers</h2>
        {data.topBorrowers.length === 0 && <div className="text-[12px] text-mut2">Nobody currently owes you money.</div>}
        {data.topBorrowers.map((b, i) => (
          <button
            key={b.participantId}
            onClick={() => openModal("lendingContact", { participantId: b.participantId })}
            className="flex items-center gap-2.5 bg-transparent border-none cursor-pointer text-left p-0 hover:opacity-80"
          >
            <div className="w-6 h-6 rounded-full grid place-items-center text-[11px] font-bold flex-none bg-accsoft text-acc">{i + 1}</div>
            <div className="flex-1 min-w-0 text-[12.5px] font-semibold truncate">{b.participantName}</div>
            <div className="text-[12.5px] font-bold flex-none">{formatPaise(b.outstanding)}</div>
          </button>
        ))}
      </section>
    </div>
  );
}
