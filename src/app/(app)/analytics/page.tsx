import { currentMonthKey, daysBetweenYMD, monthName, shiftMonthKey, todayYMD } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { parsePeriod, periodQueryParams } from "@/lib/period";
import { listAccounts } from "@/server/services/accounts";
import { categoryTotals, loadLedgerAgg, loadLedgerAggRange, merchantTotals, monthAgg } from "@/server/services/ledger";
import { requireUser } from "@/server/session";
import { CategoryBreakdown } from "./category-breakdown";
import { PrintButton } from "./print-button";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const now = new Date();
  const key = currentMonthKey(now);
  const today = todayYMD(now);
  const sp = await searchParams;
  const period = parsePeriod(sp, now);
  const periodQS = periodQueryParams(period);

  const [rows, periodRows, accounts] = await Promise.all([
    loadLedgerAgg(user.id, 6, now),
    loadLedgerAggRange(user.id, period.range.start, period.range.end),
    listAccounts(user.id, undefined, now),
  ]);

  // the 6-month trend charts below are intentionally independent of the
  // selected period — they're a fixed recent-history view; the stat cards,
  // category and merchant breakdowns respect whatever period is selected
  const monthKeys = Array.from({ length: 6 }, (_, i) => shiftMonthKey(key, i - 5));
  const aggs = monthKeys.map((k) => monthAgg(rows, k));

  const periodAgg = monthAgg(periodRows, "");
  const periodDays =
    period.mode === "all"
      ? periodRows.length
        ? daysBetweenYMD(periodRows[periodRows.length - 1].ymd, today) + 1
        : 1
      : period.mode === "custom"
        ? daysBetweenYMD(period.from, period.to) + 1
        : period.periodKey === key
          ? Number(today.slice(8))
          : daysBetweenYMD(`${period.periodKey}-01`, `${shiftMonthKey(period.periodKey, 1)}-01`);
  const avgDaily = Math.round(periodAgg.expense / Math.max(1, periodDays));
  const savings = periodAgg.income - periodAgg.expense;
  const rate = periodAgg.income ? Math.max(0, Math.round((savings / periodAgg.income) * 100)) : 0;

  const biggest = [...periodRows].filter((r) => r.type === "EXPENSE").sort((a, b) => b.myExpense - a.myExpense)[0];

  // balance trend: walk back from today's total balance by each month's net account movement
  const totalBal = accounts.reduce((s, a) => s + a.balance, 0);
  const monthNet = (k: string) =>
    rows.reduce((s, r) => {
      if (!r.ymd.startsWith(k)) return s;
      if (r.type === "INCOME") return s + r.amount;
      if (r.type === "EXPENSE" && r.accountId) return s - r.amount;
      return s;
    }, 0);
  let run = totalBal;
  const ends: number[] = [];
  for (let i = monthKeys.length - 1; i >= 0; i--) {
    ends.unshift(run);
    run -= monthNet(monthKeys[i]);
  }
  const minB = Math.min(...ends);
  const maxB = Math.max(...ends);
  const pts = ends
    .map((v, i) => `${((i * 300) / (ends.length - 1)).toFixed(1)},${(105 - (maxB === minB ? 50 : ((v - minB) / (maxB - minB)) * 95)).toFixed(1)}`)
    .join(" ");

  const maxExp = Math.max(...aggs.map((a) => a.expense), 1);
  const expenseCats = categoryTotals(periodRows, "", "EXPENSE");
  const incomeCats = categoryTotals(periodRows, "", "INCOME");
  const merchants = merchantTotals(periodRows, "").slice(0, 5);

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      <div className="flex justify-end">
        <PrintButton />
      </div>
      <div className="flex flex-wrap gap-3.5">
        <div className="card flex-[1_1_160px] p-[var(--pad)]">
          <div className="text-[11px] text-mut font-semibold tracking-[.06em]">AVG DAILY SPEND</div>
          <div className="text-[22px] font-extrabold mt-[5px]">{formatPaise(avgDaily)}</div>
          <div className="text-[11.5px] text-mut2 mt-[5px]">{period.label.toLowerCase()}</div>
        </div>
        <div className="card flex-[1_1_160px] p-[var(--pad)]">
          <div className="text-[11px] text-mut font-semibold tracking-[.06em]">BIGGEST EXPENSE</div>
          <div className="text-[22px] font-extrabold mt-[5px]">{biggest ? formatPaise(biggest.myExpense) : "—"}</div>
          <div className="text-[11.5px] text-mut2 mt-[5px]">{biggest?.merchant ?? ""}</div>
        </div>
        <div className="card flex-[1_1_160px] p-[var(--pad)]">
          <div className="text-[11px] text-mut font-semibold tracking-[.06em]">SAVINGS RATE</div>
          <div className="text-[22px] font-extrabold mt-[5px] text-green">{rate}%</div>
          <div className="text-[11.5px] text-mut2 mt-[5px]">of {period.label.toLowerCase()} income</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-3.5">
        <section className="card flex-[1.4_1_320px] p-[var(--pad)]">
          <div className="flex justify-between items-baseline">
            <h2 className="text-[13.5px] font-bold m-0">Balance trend</h2>
            <div className="text-[11.5px] text-mut2">{monthName(monthKeys[0])} – {monthName(key)}</div>
          </div>
          <div className="flex gap-4 mt-1.5 text-[11.5px] text-mut">
            <div>{monthName(monthKeys[0])}: <span className="font-bold text-ink">{formatPaise(ends[0])}</span></div>
            <div>Now: <span className="font-bold text-green">{formatPaise(ends[ends.length - 1])}</span></div>
          </div>
          <svg viewBox="0 0 300 110" preserveAspectRatio="none" className="w-full h-[120px] block mt-2.5">
            <polyline points={pts} fill="none" stroke="var(--acc)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          </svg>
          <div className="flex mt-1.5">
            {monthKeys.map((k) => (
              <div key={k} className="flex-1 text-center text-[10.5px] text-mut2">{monthName(k)}</div>
            ))}
          </div>
        </section>

        <section className="card flex-[1.4_1_320px] p-[var(--pad)]">
          <h2 className="text-[13.5px] font-bold m-0">Monthly spending</h2>
          <div className="flex items-end gap-3.5 h-[130px] mt-4">
            {aggs.map((a, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1.5 h-full justify-end">
                <div className="text-[10px] text-mut2 font-semibold">{formatPaise(a.expense)}</div>
                <div className="w-full bg-acc rounded-[5px] opacity-85" style={{ height: `${Math.max(4, Math.round((a.expense / maxExp) * 100))}%` }} />
              </div>
            ))}
          </div>
          <div className="flex gap-3.5 mt-2">
            {monthKeys.map((k) => (
              <div key={k} className="flex-1 text-center text-[10.5px] text-mut2">{monthName(k)}</div>
            ))}
          </div>
        </section>

        <CategoryBreakdown expense={expenseCats} income={incomeCats} periodQuery={periodQS} periodLabel={period.label} />

        <section className="card flex-[1_1_240px] p-[var(--pad)] flex flex-col gap-[11px]">
          <h2 className="text-[13.5px] font-bold m-0">Top merchants · {period.label}</h2>
          {merchants.map((m) => (
            <div key={m.name} className="flex items-center gap-2.5">
              <div className="flex-1">
                <div className="text-[12.5px] font-semibold">{m.name}</div>
                <div className="text-[11px] text-mut2">{m.count} transaction{m.count > 1 ? "s" : ""}</div>
              </div>
              <div className="text-[12.5px] font-bold">{formatPaise(m.total)}</div>
            </div>
          ))}
          {merchants.length === 0 && <div className="text-[12px] text-mut2">No expenses in this period.</div>}
        </section>
      </div>
    </div>
  );
}
