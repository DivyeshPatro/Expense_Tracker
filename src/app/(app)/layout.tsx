import { AppShell } from "@/components/shell/app-shell";
import type { RefData } from "@/components/shell/ui-context";
import { prisma } from "@/server/db";
import { netBalances } from "@/server/services/shared";
import { requireUser } from "@/server/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  // Kept intentionally cheap — this runs on every navigation (App Router
  // re-invokes layouts per request). Merchant suggestions for the palette are
  // fetched on demand instead of pre-loading (a full merchant ranking scans
  // every transaction, which gets slower as import history grows).
  const [accounts, categories, participants, nets] = await Promise.all([
    prisma.account.findMany({ where: { userId: user.id, isArchived: false }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, icon: true } }),
    prisma.category.findMany({ where: { userId: user.id, parentId: null }, orderBy: { name: "asc" }, select: { id: true, name: true, kind: true, icon: true } }),
    prisma.participant.findMany({ where: { ownerId: user.id }, orderBy: { displayName: "asc" } }),
    netBalances(user.id),
  ]);

  const refData: RefData = {
    userName: user.name,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, icon: a.icon ?? "🏦" })),
    expenseCategories: categories.filter((c) => c.kind === "EXPENSE").map((c) => ({ id: c.id, name: c.name, icon: c.icon ?? "📦" })),
    incomeCategories: categories.filter((c) => c.kind === "INCOME").map((c) => ({ id: c.id, name: c.name, icon: c.icon ?? "💼" })),
    participants: participants.map((p) => ({ id: p.id, name: p.displayName, initial: p.displayName.charAt(0).toUpperCase(), color: p.color ?? "#6d5ae6" })),
  };
  const badge = nets.filter((n) => Math.abs(n.net) > 100).length;

  return (
    <AppShell refData={refData} badge={badge}>
      {children}
    </AppShell>
  );
}
