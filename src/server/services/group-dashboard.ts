// Group Dashboard read model (v2.0). One group query, one expense query, one
// settlement query — no N+1 — turned into the dashboard's numbers by the pure
// functions in lib/group-dashboard. Balances/overview are all-time; spending
// (total, pie, trend) follows the selected period, mirroring the analytics page.

import { currentMonthKey, monthName, shiftMonthKey, toYMD } from "@/lib/dates";
import {
  computeMemberBalances,
  computeOverview,
  computeSuggestions,
  groupCategoryTotals,
  groupMonthlyTrend,
  sumSpent,
  type CategorySlice,
  type GroupExpenseRow,
  type GroupSettlementRow,
  type MemberBalance,
  type SettlementSuggestion,
} from "@/lib/group-dashboard";
import type { Period } from "@/lib/period";
import { prisma } from "../db";

const TREND_MONTHS = 6;

export interface GroupMemberView extends MemberBalance {
  name: string;
  initial: string;
  color: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  /** Has at least one recorded settlement — drives the "Partial" status when a
   *  balance remains outstanding despite past settlements. */
  hasSettlements: boolean;
}

/** A suggestion plus, for the You-involved ones, the exact prefill the settle
 *  modal needs — so the client stays dumb and there's one settle flow. */
export interface GroupSuggestion extends SettlementSuggestion {
  settle?: { participantId: string; participantName: string; direction: "TO_OWNER" | "FROM_OWNER"; amountRupees: string; netPaise: number };
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
  /** Optimal payment plan (fewest transfers) from the same balances. */
  suggestions: GroupSuggestion[];
  spending: {
    totalSpent: number;
    categories: CategorySlice[];
    trend: { key: string; label: string; total: number }[];
  };
  settlements: { id: string; participantName: string; direction: "TO_OWNER" | "FROM_OWNER"; amount: number; method: string; note: string | null; settledAt: string }[];
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
    // Only settlements attributed to THIS group — a settlement recorded for
    // another group (or a general shared-page one) never leaks in, even when
    // the same friend is a member of both.
    prisma.settlement.findMany({
      where: { userId, groupId },
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
  const settledPids = new Set(settleRows.map((s) => s.participantId));

  // attach display meta; the owner ("You") card leads
  const meta = new Map(
    group.members.map((m) => [
      m.participantId,
      { name: m.participant.displayName, initial: m.participant.displayName.charAt(0).toUpperCase(), color: m.participant.color ?? "#6d5ae6", role: m.role },
    ])
  );
  const members: GroupMemberView[] = balances.map((b) => {
    if (b.participantId === null) return { ...b, name: "You", initial: "Y", color: "var(--acc)", role: "OWNER" as const, hasSettlements: false };
    const m = meta.get(b.participantId);
    return {
      ...b,
      name: m?.name ?? "(left group)",
      initial: m?.initial ?? "?",
      color: m?.color ?? "#94a3b8",
      role: m?.role ?? "MEMBER",
      hasSettlements: settledPids.has(b.participantId),
    };
  });

  // Optimal payment plan from the same member balances (single source of truth).
  // You-involved rows carry the exact settle prefill (incl. the live-preview net).
  const netByPid = new Map(members.map((m) => [m.participantId, m.net]));
  const suggestions: GroupSuggestion[] = computeSuggestions(members.map((m) => ({ participantId: m.participantId, net: m.net, name: m.name }))).map((s) => {
    if (!s.involvesYou) return s;
    const youPay = s.fromId === "me";
    const participantId = youPay ? s.toId : s.fromId;
    const participantName = youPay ? s.toName : s.fromName;
    return {
      ...s,
      settle: {
        participantId,
        participantName,
        direction: youPay ? "FROM_OWNER" : "TO_OWNER",
        amountRupees: String(Math.round(s.amount / 100)),
        netPaise: netByPid.get(participantId) ?? 0,
      },
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
    suggestions,
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
      note: s.note,
      settledAt: s.settledAt.toISOString(),
    })),
    activityEntityIds: [...txs.map((t) => t.id), ...settlements.map((s) => s.id)],
  };
}
