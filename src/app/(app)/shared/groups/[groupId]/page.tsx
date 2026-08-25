import Link from "next/link";
import { notFound } from "next/navigation";
import { CategoryDonut } from "@/app/(app)/analytics/category-breakdown";
import { EmptyState } from "@/components/shell/empty-state";
import { ModuleActivity } from "@/components/shell/module-activity";
import { StatCard } from "@/components/shell/stat-card";
import { friendlyDay } from "@/lib/dates";
import { balanceState, memberRowLabel } from "@/lib/group-dashboard";
import { formatPaise } from "@/lib/money";
import { parsePeriod } from "@/lib/period";
import { groupDashboard, type GroupMemberView } from "@/server/services/group-dashboard";
import { requireUser } from "@/server/session";
import { GroupManage } from "@/components/shared/groups-panel";
import { GroupBalances } from "./group-balances";
import { GroupExpenses } from "./group-expenses";
import { GroupQuickActions, type SettleTarget } from "./group-actions";
import { SettlementHistory } from "./settlement-history";

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
        {/* Rename / add / remove member / delete — moved here from the Shared
            home, where one chip per group duplicated the group list. */}
        <div className="flex-none">
          <GroupManage
            group={{
              id: g.id,
              name: g.name,
              role: g.role,
              members: others.map((m) => ({
                participantId: m.participantId!,
                name: m.name,
                initial: m.initial,
                color: m.color,
                role: m.role,
              })),
            }}
          />
        </div>
      </div>

      {/* Overview */}
      <div className="flex flex-wrap gap-3.5">
        <StatCard label={`TOTAL EXPENSES`} value={formatPaise(g.overview.totalExpenseSum)}>
          <div className="text-[11.5px] text-mut2 mt-[5px]">{g.overview.totalExpenseCount} shared · all time</div>
          {/* Spend recorded here but split with nobody — a personal purchase
              made on the trip, say. Without this line the owner's own standing
              sits above the sum of what the members owe by exactly this much,
              and there is nothing on the page to explain the difference. */}
          {g.overview.unsharedSum > 0 && (
            <div className="text-[11.5px] text-mut2 mt-[3px]" title="Recorded in this group but not split with anyone">
              {formatPaise(g.overview.unsharedSum)} not shared
            </div>
          )}
        </StatCard>
        <StatCard label="SETTLEMENTS" value={formatPaise(g.overview.totalSettlementSum)}>
          <div className="text-[11.5px] text-mut2 mt-[5px]">{g.overview.totalSettlementCount} recorded</div>
        </StatCard>
        <StatCard
          label="NET"
          value={
            <span style={{ color: g.youNet < 0 ? "var(--red)" : g.youNet > 0 ? "var(--green)" : "var(--mut2)" }}>
              {g.youNet === 0 ? "—" : g.youNet < 0 ? "−" : "+"}
              {g.youNet === 0 ? "" : formatPaise(Math.abs(g.youNet))}
            </span>
          }
        >
          <div className="text-[11.5px] text-mut2 mt-[5px]">
            {g.youAreOwed > 0 && <span className="text-green">+{formatPaise(g.youAreOwed)} you’ll get</span>}
            {g.youAreOwed > 0 && g.youOwe > 0 && " · "}
            {g.youOwe > 0 && <span className="text-red">−{formatPaise(g.youOwe)} you’ll pay</span>}
            {/* Same per-person rule the card and the settle list use: settled
                means nobody is outside the threshold, not that the two sums
                happen to be zero — which sub-rupee dust alone could prevent. */}
            {others.every((m) => balanceState(m.net) === "settled") && "all settled"}
          </div>
        </StatCard>
      </div>

      {/* Quick actions */}
      <GroupQuickActions groupId={g.id} memberIds={memberIds} settleTargets={settleTargets} canRecordSettlements={g.canRecordSettlements} />

      {/* v2.1: the expenses that produce the total above, directly beneath it.
          Previously the page went straight from "Total expenses ₹X" to charts
          and balances, so the transactions behind the number were unreachable
          from the context the user found them in. Tapping one opens the shared
          transaction sheet — the same one Spending uses — for view/edit/delete. */}
      <GroupExpenses expenses={g.expenses} groupId={g.id} />

      {/* Members / who owes whom */}
      <section className="card p-[var(--pad)] flex flex-col gap-1">
        <h2 className="text-[13.5px] font-bold m-0 mb-1.5">Members · contribution</h2>
        <MemberRow m={you} viewerParticipantId={g.viewerParticipantId} />
        {others.map((m) => (
          <MemberRow key={m.participantId} m={m} viewerParticipantId={g.viewerParticipantId} />
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

      {/* Group Settlement: the group-wide payment plan first ("who pays
          whom"), with the detailed obligations and your personal standing
          behind it ("why"). Every list comes from the existing engine —
          per-member nets, computeGrossObligations and minimizeSettlements. */}
      <GroupBalances
        members={g.members}
        obligations={g.detailed}
        suggestions={g.suggestions}
        groupId={g.id}
        groupName={g.name}
        ownerName={g.ownerName}
        canRecordSettlements={g.canRecordSettlements}
        viewerParticipantId={g.viewerParticipantId}
      />

      {/* Insights — charts follow the global period. Below the concrete rows
          now: they explain the spend, they aren't the thing being looked for. */}
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

      {/* Settlement history — month-grouped, with delete */}
      <SettlementHistory settlements={g.settlements} ownerName={g.ownerName} canManage={g.canRecordSettlements} />

      {/* Activity — scoped to this group's transactions + settlements */}
      <ModuleActivity entityIds={g.activityEntityIds} />
    </div>
  );
}

function MemberRow({ m, viewerParticipantId }: { m: GroupMemberView; viewerParticipantId: string | null }) {
  const state = balanceState(m.net);
  const stateColor = state === "owes-you" ? "var(--green)" : state === "you-owe" ? "var(--red)" : "var(--mut2)";
  const isOwnerRow = m.participantId === null;
  // Who this row addresses, and how — one place, unit-tested, mutation-tested.
  const { isSelf, label: stateLabel } = memberRowLabel(m.participantId, m.net, viewerParticipantId);
  // "Partial" — still outstanding despite past settlements (v2.0 P3, F4).
  const partial = !isSelf && balanceState(m.net) !== "settled" && m.hasSettlements;
  return (
    <div className="flex items-center gap-3 py-2 border-b border-line last:border-b-0">
      <span className="w-9 h-9 rounded-full grid place-items-center text-[13px] font-bold text-white flex-none" style={{ background: m.color }}>
        {m.initial}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-bold truncate flex items-center gap-1.5">
          {m.name}
          {isOwnerRow && <span className="text-mut2 font-semibold">· owner</span>}
          {isSelf && <span className="text-[9.5px] font-bold px-1.5 py-[1px] rounded-full bg-accsoft text-acc">YOU</span>}
          {partial && (
            <span className="text-[9.5px] font-bold px-1.5 py-[1px] rounded-full" style={{ background: "var(--amberSoft)", color: "var(--amber)" }}>
              PARTIAL
            </span>
          )}
        </div>
        <div className="text-[11px] text-mut2 tabular-nums">
          paid {formatPaise(m.paid)} · share {formatPaise(m.owes)} · {m.contributionPct}%
        </div>
      </div>
      <div className="text-right flex-none">
        <div className="text-[13px] font-extrabold tabular-nums" style={{ color: stateColor }}>
          {state === "settled" ? "—" : formatPaise(Math.abs(m.net))}
        </div>
        <div className="text-[10.5px] font-semibold" style={{ color: stateColor }}>
          {partial ? `partly settled · ${stateLabel}` : stateLabel}
        </div>
      </div>
    </div>
  );
}
