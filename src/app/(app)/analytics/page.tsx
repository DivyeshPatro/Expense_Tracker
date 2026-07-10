import { currentMonthKey, monthName, shiftMonthKey, todayYMD } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { listAccounts } from "@/server/services/accounts";
import { categoryTotals, loadLedger, merchantTotals, monthAgg } from "@/server/services/ledger";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const user = await requireUser();
  const now = new Date();
  const key = currentMonthKey(now);
  const [rows, accounts] = await Promise.all([loadLedger(user.id, 6, now), listAccounts(user.id, now)]);

  const monthKeys = Array.from({ length: 6 }, (_, i) => shiftMonthKey(key, i - 5));
  const aggs = monthKeys.map((k) => monthAgg(rows, k));
  const agg = aggs[aggs.length - 1];
  const dayOfMonth = Number(todayYMD(now).slice(8));
  const avgDaily = Math.round(agg.expense / Math.max(1, dayOfMonth));
  const savings = agg.income - agg.expense;
  const rate = agg.income ? Math.max(0, Math.round((savings / agg.income) * 100)) : 0;

  const monthExpenses = rows.filter((r) => r.type === "EXPENSE" && r.ymd.startsWith(key));
  const biggest = [...monthExpenses].sort((a, b) => b.myExpense - a.myExpense)[0];

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
  const cats = categoryTotals(rows, key).slice(0, 5);
  const maxCat = cats[0]?.total ?? 1;
  const merchants = merchantTotals(rows, key).slice(0, 5);

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      <div className="flex flex-wrap gap-3.5">
        <div className="card flex-[1_1_160px] p-[var(--pad)]">
          <div className="text-[11px] text-mut font-semibold tracking-[.06em]">AVG DAILY SPEND</div>
          <div className="text-[22px] font-extrabold mt-[5px]">{formatPaise(avgDaily)}</div>
          <div className="text-[11.5px] text-mut2 mt-[5px]">{monthName(key)}, to date</div>
        </div>
        <div className="card flex-[1_1_160px] p-[var(--pad)]">
          <div className="text-[11px] text-mut font-semibold tracking-[.06em]">BIGGEST EXPENSE</div>
          <div className="text-[22px] font-extrabold mt-[5px]">{biggest ? formatPaise(biggest.myExpense) : "—"}</div>
          <div className="text-[11.5px] text-mut2 mt-[5px]">{biggest?.merchant ?? ""}</div>
        </div>
        <div className="card flex-[1_1_160px] p-[var(--pad)]">
          <div className="text-[11px] text-mut font-semibold tracking-[.06em]">SAVINGS RATE</div>
          <div className="text-[22px] font-extrabold mt-[5px] text-green">{rate}%</div>
          <div className="text-[11.5px] text-mut2 mt-[5px]">of {monthName(key)} income</div>
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

        <section className="card flex-[1_1_280px] p-[var(--pad)] flex flex-col gap-3">
          <h2 className="text-[13.5px] font-bold m-0">Top categories · {monthName(key)}</h2>
          {cats.map((c) => (
            <div key={c.name}>
              <div className="flex justify-between text-xs font-semibold">
                <span>{c.icon} {c.name}</span>
                <span>{formatPaise(c.total)}</span>
              </div>
              <div className="h-[5px] rounded bg-accsoft mt-[5px]">
                <div className="h-full rounded" style={{ width: `${Math.round((c.total / maxCat) * 100)}%`, background: c.color }} />
              </div>
            </div>
          ))}
        </section>

        <section className="card flex-[1_1_240px] p-[var(--pad)] flex flex-col gap-[11px]">
          <h2 className="text-[13.5px] font-bold m-0">Top merchants · {monthName(key)}</h2>
          {merchants.map((m) => (
            <div key={m.name} className="flex items-center gap-2.5">
              <div className="flex-1">
                <div className="text-[12.5px] font-semibold">{m.name}</div>
                <div className="text-[11px] text-mut2">{m.count} transaction{m.count > 1 ? "s" : ""}</div>
              </div>
              <div className="text-[12.5px] font-bold">{formatPaise(m.total)}</div>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
