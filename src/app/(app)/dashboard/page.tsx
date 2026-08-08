// Finance Hub (Phase 2.5, evolved from the PRD §4.6 decision-oriented
// dashboard): summarizes the user's whole financial world — accounts (with
// cash/bank/card breakdown), expenses (this vs last month, top category),
// lending, bills, shared expenses, financial health, a unified
// needs-attention feed, and recent cross-module activity. Desktop shows
// everything; mobile keeps the earlier deliberate trim (balance hero +
// spend + one attention item + recent transactions) plus ONE compact
// horizontally-scrollable hub strip so every module stays reachable from
// home (user-confirmed treatment).

import Link from "next/link";
import { CashFlowCard, type CashFlowSeries } from "@/components/dashboard/cashflow";
import { HealthWidget } from "@/components/dashboard/health-widget";
import { LiveBalance } from "@/components/dashboard/live-balance";
import { MobileHubStrip } from "@/components/dashboard/mobile-hub-strip";
import { NotificationCenter } from "@/components/dashboard/notification-center";
import { RecentActivityPanel } from "@/components/dashboard/recent-activity";
import { RecentTxList } from "@/components/dashboard/recent-tx-list";
import { OpenModalButton } from "@/components/shell/buttons";
import { SectionHeader } from "@/components/shell/section-header";
import { StatCard } from "@/components/shell/stat-card";
import { addDaysYMD, currentMonthKey, fullToday, greeting, monthName, shiftMonthKey, todayYMD, MONTH_NAMES } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { parsePeriod, periodQueryParams } from "@/lib/period";
import { soft, txDisplay } from "@/lib/tx-display";
import { MobileDashboard, type MobileDashboardData } from "./mobile-dashboard";
import { billUrgencyColor } from "@/lib/urgency";
import { listAccountRows } from "@/server/services/accounts";
import { activityPage } from "@/server/services/activity";
import { listBills } from "@/server/services/bills";
import { listBudgets } from "@/server/services/budgets";
import { cashTotals, categoryTotals, loadLedgerAgg, loadLedgerAggRange, monthAgg, recentTransactions } from "@/server/services/ledger";
import { lendingDashboardSummary, lendingReminders } from "@/server/services/lending";
import { listGroups } from "@/server/services/groups";
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
  const donutLabel =
    mode === "month" ? monthName(periodKey).toUpperCase() : mode === "all" ? "TO DATE" : mode === "recent" ? "30 DAYS" : "RANGE";
  // #186: "recent" ends today, so it behaves like the live current window for
  // the balance hero — same treatment the current month used to get.
  const isLiveWindow = mode === "recent" || mode === "all" || (mode === "month" && periodKey === key);
  const periodQS = periodQueryParams(selectedPeriod);
  const withPeriodQS = (href: string) => (periodQS ? `${href}?${periodQS}` : href);

  // rows (6 months) always covers the current month, so it's handed to
  // listBudgets below instead of that service doing its own narrower 1-month
  // fetch — same in-flight promise, no extra round trip, still fully parallel.
  const rowsPromise = loadLedgerAgg(user.id, 6, now);
  const [rows, periodRows, period, sinceEnd, unassignedAll, recentRows, accounts, budgets, bills, shared, lending, reminders, groups, activity] =
    await Promise.all([
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
      lendingDashboardSummary(user.id),
      lendingReminders(user.id),
      listGroups(user.id),
      activityPage(user.id, { limit: 6 }),
    ]);

  const accountsTotal = accounts.reduce((s, a) => s + a.balance, 0);
  const balanceNow = accountsTotal + (unassignedAll.income - unassignedAll.expense);
  const balanceAtEnd = balanceNow - (sinceEnd.income - sinceEnd.expense);
  const carryForward = balanceAtEnd - (period.income - period.expense);
  const txCountPeriod = periodRows.filter((r) => r.type === "EXPENSE").length;
  // formatPaise renders magnitude only — balances (unlike income/expense) can be negative
  const signed = (v: number) => `${v < 0 ? "−" : ""}${formatPaise(v)}`;

  // accounts breakdown by type (Finance Hub: Total / Cash / Banks / Credit Cards)
  const sumType = (...types: string[]) => accounts.filter((a) => types.includes(a.type)).reduce((s, a) => s + a.balance, 0);
  const cashTotal = sumType("CASH", "WALLET");
  const bankTotal = sumType("BANK", "INVESTMENT");
  const cardTotal = sumType("CREDIT_CARD");

  // expenses: this month vs last month + top category (Finance Hub)
  const lastMonthKey = shiftMonthKey(key, -1);
  const lastMonthAgg = monthAgg(rows, lastMonthKey);

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
  const billsOverdueCount = bills.filter((b) => b.urgency === "overdue").length;
  const billsUpcomingCount = bills.filter((b) => b.days >= 0 && b.days <= 10).length;
  const overBudgets = budgets.filter((b) => b.over);
  const pending = shared.members.filter((m) => Math.abs(m.net) > 100);
  const recent = recentRows.map(txDisplay);

  // Financial Health widget data — composed entirely from what's already fetched
  const nearestBill = bills[0];
  const healthData = {
    spendTrend: monthKeys.map((k) => ({ monthKey: k, expense: monthAgg(rows, k).expense })),
    outstandingLoans: lending.youAreOwed,
    upcomingBillCount: bills.filter((b) => b.days >= 0 && b.days <= 7).length,
    nearestBillLabel: nearestBill ? `${nearestBill.name} · ${nearestBill.dueLabel.toLowerCase()}` : null,
    creditExposure: accounts.filter((a) => a.type === "CREDIT_CARD").reduce((s, a) => s + Math.max(0, -a.balance), 0),
    netPosition: accountsTotal + lending.net,
  };

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

  // Mobile-native dashboard data — derived from the values already computed
  // above; no new queries. The desktop tree below is unchanged.
  const mobileNeeds: MobileDashboardData["needs"] = [];
  for (const b of bills.filter((x) => x.days <= 7).slice(0, 2))
    mobileNeeds.push({ icon: "💳", text: `${b.name} · ${formatPaise(b.amount)}`, sub: b.dueLabel, href: "/bills", sev: "red" });
  for (const b of overBudgets.slice(0, 2))
    mobileNeeds.push({ icon: "📊", text: `${b.category} over by ${formatPaise(b.spent - b.limit)}`, sub: `${formatPaise(b.spent)} of ${formatPaise(b.limit)}`, href: "/budgets", sev: "amber" });
  for (const m of pending.slice(0, 2))
    mobileNeeds.push({ icon: "🤝", text: `Settle with ${m.name}`, sub: m.net > 0 ? "they owe you" : "you owe them", href: "/shared", sev: "amber" });
  const upcomingBills = bills.filter((b) => b.days >= 0 && b.days <= 10);
  const mobileData: MobileDashboardData = {
    greeting: greeting(now),
    name: user.name,
    // #185: the hero is spendable money — the same figure the desktop hero
    // already showed. It used to be accountsTotal + lending.net, which meant
    // recording a loan you *gave* pushed the headline UP.
    spendable: balanceNow,
    owed: lending.youAreOwed,
    monthDelta: period.income - period.expense,
    comp: { banks: bankTotal, cash: cashTotal, cards: Math.max(0, -cardTotal) },
    flow: { income: period.income, expense: period.expense },
    needs: mobileNeeds.slice(0, 3),
    lending: { owed: lending.youAreOwed, owe: lending.youOwe, net: lending.net, overdue: lending.overdueCount, people: lending.contacts.filter((cc) => cc.net > 0).length },
    bills: upcomingBills.slice(0, 4).map((b) => ({ name: b.name, amount: b.amount, dueLabel: b.dueLabel })),
    billsCount: upcomingBills.length,
    billsTotal: upcomingBills.reduce((s, b) => s + b.amount, 0),
    budgets: budgets.slice(0, 3).map((b) => ({ name: b.category, spent: b.spent, limit: b.limit, over: b.over })),
    budgetsOver: overBudgets.length,
    recent: recent.slice(0, 5).map((d) => ({ icon: d.icon, title: d.name, sub: d.meta, amtF: d.amtF, amtColor: d.amtColor })),
  };

  return (
    <>
      <MobileDashboard data={mobileData} />
      <div className="hidden md:flex md:flex-col gap-4" style={{ animation: "rise .25s ease" }}>
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

      {/* period stat cards — every card deep-links (Finance Hub requirement) */}
      <div className="flex flex-wrap gap-3.5">
        <div className="flex-[1.5_1_250px] rounded-[14px] p-[var(--pad)] text-white" style={{ background: "linear-gradient(135deg,var(--dark1),var(--dark2))", boxShadow: "0 8px 24px rgba(28,39,64,.25)" }}>
          <div className="text-[11px] opacity-65 font-semibold tracking-[.06em]">{isLiveWindow && mode !== "all" ? "TOTAL BALANCE" : `BALANCE · ${periodLabel}`}</div>
          <LiveBalance basePaise={balanceAtEnd} live={isLiveWindow} />
          <div className="text-[11.5px] mt-[7px] opacity-75">
            {isLiveWindow && mode !== "all"
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
        <StatCard label="CARRY FORWARD" value={<span style={carryForward < 0 ? { color: "var(--red)" } : undefined}>{signed(carryForward)}</span>} className="hidden md:block" href={withPeriodQS("/accounts")}>
          <div className="text-[11.5px] mt-[7px] text-mut2">{mode === "all" ? "opening balances before tracking began" : "balance before this period"}</div>
        </StatCard>
        <StatCard label={`INCOME · ${periodLabel}`} value={<span className="text-green">+{formatPaise(period.income)}</span>} className="hidden md:block" href={withPeriodQS("/transactions")}>
          <div className="text-[11.5px] mt-[7px] text-mut2">money in</div>
        </StatCard>
        <StatCard label={`EXPENSE · ${periodLabel}`} value={<span>−{formatPaise(period.expense)}</span>} href={withPeriodQS("/transactions")}>
          <div className="text-[11.5px] mt-[7px] text-mut2">
            {txCountPeriod} transactions
            {mode === "month" && periodKey === key && lastMonthAgg.expense > 0 && (
              <> · last month {formatPaise(lastMonthAgg.expense)}</>
            )}
            {mode === "month" && periodKey === key && cats[0] && <> · top: {cats[0].name}</>}
          </div>
        </StatCard>
      </div>

      {/* mobile hub strip: the one mobile addition — compact deep-links into every module */}
      <MobileHubStrip
        data={{
          lendingNet: lending.net,
          lendingOwed: lending.youAreOwed,
          billsDueCount: bills.filter((b) => b.days <= 7).length,
          billsOverdue: billsOverdueCount > 0,
          pendingSettlements: pending.length,
          netPosition: healthData.netPosition,
        }}
      />

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
          {/* Finance Hub: at-a-glance breakdown by account type */}
          <div className="flex flex-wrap gap-x-3 gap-y-1 pt-2 border-t border-line text-[10.5px] text-mut2">
            <span>Cash {signed(cashTotal)}</span>
            <span>Banks {signed(bankTotal)}</span>
            {cardTotal !== 0 && <span className="text-red">Cards {signed(cardTotal)}</span>}
          </div>
        </section>
      </div>

      {/* financial world row: health + needs-attention feed + recent activity (Finance Hub) */}
      <div className="hidden md:flex flex-wrap gap-3.5 items-start">
        <HealthWidget data={healthData} />
        <NotificationCenter
          reminders={reminders}
          bills={bills.map((b) => ({ id: b.id, name: b.name, amount: b.amount, days: b.days, dueLabel: b.dueLabel, urgency: b.urgency }))}
          settlements={pending.map((m) => ({ participantId: m.id, name: m.name, net: m.net }))}
        />
        <RecentActivityPanel events={activity.events} />
      </div>

      {/* categories + lending + bills + settlements */}
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
        <section className="card p-[var(--pad)] flex-[1_1_230px] flex flex-col gap-[11px]">
          <SectionHeader title="Lending" href="/lending" />
          <Link href="/lending" className="no-underline text-ink flex flex-col gap-2">
            <div className="flex justify-between text-[12.5px]">
              <span className="text-mut font-medium">You’ll get</span>
              <span className="font-bold text-green">{formatPaise(lending.youAreOwed)}</span>
            </div>
            <div className="flex justify-between text-[12.5px]">
              <span className="text-mut font-medium">You’ll pay</span>
              <span className="font-bold text-red">{formatPaise(lending.youOwe)}</span>
            </div>
            <div className="flex justify-between text-[12.5px] pt-2 border-t border-line">
              <span className="text-mut font-medium">Net lending</span>
              <span className="font-bold" style={{ color: lending.net < 0 ? "var(--red)" : "var(--green)" }}>
                {lending.net < 0 ? "−" : "+"}{formatPaise(Math.abs(lending.net))}
              </span>
            </div>
            {lending.overdueCount > 0 && (
              <div className="text-[11px] font-semibold text-red">{lending.overdueCount} overdue loan{lending.overdueCount > 1 ? "s" : ""}</div>
            )}
          </Link>
        </section>
        <section className="card p-[var(--pad)] flex-[1_1_250px] flex flex-col gap-[11px]">
          <div className="flex justify-between items-center">
            <h2 className="text-[13.5px] font-bold m-0">
              Upcoming bills
              {(billsUpcomingCount > 0 || billsOverdueCount > 0) && (
                <span className="ml-1.5 text-[10.5px] font-semibold text-mut2">
                  {billsUpcomingCount} upcoming{billsOverdueCount > 0 && <span className="text-red"> · {billsOverdueCount} overdue</span>}
                </span>
              )}
            </h2>
            <Link href="/bills" className="text-[11.5px] font-semibold no-underline">All →</Link>
          </div>
          {bills7.map((b) => (
            <Link key={b.id} href="/bills" className="flex items-center gap-2.5 no-underline text-ink">
              <div className="w-[30px] h-[30px] rounded-[9px] grid place-items-center text-[13px]" style={{ background: soft(b.color) }}>{b.icon}</div>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] font-semibold truncate">{b.name}</div>
                <div className="text-[11px] font-semibold" style={{ color: billUrgencyColor(b.urgency) }}>{b.dueLabel}</div>
              </div>
              <div className="text-[12.5px] font-bold">{formatPaise(b.amount)}</div>
            </Link>
          ))}
          {bills7.length === 0 && <div className="text-[12px] text-mut2">Nothing due in the next 10 days 🎉</div>}
        </section>
        <section className="card p-[var(--pad)] flex-[1_1_250px] flex flex-col gap-[11px]">
          <div className="flex justify-between items-center">
            <h2 className="text-[13.5px] font-bold m-0">
              Settlements
              {groups.length > 0 && <span className="ml-1.5 text-[10.5px] font-semibold text-mut2">{groups.length} group{groups.length > 1 ? "s" : ""}</span>}
            </h2>
            <Link href="/shared" className="text-[11.5px] font-semibold no-underline">Shared →</Link>
          </div>
          {pending.map((m) => (
            <Link key={m.id} href="/shared" className="flex items-center gap-2.5 no-underline text-ink">
              <div className="w-[30px] h-[30px] rounded-full grid place-items-center text-[11.5px] font-bold text-white" style={{ background: m.color }}>{m.initial}</div>
              <div className="flex-1">
                <div className="text-[12.5px] font-semibold">{m.name}</div>
                <div className="text-[11px] text-mut2">{m.net > 0 ? "owes you" : "you owe"}</div>
              </div>
              <div className="text-[12.5px] font-bold" style={{ color: m.net > 0 ? "var(--green)" : "var(--red)" }}>{formatPaise(m.net)}</div>
            </Link>
          ))}
          {pending.length === 0 && <div className="text-[12px] text-mut2">All settled up ✨</div>}
        </section>
      </div>

      {/* recent + budgets. min-w-0: without it, a flex item won't shrink
          below its content's intrinsic width, so a long untruncated
          transaction meta line can force this section (and the page) wider
          than the viewport before the row's own `truncate` ever gets a
          chance to clip it. */}
      <div className="flex flex-wrap gap-3.5">
        <section className="card p-[var(--pad)] flex-[1.6_1_340px] min-w-0 flex flex-col gap-3">
          <SectionHeader title="Recent transactions" href={withPeriodQS("/transactions")} />
          <RecentTxList rows={recent.map((t) => ({ id: t.id, icon: t.icon, iconBg: t.iconBg, name: t.name, meta: t.meta, amtF: t.amtF, amtColor: t.amtColor }))} />
        </section>
        {/* full budget list already has its own page — mobile home relies on
            the attention item above for anything urgent instead of repeating it */}
        <section className="hidden md:flex card p-[var(--pad)] flex-[1_1_280px] flex-col gap-[13px]">
          <SectionHeader title="Budgets" href="/budgets" />
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
    </>
  );
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
