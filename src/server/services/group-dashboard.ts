// Group Dashboard read model (v2.0). One group query, one expense query, one
// settlement query — no N+1 — turned into the dashboard's numbers by the pure
// functions in lib/group-dashboard. Balances/overview are all-time; spending
// (total, pie, trend) follows the selected period, mirroring the analytics page.

import { currentMonthKey, monthName, shiftMonthKey, toYMD } from "@/lib/dates";
import {
  computeMemberBalances,
  computeOverview,
  groupCategoryTotals,
  groupMonthlyTrend,
  sumSpent,
  type CategorySlice,
  type GroupExpenseRow,
  type GroupSettlementRow,
  type MemberBalance,
} from "@/lib/group-dashboard";
import type { Period } from "@/lib/period";
import { prisma } from "../db";

const TREND_MONTHS = 6;

export interface GroupMemberView extends MemberBalance {
  name: string;
  initial: string;
  color: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
}

export interface GroupDashboardData {
  id: string;
  name: string;
  createdAt: string; // ISO
  role: "OWNER" | "ADMIN" | "MEMBER";
  memberCount: number; // excludes You
  overview: ReturnType<typeof computeOverview>;
  youNet: number;
  youAreOwed: number;
  youOwe: number;
  members: GroupMemberView[];
  spending: {
    totalSpent: number;
    categories: CategorySlice[];
    trend: { key: string; label: string; total: number }[];
  };
  settlements: { id: string; participantName: string; direction: "TO_OWNER" | "FROM_OWNER"; amount: number; method: string; settledAt: string }[];
  /** Audit entity ids (this group's transactions + settlements) for the
   *  per-group ModuleActivity feed. */
  activityEntityIds: string[];
}

/** Returns null when the group doesn't exist or the user can't see it — the page
 *  turns that into notFound(). Same visibility rule as listGroups(). */
export async function groupDashboard(userId: string, groupId: string, period: Period): Promise<GroupDashboardData | null> {
  const group = await prisma.group.findFirst({
    where: { id: groupId, OR: [{ createdById: userId }, { members: { some: { participant: { linkedUserId: userId } } } }] },
    include: { members: { include: { participant: true } } },
  });
  if (!group) return null;

  const [txs, settlements] = await Promise.all([
    prisma.transaction.findMany({
      where: { groupId, type: "EXPENSE", deletedAt: null },
      select: {
        id: true,
        amount: true,
        occurredAt: true,
        paidByParticipantId: true,
        categoryId: true,
        category: { select: { name: true, icon: true, color: true } },
        splits: { select: { participantId: true, owedAmount: true } },
      },
      orderBy: { occurredAt: "desc" },
    }),
    prisma.settlement.findMany({
      where: { userId, participant: { groupMembers: { some: { groupId } } } },
      include: { participant: { select: { displayName: true } } },
      orderBy: { settledAt: "desc" },
    }),
  ]);

  const expenses: GroupExpenseRow[] = txs.map((t) => ({
    id: t.id,
    amount: Number(t.amount),
    ymd: toYMD(t.occurredAt),
    paidByParticipantId: t.paidByParticipantId,
    categoryId: t.categoryId,
    category: t.category?.name ?? null,
    icon: t.category?.icon ?? "📦",
    color: t.category?.color ?? "var(--acc)",
    splits: t.splits.map((s) => ({ participantId: s.participantId, owedAmount: Number(s.owedAmount) })),
  }));
  const settleRows: GroupSettlementRow[] = settlements.map((s) => ({
    id: s.id,
    participantId: s.participantId,
    direction: s.direction,
    amount: Number(s.amount),
    settledAt: s.settledAt.toISOString(),
  }));

  const memberIds = group.members.map((m) => m.participantId);
  const { members: balances, youNet, youAreOwed, youOwe } = computeMemberBalances(expenses, settleRows, memberIds);

  // attach display meta; the owner ("You") card leads
  const meta = new Map(
    group.members.map((m) => [
      m.participantId,
      { name: m.participant.displayName, initial: m.participant.displayName.charAt(0).toUpperCase(), color: m.participant.color ?? "#6d5ae6", role: m.role },
    ])
  );
  const members: GroupMemberView[] = balances.map((b) => {
    if (b.participantId === null) return { ...b, name: "You", initial: "Y", color: "var(--acc)", role: "OWNER" as const };
    const m = meta.get(b.participantId);
    return {
      ...b,
      name: m?.name ?? "(left group)",
      initial: m?.initial ?? "?",
      color: m?.color ?? "#94a3b8",
      role: m?.role ?? "MEMBER",
    };
  });

  // period filter for the spending charts
  const inPeriod = (ymd: string) =>
    period.mode === "all" ? true : period.mode === "month" ? ymd.startsWith(period.periodKey) : ymd >= period.from && ymd <= period.to;
  const periodExpenses = expenses.filter((e) => inPeriod(e.ymd));

  const endMonth = period.mode === "month" ? period.periodKey : currentMonthKey();
  const monthKeys = Array.from({ length: TREND_MONTHS }, (_, i) => shiftMonthKey(endMonth, i - (TREND_MONTHS - 1)));
  const trend = groupMonthlyTrend(expenses, monthKeys).map((t) => ({ ...t, label: monthName(t.key) }));

  const role = group.createdById === userId ? "OWNER" : (meta.get(group.members.find((m) => m.participant.linkedUserId === userId)?.participantId ?? "")?.role ?? "MEMBER");

  return {
    id: group.id,
    name: group.name,
    createdAt: group.createdAt.toISOString(),
    role,
    memberCount: group.members.length,
    overview: computeOverview(expenses, settleRows),
    youNet,
    youAreOwed,
    youOwe,
    members,
    spending: {
      totalSpent: sumSpent(periodExpenses),
      categories: groupCategoryTotals(periodExpenses),
      trend,
    },
    settlements: settlements.map((s) => ({
      id: s.id,
      participantName: s.participant.displayName,
      direction: s.direction,
      amount: Number(s.amount),
      method: s.method,
      settledAt: s.settledAt.toISOString(),
    })),
    activityEntityIds: [...txs.map((t) => t.id), ...settlements.map((s) => s.id)],
  };
}
