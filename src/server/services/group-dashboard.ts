// Group Dashboard read model (v2.0). One group query, one expense query, one
// settlement query — no N+1 — turned into the dashboard's numbers by the pure
// functions in lib/group-dashboard. Balances/overview are all-time; spending
// (total, pie, trend) follows the selected period, mirroring the analytics page.

import { cache } from "react";
import { currentMonthKey, monthName, shiftMonthKey, toYMD } from "@/lib/dates";
import {
  computeGrossObligations,
  computeMemberBalances,
  computeOverview,
  computeSuggestions,
  groupCategoryTotals,
  groupMonthlyTrend,
  sumSpent,
  type CategorySlice,
  type GroupExpenseRow,
  type GrossObligation,
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
  /** The group owner's real display name.
   *
   *  Members carry theirs already; the owner has no participant row, so every
   *  view rendered them as the literal "You". That is fine on your own screen
   *  and useless in a group chat — the settlement plan is meant to be shared
   *  with people for whom "You" identifies nobody. */
  ownerName: string;
  /** Is the reader the person this group is filed under? Drives every
   *  "You" vs real-name decision on the page. */
  isViewerOwner: boolean;
  /** Whether this reader can actually record a settlement here — precomputed
   *  from the same rule recordSettlement() enforces, so the UI never offers an
   *  action the write path will reject. */
  canRecordSettlements: boolean;
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
  /** v2.1: each member's obligations kept un-netted, so "All payments" can
   *  show that someone both paid for something AND owes for something else.
   *  owesYou − youOwe === that member's net, by construction. */
  gross: (GrossObligation & { name: string })[];
  /** v2.1: the actual expenses behind `overview.totalExpenseSum`. The service
   *  already loaded these rows to compute the balances and then discarded
   *  them, so the page could show a total with no way to see what produced it.
   *  Newest first; the page renders them directly and opens the shared
   *  transaction sheet on tap. */
  expenses: GroupExpenseListRow[];
  /** Audit entity ids (this group's transactions + settlements) for the
   *  per-group ModuleActivity feed. */
  activityEntityIds: string[];
}

/** One row of a group's expense list — everything the list needs, resolved
 *  server-side so the client never has to join ids back to names. */
export interface GroupExpenseListRow {
  id: string;
  merchant: string;
  amount: number; // full expense, paise
  ymd: string;
  categoryName: string | null;
  icon: string;
  color: string;
  /** null ⇒ you paid. */
  paidByParticipantId: string | null;
  paidByName: string; // "You" or the member's display name
  /** Your own share of this expense, paise. */
  yourShare: number;
  /** How many people it was split between, including you. */
  splitCount: number;
}

/** A group as the Shared home lists it: enough to answer "what is this and
 *  where do I stand?" without opening it. */
export interface GroupSummary {
  id: string;
  name: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  /** Total people including you. */
  memberCount: number;
  memberNames: string[];
  expenseCount: number;
  totalSpent: number;
  youAreOwed: number;
  youOwe: number;
  youNet: number;
  /** YMD of the most recent expense or settlement, null when the group is empty. */
  lastActivity: string | null;
  /** Nothing outstanding either way. */
  settled: boolean;
}

/**
 * v2.1 — every group the user can see, with its standing, for the Shared home.
 *
 * Shared used to lead with a flat list of every shared expense, which is not
 * how anyone thinks about them: expenses belong to a trip, a flat, a lunch.
 * Groups are the primary object now, so this exists to make one scannable.
 *
 * Deliberately two queries for ALL groups rather than calling groupDashboard()
 * per group (that would be 2N queries plus N period computations). The balances
 * come from computeMemberBalances — the same tested function the group page
 * uses — so there is exactly one implementation of group balance maths.
 */
export const listGroupSummaries = cache(async (userId: string): Promise<GroupSummary[]> => {
  const groups = await prisma.group.findMany({
    where: { OR: [{ createdById: userId }, { members: { some: { participant: { linkedUserId: userId } } } }] },
    include: { members: { include: { participant: { select: { displayName: true, linkedUserId: true } } } } },
    // Only a stable tiebreak — the real ordering is applied after the balances
    // are known, below.
    orderBy: { createdAt: "desc" },
  });
  if (groups.length === 0) return [];
  const ids = groups.map((g) => g.id);

  const [txs, settlements] = await Promise.all([
    prisma.transaction.findMany({
      where: { groupId: { in: ids }, type: "EXPENSE", deletedAt: null },
      select: { id: true, groupId: true, amount: true, occurredAt: true, paidByParticipantId: true, splits: { select: { participantId: true, owedAmount: true } } },
    }),
    // Scoped by group, NOT by viewer — a group's settlements are part of the
    // group's state, exactly like its expenses on the line above. Filtering by
    // userId meant a linked member saw every expense but none of the owner's
    // settlements, so their balances (and settlement plan) silently drifted
    // once anyone had paid anyone back.
    //
    // Safe because recordSettlement() only ever attaches a groupId when the
    // caller owns that group, so every group-scoped row already belongs to
    // group.createdById. `ids` is itself the authorized set, so this cannot
    // widen visibility. General (groupId: null) settlements stay user-scoped
    // in netBalances(), where they belong.
    prisma.settlement.findMany({
      where: { groupId: { in: ids } },
      select: { id: true, groupId: true, participantId: true, direction: true, amount: true, settledAt: true },
    }),
  ]);

  const txByGroup = new Map<string, typeof txs>();
  for (const t of txs) {
    if (!t.groupId) continue;
    (txByGroup.get(t.groupId) ?? txByGroup.set(t.groupId, []).get(t.groupId)!).push(t);
  }
  const setByGroup = new Map<string, typeof settlements>();
  for (const s of settlements) {
    if (!s.groupId) continue;
    (setByGroup.get(s.groupId) ?? setByGroup.set(s.groupId, []).get(s.groupId)!).push(s);
  }

  const summaries = groups.map((g) => {
    const rows = txByGroup.get(g.id) ?? [];
    const sets = setByGroup.get(g.id) ?? [];
    const expenses: GroupExpenseRow[] = rows.map((t) => ({
      id: t.id,
      amount: Number(t.amount),
      ymd: toYMD(t.occurredAt),
      paidByParticipantId: t.paidByParticipantId,
      categoryId: null,
      category: null,
      icon: "📦",
      color: "var(--acc)",
      splits: t.splits.map((s) => ({ participantId: s.participantId, owedAmount: Number(s.owedAmount) })),
    }));
    const settleRows: GroupSettlementRow[] = sets.map((s) => ({
      id: s.id,
      participantId: s.participantId,
      direction: s.direction,
      amount: Number(s.amount),
      settledAt: s.settledAt.toISOString(),
    }));
    const { youNet, youAreOwed, youOwe, totalSpend } = computeMemberBalances(
      expenses,
      settleRows,
      g.members.map((m) => m.participantId)
    );
    const overview = computeOverview(expenses, settleRows);
    return {
      id: g.id,
      name: g.name,
      role: (g.createdById === userId ? "OWNER" : (g.members.find((m) => m.participant.linkedUserId === userId)?.role ?? "MEMBER")) as GroupSummary["role"],
      memberCount: g.members.length + 1, // + you
      memberNames: g.members.map((m) => m.participant.displayName),
      expenseCount: rows.length,
      totalSpent: totalSpend,
      youAreOwed,
      youOwe,
      youNet,
      lastActivity: overview.lastActivity,
      settled: youAreOwed === 0 && youOwe === 0,
    };
  });

  // Ordered by what the user is scanning for, not by when the group was made.
  // Creation order put a settled or empty group — nothing to act on — above a
  // trip with money outstanding, which defeats the point of leading with
  // groups. Anything still owed comes first, then the most recently active.
  return summaries.sort((a, b) => {
    if (a.settled !== b.settled) return a.settled ? 1 : -1;
    const al = a.lastActivity ?? "";
    const bl = b.lastActivity ?? "";
    if (al !== bl) return bl.localeCompare(al); // most recent first; never-used groups last
    // lastActivity is day-granular, so same-day groups tie constantly — falling
    // straight to alphabetical would effectively make the name the sort key.
    // Break by how much is outstanding instead: more at stake, higher up.
    const outstanding = Math.abs(b.youNet) - Math.abs(a.youNet);
    if (outstanding !== 0) return outstanding;
    return a.name.localeCompare(b.name);
  });
});

/** Returns null when the group doesn't exist or the user can't see it — the page
 *  turns that into notFound(). Same visibility rule as listGroups(). */
export async function groupDashboard(userId: string, groupId: string, period: Period): Promise<GroupDashboardData | null> {
  const group = await prisma.group.findFirst({
    where: { id: groupId, OR: [{ createdById: userId }, { members: { some: { participant: { linkedUserId: userId } } } }] },
    include: { members: { include: { participant: true } } },
  });
  if (!group) return null;

  // Is the person reading this the one the group is filed under? Computed once
  // and reused for every "You"-vs-real-name decision below, so there is a
  // single definition of owner identity on this page.
  //
  // `paidByParticipantId: null` and the leading balance row both mean the group
  // CREATOR, not the reader. Rendering them as "You" unconditionally told a
  // member that the owner's expenses and balance were their own.
  const isViewerOwner = group.createdById === userId;

  const [txs, settlements, owner] = await Promise.all([
    prisma.transaction.findMany({
      where: { groupId, type: "EXPENSE", deletedAt: null },
      select: {
        id: true,
        amount: true,
        merchant: true,
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
    //
    // Scoped by group, NOT by viewer, for the same reason the expense query
    // above is: a settlement is part of the group's state, and the whole point
    // of the settlement plan is that every member sees the same one. With a
    // userId filter here, a linked member saw all the expenses but none of the
    // owner's settlements, so their plan still demanded money that had already
    // been paid. recordSettlement() only attaches a groupId for a group the
    // caller owns, so every row here already belongs to group.createdById; the
    // group itself was authorized above, so this cannot widen visibility.
    prisma.settlement.findMany({
      where: { groupId },
      include: { participant: { select: { displayName: true } } },
      orderBy: { settledAt: "desc" },
    }),
    // The GROUP OWNER, not the viewer: `paidByParticipantId: null` always means
    // the person who created the group, so on a shared group opened by another
    // member this must still name them. Keying it off the viewer would label
    // the owner's payments with the reader's own name.
    prisma.user.findUnique({ where: { id: group.createdById }, select: { name: true } }),
  ]);

  // Falls back to "Owner" rather than "You": this name is read by other members
  // and pasted into group chats, where "You" identifies nobody.
  const ownerName = owner?.name?.trim() || "Owner";

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
  const grossRows = computeGrossObligations(expenses, settleRows, memberIds);

  // attach display meta; the owner ("You") card leads
  const meta = new Map(
    group.members.map((m) => [
      m.participantId,
      { name: m.participant.displayName, initial: m.participant.displayName.charAt(0).toUpperCase(), color: m.participant.color ?? "#6d5ae6", role: m.role },
    ])
  );
  const members: GroupMemberView[] = balances.map((b) => {
    // The owner's own row. "You" only when the reader IS them — otherwise this
    // is another person and gets their real name, same rule the transaction
    // detail sheet uses (`isOwner ? "You" : ownerName`).
    if (b.participantId === null) {
      return {
        ...b,
        name: isViewerOwner ? "You" : ownerName,
        initial: (isViewerOwner ? "Y" : ownerName.charAt(0)).toUpperCase(),
        color: "var(--acc)",
        role: "OWNER" as const,
        hasSettlements: false,
      };
    }
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

  // Only the group's owner can record a settlement against it: recordSettlement
  // requires the participant to be the caller's own contact and the group to be
  // one they created. This mirrors that rule instead of inventing a second one,
  // so the UI can't offer an action the write path will reject.
  const canRecordSettlements = isViewerOwner;

  // Optimal payment plan from the same member balances (single source of truth).
  // You-involved rows carry the exact settle prefill (incl. the live-preview net).
  const netByPid = new Map(members.map((m) => [m.participantId, m.net]));
  const suggestions: GroupSuggestion[] = computeSuggestions(members.map((m) => ({ participantId: m.participantId, net: m.net, name: m.name }))).map((s) => {
    // No prefill for someone who cannot record the settlement anyway —
    // recordSettlement() requires the participant to be the caller's own
    // contact AND the group to be theirs, so for a member this would only ever
    // produce an error. Withholding it here (rather than hiding a button in the
    // client) keeps the capability decision on the server, matching how
    // getTransactionDetail computes canEditFields/canDelete.
    if (!s.involvesYou || !canRecordSettlements) return s;
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

  // v2.1: the expense list. Names are resolved here from the member roster
  // already in memory — a member who has since left still renders, using the
  // same "(left group)" wording the balances use, so an expense never shows a
  // blank payer.
  const nameOf = (pid: string | null) =>
    // Same owner-identity rule as the balances: a null payer is the group's
    // creator, so it only reads "You paid" when the reader is that person.
    pid === null
      ? (isViewerOwner ? "You" : ownerName)
      : (group.members.find((m) => m.participantId === pid)?.participant.displayName ?? "(left group)");
  const expenseList: GroupExpenseListRow[] = txs.map((t) => ({
    id: t.id,
    merchant: t.merchant,
    amount: Number(t.amount),
    ymd: toYMD(t.occurredAt),
    categoryName: t.category?.name ?? null,
    icon: t.category?.icon ?? "📦",
    color: t.category?.color ?? "var(--acc)",
    paidByParticipantId: t.paidByParticipantId,
    paidByName: nameOf(t.paidByParticipantId),
    yourShare: Number(t.splits.find((s) => s.participantId === null)?.owedAmount ?? 0),
    splitCount: t.splits.length,
  }));

  // period filter for the spending charts
  const inPeriod = (ymd: string) =>
    period.mode === "all" ? true : period.mode === "month" ? ymd.startsWith(period.periodKey) : ymd >= period.from && ymd <= period.to;
  const periodExpenses = expenses.filter((e) => inPeriod(e.ymd));

  const endMonth = period.mode === "month" ? period.periodKey : currentMonthKey();
  const monthKeys = Array.from({ length: TREND_MONTHS }, (_, i) => shiftMonthKey(endMonth, i - (TREND_MONTHS - 1)));
  const trend = groupMonthlyTrend(expenses, monthKeys).map((t) => ({ ...t, label: monthName(t.key) }));

  const role = isViewerOwner ? "OWNER" : (meta.get(group.members.find((m) => m.participant.linkedUserId === userId)?.participantId ?? "")?.role ?? "MEMBER");

  return {
    id: group.id,
    name: group.name,
    createdAt: group.createdAt.toISOString(),
    role,
    // Falls back to "You" only if the account somehow has no name, so the plan
    // still renders rather than showing an empty arrow target.
    ownerName,
    isViewerOwner,
    canRecordSettlements,
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
    gross: grossRows.map((gr) => ({ ...gr, name: nameOf(gr.participantId) })),
    expenses: expenseList,
    // group id itself so membership events (audited with entityId = groupId)
    // join the feed alongside this group's transactions + settlements.
    activityEntityIds: [group.id, ...txs.map((t) => t.id), ...settlements.map((s) => s.id)],
  };
}
