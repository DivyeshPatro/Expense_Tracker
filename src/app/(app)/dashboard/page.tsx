// Decision-oriented dashboard (PRD §4.6). Desktop: attention strip, then the
// period cards (Current Balance / Carry forward / Income / Expense, scoped to
// this month by default, filterable to any month / custom range / to-date),
// cash flow, accounts, donut, bills, settlements, recent transactions, budgets.
// Mobile home is trimmed to just balance hero + this month's spend + a single
// most-urgent item (over-budget or due bill, whichever is more urgent) +
// recent transactions — everything else already has its own page (Analytics/
// Accounts/Budgets/Bills/Shared), so mobile doesn't repeat it here too.

import Link from "next/link";
import { CashFlowCard, type CashFlowSeries } from "@/components/dashboard/cashflow";
import { LiveBalance } from "@/components/dashboard/live-balance";
import { OpenModalButton } from "@/components/shell/buttons";
import { addDaysYMD, currentMonthKey, fullToday, greeting, monthName, shiftMonthKey, todayYMD, MONTH_NAMES } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { parsePeriod, periodQueryParams } from "@/lib/period";
import { soft, txDisplay } from "@/lib/tx-display";
import { listAccountRows } from "@/server/services/accounts";
import { listBills } from "@/server/services/bills";
import { listBudgets } from "@/server/services/budgets";
import { cashTotals, categoryTotals, loadLedgerAgg, loadLedgerAggRange, monthAgg, recentTransactions } from "@/server/services/ledger";
import { sharedSummary } from "@/server/services/shared";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const now = new Date();
  const key = currentMonthKey(now);

  // ── selected period (?p=YYYY-MM | ?p=all | ?from&to; default: this month) —
  // shared across Dashboard/Transactions/Accounts/Analytics via the header picker ──
  const sp = await searchParams;
  const selectedPeriod = parsePeriod(sp, now);
  const { mode, periodKey, range, label: periodLabel } = selectedPeriod;
  const donutLabel = mode === "month" ? monthName(periodKey).toUpperCase() : mode === "all" ? "TO DATE" : "RANGE";
  const periodQS = periodQueryParams(selectedPeriod);
  const withPeriodQS = (href: string) => (periodQS ? `${href}?${periodQS}` : href);

  // rows (6 months) always covers the current month, so it's handed to
  // listBudgets below instead of that service doing its own narrower 1-month
  // fetch — same in-flight promise, no extra round trip, still fully parallel
  // (listBudgets's own budget.findMany still fires immediately either way).
  const rowsPromise = loadLedgerAgg(user.id, 6, now);
  const [rows, periodRows, period, sinceEnd, unassignedAll, recentRows, accounts, budgets, bills, shared] = await Promise.all([
    rowsPromise,
    loadLedgerAggRange(user.id, range.start, range.end),
    cashTotals(user.id, { start: range.start, end: range.end }),
    // cash moved after the period ends — walks today's balance back to the period-end balance
    range.end && range.end < now ? cashTotals(user.id, { start: range.end }) : Promise.resolve({ income: 0, expense: 0 }),
    // ledger rows never posted to an account (imported history without account info):
    // their cash effect is real but absent from every account's balance
    cashTotals(user.id, { unassignedOnly: true }),
    recentTransactions(user.id, 6),
    listAccountRows(user.id),
    listBudgets(user.id, now, rowsPromise),
    listBills(user.id, now),
    sharedSummary(user.id),
  ]);

  const accountsTotal = accounts.reduce((s, a) => s + a.balance, 0);
  const balanceNow = accountsTotal + (unassignedAll.income - unassignedAll.expense);
  const balanceAtEnd = balanceNow - (sinceEnd.income - sinceEnd.expense);
  const carryForward = balanceAtEnd - (period.income - period.expense);
  const txCountPeriod = periodRows.filter((r) => r.type === "EXPENSE").length;
  // formatPaise renders magnitude only — balances (unlike income/expense) can be negative
  const signed = (v: number) => `${v < 0 ? "−" : ""}${formatPaise(v)}`;

  // cash flow series (6M / 8W / 14D)
  const monthKeys = Array.from({ length: 6 }, (_, i) => shiftMonthKey(key, i - 5));
  const series: CashFlowSeries[] = [
    { mode: "M", chip: "6M", bars: normalize(monthKeys.map((k) => ({ label: monthName(k), ...monthAgg(rows, k) }))) },
    { mode: "W", chip: "8W", bars: normalize(weekBars(rows, now)) },
    { mode: "D", chip: "14D", bars: normalize(dayBars(rows, now)) },
  ];

  // category donut — for the selected period ("" prefix matches every row, since periodRows is already scoped)
  const cats = categoryTotals(periodRows, "");
  const top5 = cats.slice(0, 5);
  const otherSum = cats.slice(5).reduce((s, c) => s + c.total, 0);
  const donutItems = [...top5, ...(otherSum > 0 ? [{ name: "Other", icon: "", color: "#9aa0ae", total: otherSum }] : [])];
  const donutTotal = donutItems.reduce((s, c) => s + c.total, 0) || 1;
  let cum = 0;
  const segs = donutItems.map((c) => {
    const from = (cum / donutTotal) * 100;
    cum += c.total;
    return `${c.color} ${from.toFixed(1)}% ${((cum / donutTotal) * 100).toFixed(1)}%`;
  });
  const donutBg = `conic-gradient(${segs.join(", ") || "var(--accSoft) 0 100%"})`;

  const bills7 = bills.filter((b) => b.days <= 10).slice(0, 4);
  const overBudgets = budgets.filter((b) => b.over);
  const pending = shared.members.filter((m) => Math.abs(m.net) > 100);
  const recent = recentRows.map(txDisplay);

  // attention strip (desktop: every applicable chip, unchanged)
  const attention: { icon: string; text: string; href: string; bg: string; color: string }[] = [];
  for (const b of bills.filter((x) => x.days <= 7)) {
    attention.push({ icon: "🔴", text: `${b.name} ${formatPaise(b.amount)} · ${b.dueLabel.toLowerCase()}`, href: "/bills", bg: "var(--redSoft)", color: "var(--red)" });
  }
  for (const b of overBudgets) {
    attention.push({ icon: "⚠️", text: `${b.category} budget exceeded · over by ${formatPaise(b.spent - b.limit)}`, href: "/budgets", bg: "var(--amberSoft)", color: "var(--amber)" });
  }
  if (shared.owedToYou > 100) attention.push({ icon: "👥", text: `Friends owe you ${formatPaise(shared.owedToYou)}`, href: "/shared", bg: "var(--greenSoft)", color: "var(--green)" });
  if (shared.youOwe > 100) attention.push({ icon: "💸", text: `You owe ${formatPaise(shared.youOwe)}`, href: "/shared", bg: "var(--accSoft)", color: "var(--acc)" });

  // mobile home shows a single most-urgent item instead of the full strip
  // (audit: "1 attention item — over-budget or due bill, whichever is more
  // urgent" — a hard-deadline bill due today/soon outranks an over-budget
  // category, which outranks a bill merely due within the week; settlements
  // aren't part of this slot since they're not a deadline and stay reachable
  // via Shared).
  const urgentBill = bills.find((b) => b.urgency === "overdue" || b.urgency === "urgent");
  const worstOverBudget = overBudgets.length ? [...overBudgets].sort((a, b) => b.spent - b.limit - (a.spent - a.limit))[0] : undefined;
  const soonBill = bills.find((b) => b.urgency === "soon");
  const billChip = (b: (typeof bills)[number]) => ({ icon: "🔴", text: `${b.name} ${formatPaise(b.amount)} · ${b.dueLabel.toLowerCase()}`, href: "/bills", bg: "var(--redSoft)", color: "var(--red)" });
  const mobileAttention = urgentBill
    ? billChip(urgentBill)
    : worstOverBudget
      ? { icon: "⚠️", text: `${worstOverBudget.category} budget exceeded · over by ${formatPaise(worstOverBudget.spent - worstOverBudget.limit)}`, href: "/budgets", bg: "var(--amberSoft)", color: "var(--amber)" }
      : soonBill
        ? billChip(soonBill)
        : null;

  return (
    <div className="flex flex-col gap-4" style={{ animation: "rise .25s ease" }}>
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <div className="text-[12.5px] text-mut font-medium">{greeting(now)}, {user.name}</div>
          <div className="text-[21px] font-extrabold tracking-tight">{fullToday(now)}</div>
        </div>
      </div>

      {/* mobile home: a single most-urgent item instead of the full strip */}
      {mobileAttention && (
        <Link
          href={mobileAttention.href}
          className="md:hidden flex items-center gap-[7px] px-3 py-[7px] rounded-full text-xs font-semibold no-underline hover:brightness-97 self-start"
          style={{ background: mobileAttention.bg, color: mobileAttention.color }}
        >
          <span>{mobileAttention.icon}</span>
          {mobileAttention.text}
        </Link>
      )}
      {/* desktop: every applicable chip, unchanged */}
      {attention.length > 0 && (
        <div className="hidden md:flex flex-wrap gap-2">
          {attention.map((a, i) => (
            <Link key={i} href={a.href} className="flex items-center gap-[7px] px-3 py-[7px] rounded-full text-xs font-semibold no-underline hover:brightness-97" style={{ background: a.bg, color: a.color }}>
              <span>{a.icon}</span>
              {a.text}
            </Link>
          ))}
        </div>
      )}

      {/* period stat cards — the period itself is picked from the header, shared across sections.
          Mobile home keeps only the balance hero + this month's spend; Carry forward and Income
          stay desktop-only (audit: mobile leads with "balance hero, this month's spend, ..."). */}
      <div className="flex flex-wrap gap-3.5">
        <div className="flex-[1.5_1_250px] rounded-[14px] p-[var(--pad)] text-white" style={{ background: "linear-gradient(135deg,var(--dark1),var(--dark2))", boxShadow: "0 8px 24px rgba(28,39,64,.25)" }}>
          <div className="text-[11px] opacity-65 font-semibold tracking-[.06em]">{mode === "month" && periodKey === key ? "TOTAL BALANCE" : `BALANCE · ${periodLabel}`}</div>
          <LiveBalance basePaise={balanceAtEnd} live={mode === "all" || (mode === "month" && periodKey === key)} />
          <div className="text-[11.5px] mt-[7px] opacity-75">
            {mode === "month" && periodKey === key
              ? `${signed(accountsTotal)} across ${accounts.length} accounts${balanceNow !== accountsTotal ? ` · ${signed(balanceNow - accountsTotal)} net from unassigned history` : ""}`
              : mode === "all"
                ? "everything from your first transaction to today"
                : "balance at the end of this period"}
          </div>
          <div className="text-[10.5px] mt-2.5 pt-2.5 opacity-60 flex flex-wrap gap-x-3 gap-y-1" style={{ borderTop: "1px solid rgba(255,255,255,.15)" }}>
            <span>Carry forward {signed(carryForward)}</span>
            <span>+ Income {formatPaise(period.income)}</span>
            <span>− Expense {formatPaise(period.expense)}</span>
          </div>
        </div>
        <StatCard label="CARRY FORWARD" value={<span style={carryForward < 0 ? { color: "var(--red)" } : undefined}>{signed(carryForward)}</span>} className="hidden md:block">
          <div className="text-[11.5px] mt-[7px] text-mut2">{mode === "all" ? "opening balances before tracking began" : "balance before this period"}</div>
        </StatCard>
        <StatCard label={`INCOME · ${periodLabel}`} value={<span className="text-green">+{formatPaise(period.income)}</span>} className="hidden md:block">
          <div className="text-[11.5px] mt-[7px] text-mut2">money in</div>
        </StatCard>
        <StatCard label={`EXPENSE · ${periodLabel}`} value={<span>−{formatPaise(period.expense)}</span>}>
          <div className="text-[11.5px] mt-[7px] text-mut2">{txCountPeriod} transactions</div>
        </StatCard>
      </div>

      {/* cash flow + accounts — already have their own pages (Analytics/Accounts), so mobile home skips them */}
      <div className="hidden md:flex flex-wrap gap-3.5">
        <CashFlowCard series={series} />
        <section className="card p-[var(--pad)] flex-[1_1_260px] flex flex-col gap-[11px]">
          <div className="flex justify-between items-center">
            <h2 className="text-[13.5px] font-bold m-0">Accounts</h2>
            <OpenModalButton type="tr" className="text-[11.5px] font-semibold text-acc cursor-pointer px-[9px] py-1 rounded-[7px] bg-transparent border-none hover:bg-accsoft">
              ⇄ Transfer
            </OpenModalButton>
          </div>
          {accounts.map((a) => (
            <Link key={a.id} href={withPeriodQS("/accounts")} className="flex items-center gap-2.5 no-underline text-ink">
              <div className="w-[30px] h-[30px] rounded-[9px] grid place-items-center text-[13px]" style={{ background: soft(a.color) }}>{a.icon}</div>
              <div className="flex-1 min-w-0 text-[12.5px] font-semibold truncate">{a.name}</div>
              <div className="text-[12.5px] font-bold" style={{ color: a.balance < 0 ? "var(--red)" : "var(--ink)" }}>
                {a.balance < 0 ? "−" : ""}{formatPaise(a.balance)}
              </div>
            </Link>
          ))}
        </section>
      </div>

      {/* categories + bills + settlements — categories duplicates Analytics'
          Categories tab, bills/settlements are folded into the single mobile
          attention item above, so mobile home skips this whole row */}
      <div className="hidden md:flex flex-wrap gap-3.5">
        <section className="card p-[var(--pad)] flex-[1.1_1_280px]">
          <h2 className="text-[13.5px] font-bold m-0">Spending by category</h2>
          <div className="flex items-center gap-[18px] mt-3.5 flex-wrap">
            <div className="w-[110px] h-[110px] rounded-full grid place-items-center flex-none" style={{ background: donutBg }}>
              <div className="w-[72px] h-[72px] rounded-full bg-card grid place-items-center text-center">
                <div>
                  <div className="text-[10px] text-mut2 font-semibold">{donutLabel}</div>
                  <div className="text-xs font-extrabold">{formatPaise(period.expense)}</div>
                </div>
              </div>
            </div>
            <div className="flex-1 min-w-[140px] flex flex-col gap-[7px]">
              {donutItems.map((c) => (
                <div key={c.name} className="flex items-center gap-2 text-xs">
                  <span className="w-2 h-2 rounded-sm flex-none" style={{ background: c.color }} />
                  <span className="flex-1 text-mut font-medium">{c.name}</span>
                  <span className="font-bold">{formatPaise(c.total)}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
        <section className="card p-[var(--pad)] flex-[1_1_250px] flex flex-col gap-[11px]">
          <div className="flex justify-between items-center">
            <h2 className="text-[13.5px] font-bold m-0">Upcoming bills</h2>
            <Link href="/bills" className="text-[11.5px] font-semibold no-underline">All →</Link>
          </div>
          {bills7.map((b) => (
            <div key={b.id} className="flex items-center gap-2.5">
              <div className="w-[30px] h-[30px] rounded-[9px] grid place-items-center text-[13px]" style={{ background: soft(b.color) }}>{b.icon}</div>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] font-semibold truncate">{b.name}</div>
                <div className="text-[11px] font-semibold" style={{ color: urgencyColor(b.urgency) }}>{b.dueLabel}</div>
              </div>
              <div className="text-[12.5px] font-bold">{formatPaise(b.amount)}</div>
            </div>
          ))}
          {bills7.length === 0 && <div className="text-[12px] text-mut2">Nothing due in the next 10 days 🎉</div>}
        </section>
        <section className="card p-[var(--pad)] flex-[1_1_250px] flex flex-col gap-[11px]">
          <div className="flex justify-between items-center">
            <h2 className="text-[13.5px] font-bold m-0">Settlements</h2>
            <Link href="/shared" className="text-[11.5px] font-semibold no-underline">Shared →</Link>
          </div>
          {pending.map((m) => (
            <div key={m.id} className="flex items-center gap-2.5">
              <div className="w-[30px] h-[30px] rounded-full grid place-items-center text-[11.5px] font-bold text-white" style={{ background: m.color }}>{m.initial}</div>
              <div className="flex-1">
                <div className="text-[12.5px] font-semibold">{m.name}</div>
                <div className="text-[11px] text-mut2">{m.net > 0 ? "owes you" : "you owe"}</div>
              </div>
              <div className="text-[12.5px] font-bold" style={{ color: m.net > 0 ? "var(--green)" : "var(--red)" }}>{formatPaise(m.net)}</div>
            </div>
          ))}
          {pending.length === 0 && <div className="text-[12px] text-mut2">All settled up ✨</div>}
        </section>
      </div>

      {/* recent + budgets. min-w-0: without it, a flex item won't shrink
          below its content's intrinsic width, so a long untruncated
          transaction meta line can force this section (and the page) wider
          than the viewport before the row's own `truncate` ever gets a
          chance to clip it — this now matters on mobile since Budgets (the
          sibling that used to share this row) is hidden there. */}
      <div className="flex flex-wrap gap-3.5">
        <section className="card p-[var(--pad)] flex-[1.6_1_340px] min-w-0 flex flex-col gap-3">
          <div className="flex justify-between items-center">
            <h2 className="text-[13.5px] font-bold m-0">Recent transactions</h2>
            <Link href={withPeriodQS("/transactions")} className="text-[11.5px] font-semibold no-underline">All →</Link>
          </div>
          {recent.map((t) => (
            <div key={t.id} className="flex items-center gap-[11px]">
              <div className="w-[34px] h-[34px] rounded-[10px] grid place-items-center text-sm flex-none" style={{ background: t.iconBg }}>{t.icon}</div>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] font-semibold truncate">{t.name}</div>
                <div className="text-[11px] text-mut2 truncate">{t.meta}</div>
              </div>
              <div className="text-[12.5px] font-bold" style={{ color: t.amtColor }}>{t.amtF}</div>
            </div>
          ))}
        </section>
        {/* full budget list already has its own page — mobile home relies on
            the attention item above for anything urgent instead of repeating it */}
        <section className="hidden md:flex card p-[var(--pad)] flex-[1_1_280px] flex-col gap-[13px]">
          <div className="flex justify-between items-center">
            <h2 className="text-[13.5px] font-bold m-0">Budgets</h2>
            <Link href="/budgets" className="text-[11.5px] font-semibold no-underline">All →</Link>
          </div>
          {budgets.slice(0, 4).map((b) => (
            <div key={b.id}>
              <div className="flex justify-between text-xs font-semibold">
                <span>{b.icon} {b.category}</span>
                <span style={{ color: b.over ? "var(--red)" : b.warn ? "var(--amber)" : "var(--mut)" }}>
                  {b.over ? `Over by ${formatPaise(b.spent - b.limit)}` : `${formatPaise(b.limit - b.spent)} left`}
                </span>
              </div>
              <div className="h-[5px] rounded bg-accsoft mt-1.5">
                <div className="h-full rounded" style={{ width: `${Math.min(100, b.pct)}%`, background: b.over ? "var(--red)" : b.warn ? "var(--amber)" : "var(--acc)" }} />
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  children,
  className = "",
}: {
  label: string;
  value: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`card flex-[1_1_150px] p-[var(--pad)] ${className}`}>
      <div className="text-[11px] text-mut font-semibold tracking-[.06em]">{label}</div>
      <div className="text-[21px] font-extrabold mt-[5px]">{value}</div>
      {children}
    </div>
  );
}

function urgencyColor(u: string): string {
  if (u === "overdue" || u === "urgent") return "var(--red)";
  if (u === "soon") return "var(--amber)";
  return "var(--mut)";
}

type Bar = { label: string; income: number; expense: number };

function normalize(bars: Bar[]): { label: string; incPct: number; expPct: number }[] {
  const max = Math.max(1, ...bars.map((b) => Math.max(b.income, b.expense)));
  return bars.map((b) => ({
    label: b.label,
    incPct: Math.max(2, Math.round((b.income / max) * 100)),
    expPct: Math.max(2, Math.round((b.expense / max) * 100)),
  }));
}

/** One pass over rows into a per-day map, then bars are just map lookups — O(rows + buckets) instead of O(rows × buckets). */
function dailyTotals(rows: { ymd: string; type: string; amount: number; myExpense: number }[]): Map<string, { income: number; expense: number }> {
  const map = new Map<string, { income: number; expense: number }>();
  for (const r of rows) {
    if (r.type !== "INCOME" && r.type !== "EXPENSE") continue;
    const cur = map.get(r.ymd) ?? { income: 0, expense: 0 };
    if (r.type === "INCOME") cur.income += r.amount;
    else cur.expense += r.myExpense;
    map.set(r.ymd, cur);
  }
  return map;
}

function weekBars(rows: { ymd: string; type: string; amount: number; myExpense: number }[], now: Date): Bar[] {
  const today = todayYMD(now);
  const daily = dailyTotals(rows);
  const bars: Bar[] = [];
  for (let w = 7; w >= 0; w--) {
    const end = addDaysYMD(today, -w * 7);
    const start = addDaysYMD(end, -6);
    let income = 0;
    let expense = 0;
    for (let i = 0; i < 7; i++) {
      const d = daily.get(addDaysYMD(start, i));
      if (d) {
        income += d.income;
        expense += d.expense;
      }
    }
    bars.push({ label: (7 - w) % 2 ? "" : `${MONTH_NAMES[Number(start.slice(5, 7)) - 1]} ${Number(start.slice(8))}`, income, expense });
  }
  return bars;
}

function dayBars(rows: { ymd: string; type: string; amount: number; myExpense: number }[], now: Date): Bar[] {
  const today = todayYMD(now);
  const daily = dailyTotals(rows);
  const bars: Bar[] = [];
  for (let k = 13; k >= 0; k--) {
    const d = addDaysYMD(today, -k);
    const agg = daily.get(d);
    bars.push({ label: (13 - k) % 3 ? "" : `${MONTH_NAMES[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8))}`, income: agg?.income ?? 0, expense: agg?.expense ?? 0 });
  }
  return bars;
}
