import { AppShell } from "@/components/shell/app-shell";
import type { RefData } from "@/components/shell/ui-context";
import { listAccountRows } from "@/server/services/accounts";
import { listCategories } from "@/server/services/categories";
import { listGroups } from "@/server/services/groups";
import { netBalances, listParticipantsWithUsage } from "@/server/services/shared";
import { unreadCount } from "@/server/services/notifications";
import { requireUser } from "@/server/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  // Kept intentionally cheap — this runs on every navigation (App Router
  // re-invokes layouts per request). Merchant suggestions for the palette are
  // fetched on demand instead of pre-loading (a full merchant ranking scans
  // every transaction, which gets slower as import history grows).
  //
  // accounts/categories/participants are each cache()-wrapped in their service
  // module: when the page below (e.g. Dashboard) needs the same list, it calls
  // the same function and React dedupes the fetch instead of hitting Postgres
  // twice for one request.
  const [accounts, categories, participants, groups, nets, notifBadge] = await Promise.all([
    listAccountRows(user.id),
    listCategories(user.id),
    listParticipantsWithUsage(user.id),
    listGroups(user.id),
    netBalances(user.id),
    unreadCount(user.id),
  ]);

  const refData: RefData = {
    userName: user.name,
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      icon: a.icon ?? "🏦",
      type: a.type,
      cardNetwork: a.cardNetwork,
      cardLast4: a.cardLast4,
      statementDay: a.statementDay,
      dueDay: a.dueDay,
    })),
    expenseCategories: categories.filter((c) => c.kind === "EXPENSE").map((c) => ({ id: c.id, name: c.name, icon: c.icon ?? "📦" })),
    incomeCategories: categories.filter((c) => c.kind === "INCOME").map((c) => ({ id: c.id, name: c.name, icon: c.icon ?? "💼" })),
    participants: participants.map((p) => ({
      id: p.id,
      name: p.displayName,
      initial: p.displayName.charAt(0).toUpperCase(),
      color: p.color ?? "#6d5ae6",
      phone: p.phone ?? null,
      // #69: a contact with loan entries but no shared activity is Lending-only
      // — hidden from Shared's split picker, still shown in the Lending flow.
      lendingOnly: p._count.loanEntries > 0 && p._count.splits === 0 && p._count.groupMembers === 0 && p._count.settlements === 0,
      // Has a lending relationship — drives the "Lending contact" badge in the
      // group member picker (v2.0), independent of whether they're also Shared.
      isLending: p._count.loanEntries > 0,
    })),
    // collaboration-architecture-rfc §2/§4 (migration step 4): every group
    // the user can create INTO — owned or joined, any role (MEMBER is the
    // floor for creating), populated by the same listGroups() already
    // extended in the authorization foundation (migration step 3)
    groups: groups.map((g) => ({ id: g.id, name: g.name, role: g.role, memberIds: g.members.map((m) => m.participantId) })),
  };
  const badge = nets.filter((n) => Math.abs(n.net) > 100).length;

  return (
    <AppShell refData={refData} badge={badge} notifBadge={notifBadge} userId={user.id}>
      {children}
    </AppShell>
  );
}
