import Link from "next/link";
import { notFound } from "next/navigation";
import { CategoryDonut } from "@/app/(app)/analytics/category-breakdown";
import { EmptyState } from "@/components/shell/empty-state";
import { ModuleActivity } from "@/components/shell/module-activity";
import { StatCard } from "@/components/shell/stat-card";
import { friendlyDay } from "@/lib/dates";
import { balanceState } from "@/lib/group-dashboard";
import { formatPaise } from "@/lib/money";
import { parsePeriod } from "@/lib/period";
import { groupDashboard, type GroupMemberView } from "@/server/services/group-dashboard";
import { requireUser } from "@/server/session";
import { GroupQuickActions, type SettleTarget } from "./group-actions";

export const dynamic = "force-dynamic";

export default async function GroupDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  const { groupId } = await params;
  const sp = await searchParams;
  const period = parsePeriod(sp);
  const g = await groupDashboard(user.id, groupId, period);
  if (!g) notFound();

  // You first, then everyone else by how much is outstanding — most relevant on top.
  const others = g.members.filter((m) => m.participantId !== null).sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  const you = g.members.find((m) => m.participantId === null)!;
  const settleTargets: SettleTarget[] = others
    .filter((m) => balanceState(m.net) !== "settled")
    .map((m) => ({ participantId: m.participantId!, name: m.name, net: m.net }));
  const memberIds = others.map((m) => m.participantId!);
  const maxTrend = Math.max(...g.spending.trend.map((t) => t.total), 1);

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      {/* Header */}
      <div className="flex items-center gap-2.5">
        <Link
          href="/shared"
          aria-label="Back to Shared"
          className="w-9 h-9 rounded-lg grid place-items-center text-mut cursor-pointer bg-card border border-line2 hover:bg-accsoft flex-none no-underline"
        >
          ←
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-[17px] font-extrabold tracking-tight m-0 truncate flex items-center gap-2">🏠 {g.name}</h1>
          <div className="text-[11.5px] text-mut2">
            {g.memberCount + 1} member{g.memberCount === 0 ? "" : "s"} · created {friendlyDay(g.createdAt.slice(0, 10))}
          </div>
        </div>
      </div>

      {/* Overview */}
      <div className="flex flex-wrap gap-3.5">
        <StatCard label={`TOTAL EXPENSES`} value={formatPaise(g.overview.totalExpenseSum)}>
          <div className="text-[11.5px] text-mut2 mt-[5px]">{g.overview.totalExpenseCount} shared · all time</div>
        </StatCard>
        <StatCard label="SETTLEMENTS" value={formatPaise(g.overview.totalSettlementSum)}>
          <div className="text-[11.5px] text-mut2 mt-[5px]">{g.overview.totalSettlementCount} recorded</div>
        </StatCard>
        <StatCard
          label="NET POSITION"
          value={
            <span style={{ color: g.youNet < 0 ? "var(--red)" : g.youNet > 0 ? "var(--green)" : "var(--mut2)" }}>
              {g.youNet === 0 ? "—" : g.youNet < 0 ? "−" : "+"}
              {g.youNet === 0 ? "" : formatPaise(Math.abs(g.youNet))}
            </span>
          }
        >
          <div className="text-[11.5px] text-mut2 mt-[5px]">
            {g.youAreOwed > 0 && <span className="text-green">+{formatPaise(g.youAreOwed)} owed to you</span>}
            {g.youAreOwed > 0 && g.youOwe > 0 && " · "}
            {g.youOwe > 0 && <span className="text-red">−{formatPaise(g.youOwe)} you owe</span>}
            {g.youAreOwed === 0 && g.youOwe === 0 && "all settled up"}
          </div>
        </StatCard>
      </div>

      {/* Quick actions */}
      <GroupQuickActions groupId={g.id} memberIds={memberIds} settleTargets={settleTargets} />

      {/* Spending (follows the global period) */}
      <section className="card p-[var(--pad)] flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[13.5px] font-bold m-0">Spending · {period.label}</h2>
          <div className="text-[13px] font-extrabold tabular-nums">{formatPaise(g.spending.totalSpent)}</div>
        </div>
        {g.spending.categories.length === 0 ? (
          <EmptyState icon="📊" title="No expenses in this period" detail="Add a shared expense, or pick a wider date range." compact />
        ) : (
          <>
            <CategoryDonut rows={g.spending.categories} total={g.spending.totalSpent} />
            <div className="flex flex-col gap-2.5">
              {g.spending.categories.slice(0, 6).map((c) => {
                const pct = Math.round((c.total / g.spending.totalSpent) * 100);
                return (
                  <div key={c.name}>
                    <div className="flex justify-between text-xs font-semibold">
                      <span>{c.icon} {c.name}</span>
                      <span className="tabular-nums">{formatPaise(c.total)} · {pct}%</span>
                    </div>
                    <div className="h-[5px] rounded bg-accsoft mt-[5px]">
                      <div className="h-full rounded" style={{ width: `${pct}%`, background: c.color }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* Monthly trend */}
        <div className="mt-1">
          <h3 className="text-[12px] font-bold text-mut2 uppercase tracking-wide m-0 mb-2">Last 6 months</h3>
          <div className="flex items-end gap-2 h-[110px]" role="img" aria-label="Monthly group spending, last 6 months">
            {g.spending.trend.map((t) => (
              <div key={t.key} className="flex-1 flex flex-col items-center gap-1.5 h-full justify-end">
                <div className="text-[9.5px] text-mut2 font-semibold tabular-nums whitespace-nowrap">{t.total > 0 ? formatPaise(t.total) : ""}</div>
                <div className="w-full rounded-[5px] bg-acc opacity-85" style={{ height: `${Math.max(2, Math.round((t.total / maxTrend) * 100))}%` }} />
                <div className="text-[10px] text-mut2">{t.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Members */}
      <section className="card p-[var(--pad)] flex flex-col gap-1">
        <h2 className="text-[13.5px] font-bold m-0 mb-1.5">Members · contribution</h2>
        <MemberRow m={you} />
        {others.map((m) => (
          <MemberRow key={m.participantId} m={m} />
        ))}
        {g.memberCount === 0 && (
          <EmptyState
            icon="👥"
            title="This group is just you"
            detail="Add members to start splitting expenses and tracking who owes what."
            compact
          />
        )}
      </section>

      {/* Settlements */}
      <section className="card p-[var(--pad)] flex flex-col gap-3">
        <h2 className="text-[13.5px] font-bold m-0">Settlements</h2>

        {/* Outstanding — real balances now; P3 layers the optimal-payment suggestions on top. */}
        {settleTargets.length > 0 ? (
          <div className="flex flex-col gap-2">
            <div className="text-[11px] font-bold text-mut2 uppercase tracking-wide">Outstanding</div>
            {settleTargets.map((t) => {
              const owesYou = t.net > 0;
              return (
                <div key={t.participantId} className="flex items-center justify-between gap-2 text-[12.5px]">
                  <span className="font-semibold">{t.name}</span>
                  <span className="font-bold" style={{ color: owesYou ? "var(--green)" : "var(--red)" }}>
                    {owesYou ? "owes you " : "you owe "}
                    {formatPaise(Math.abs(t.net))}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-[12.5px] text-mut2">Everyone is settled up. 🎉</div>
        )}

        <div className="border-t border-line pt-2.5">
          <div className="text-[11px] font-bold text-mut2 uppercase tracking-wide mb-2">Recent settlements</div>
          {g.settlements.length === 0 ? (
            <EmptyState icon="🤝" title="No settlements yet" detail="When someone pays you back, record it and it shows here." compact />
          ) : (
            <div className="flex flex-col gap-1.5">
              {g.settlements.slice(0, 8).map((s) => (
                <div key={s.id} className="flex justify-between text-xs py-0.5">
                  <span className="text-mut">
                    {s.direction === "TO_OWNER" ? `${s.participantName} paid you ` : `You paid ${s.participantName} `}
                    {formatPaise(s.amount)} · {s.method}
                  </span>
                  <span className="text-mut2">{friendlyDay(s.settledAt.slice(0, 10))}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Activity — scoped to this group's transactions + settlements */}
      <ModuleActivity entityIds={g.activityEntityIds} />
    </div>
  );
}

function MemberRow({ m }: { m: GroupMemberView }) {
  const state = balanceState(m.net);
  const stateColor = state === "owes-you" ? "var(--green)" : state === "you-owe" ? "var(--red)" : "var(--mut2)";
  const isYou = m.participantId === null;
  const stateLabel = isYou
    ? m.net > 0
      ? "you are owed"
      : m.net < 0
        ? "you owe overall"
        : "settled up"
    : state === "owes-you"
      ? "owes you"
      : state === "you-owe"
        ? "you owe"
        : "settled up";
  return (
    <div className="flex items-center gap-3 py-2 border-b border-line last:border-b-0">
      <span className="w-9 h-9 rounded-full grid place-items-center text-[13px] font-bold text-white flex-none" style={{ background: m.color }}>
        {m.initial}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-bold truncate">
          {m.name}
          {isYou && <span className="text-mut2 font-semibold"> · owner</span>}
        </div>
        <div className="text-[11px] text-mut2 tabular-nums">
          paid {formatPaise(m.paid)} · share {formatPaise(m.owes)} · {m.contributionPct}%
        </div>
      </div>
      <div className="text-right flex-none">
        <div className="text-[13px] font-extrabold tabular-nums" style={{ color: stateColor }}>
          {state === "settled" ? "—" : formatPaise(Math.abs(m.net))}
        </div>
        <div className="text-[10.5px] font-semibold" style={{ color: stateColor }}>{stateLabel}</div>
      </div>
    </div>
  );
}
