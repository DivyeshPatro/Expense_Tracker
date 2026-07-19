// Phase 2.5 Financial Health widget — informational only, no AI (per spec):
// a one-glance read of the user's overall position, composed entirely from
// data the dashboard already fetched. Server component; the sparkline is the
// same hand-rolled SVG polyline idiom the Analytics page established.

import Link from "next/link";
import { monthName } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { SectionHeader } from "@/components/shell/section-header";

export interface HealthData {
  /** trailing months, ascending — label + total expense paise */
  spendTrend: { monthKey: string; expense: number }[];
  outstandingLoans: number; // paise, lending youAreOwed
  upcomingBillCount: number;
  nearestBillLabel: string | null; // "Rent · due in 2d"
  creditExposure: number; // paise: CC debt (positive number) + card-funded loans outstanding
  netPosition: number; // paise: accounts total + lending net
}

export function HealthWidget({ data }: { data: HealthData }) {
  const max = Math.max(...data.spendTrend.map((m) => m.expense), 1);
  const min = Math.min(...data.spendTrend.map((m) => m.expense), 0);
  const pts = data.spendTrend
    .map((m, i) => {
      const x = (i * 300) / Math.max(1, data.spendTrend.length - 1);
      const y = 60 - (max === min ? 30 : ((m.expense - min) / (max - min)) * 52);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const latest = data.spendTrend[data.spendTrend.length - 1];
  const prev = data.spendTrend[data.spendTrend.length - 2];
  const trendDelta = prev && prev.expense > 0 ? Math.round(((latest.expense - prev.expense) / prev.expense) * 100) : null;

  return (
    <section className="card p-[var(--pad)] flex-[1.2_1_300px] flex flex-col gap-3">
      <SectionHeader title="Financial health" />

      <div>
        <div className="flex justify-between items-baseline">
          <div className="text-[11px] text-mut font-semibold tracking-[.06em]">MONTHLY SPENDING TREND</div>
          {trendDelta !== null && (
            <div className="text-[11px] font-bold" style={{ color: trendDelta > 0 ? "var(--red)" : "var(--green)" }}>
              {trendDelta > 0 ? "▲" : "▼"} {Math.abs(trendDelta)}% vs {monthName(prev.monthKey)}
            </div>
          )}
        </div>
        <svg viewBox="0 0 300 64" preserveAspectRatio="none" className="w-full h-[56px] block mt-1.5" aria-hidden="true">
          <polyline points={pts} fill="none" stroke="var(--acc)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        <div className="flex">
          {data.spendTrend.map((m) => (
            <div key={m.monthKey} className="flex-1 text-center text-[10px] text-mut2">{monthName(m.monthKey)}</div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 bg-accsoft rounded-[10px] px-3.5 py-3">
        <HealthStat label="Net Position" value={`${data.netPosition < 0 ? "−" : ""}${formatPaise(data.netPosition)}`} valueColor={data.netPosition < 0 ? "var(--red)" : "var(--green)"} href="/accounts" />
        <HealthStat label="Pending to Receive" value={formatPaise(data.outstandingLoans)} href="/lending" />
        <HealthStat
          label="Upcoming Bills"
          value={data.upcomingBillCount === 0 ? "None" : String(data.upcomingBillCount)}
          detail={data.nearestBillLabel ?? undefined}
          href="/bills"
        />
        <HealthStat label="Credit Exposure" value={formatPaise(data.creditExposure)} valueColor={data.creditExposure > 0 ? "var(--red)" : undefined} href="/accounts" />
      </div>
    </section>
  );
}

function HealthStat({ label, value, detail, valueColor, href }: { label: string; value: string; detail?: string; valueColor?: string; href: string }) {
  return (
    <Link href={href} className="no-underline text-ink block rounded hover:bg-card focus-visible:outline-2 focus-visible:outline-acc -m-1 p-1">
      <div className="text-[10px] font-semibold text-mut tracking-[.04em] uppercase">{label}</div>
      <div className="text-[13.5px] font-bold mt-0.5" style={valueColor ? { color: valueColor } : undefined}>{value}</div>
      {detail && <div className="text-[10.5px] text-mut2 truncate">{detail}</div>}
    </Link>
  );
}
