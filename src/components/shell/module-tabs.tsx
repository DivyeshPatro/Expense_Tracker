"use client";

// The one module-level tab control.
//
// Replaces SpendInsightsTabs, which only knew about Spending↔Insights. Every
// module that has more than one view now uses this: route-based (not client
// state), so each view is deep-linkable, gets its own loading.tsx skeleton, and
// only runs its queries when you actually open it.
//
// Why this exists: the per-module "Audit log" was a card at the BOTTOM of each
// module page. On Spending — the longest list in the app — that put it below
// every transaction, so switching Expenses/Income/Transfers pushed it further
// out of reach and most people would never scroll to it. Lending already solved
// this with an "Activity log" tab; this generalises that idea to the rest
// rather than leaving one module different from the others.
//
// Lending keeps its own LendingTabs (Overview/Reports/Activity log) — it already
// had the pattern, so it is deliberately untouched.

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useStartNavProgress } from "./nav-progress";

export interface ModuleTab {
  href: string;
  label: string;
  /** Match on exact pathname rather than prefix — needed when one tab's href
   *  is a prefix of another's (e.g. /transactions vs /transactions/activity). */
  exact?: boolean;
}

export function ModuleTabs({ tabs }: { tabs: ModuleTab[] }) {
  const path = usePathname();
  const qs = useSearchParams().toString();
  const startNav = useStartNavProgress();
  const q = qs ? `?${qs}` : "";

  return (
    <div className="inline-flex gap-1 bg-side border border-line2 rounded-[11px] p-1 self-start max-w-full overflow-x-auto no-scrollbar" role="navigation" aria-label="Section views">
      {tabs.map((t) => {
        const active = t.exact ? path === t.href : path === t.href || path.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={`${t.href}${q}`}
            onClick={startNav}
            aria-current={active ? "page" : undefined}
            className="px-4 min-h-[44px] inline-flex items-center rounded-[8px] text-[12.5px] font-bold no-underline whitespace-nowrap transition-colors"
            style={active ? { background: "var(--card)", color: "var(--ink)", boxShadow: "var(--sh)" } : { color: "var(--mut)" }}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}

// ── per-module tab sets ──────────────────────────────────────────────────
// Labels match NAV_ITEMS exactly (issue #201: one name per destination). The
// old control said "Spends" while the app bar above it said "Spending".

export const SPENDING_TABS: ModuleTab[] = [
  { href: "/transactions", label: "Spending", exact: true },
  { href: "/analytics", label: "Insights" },
  { href: "/transactions/activity", label: "Activity" },
];

export const BILLS_TABS: ModuleTab[] = [
  { href: "/bills", label: "Bills", exact: true },
  { href: "/bills/activity", label: "Activity" },
];

export const BUDGETS_TABS: ModuleTab[] = [
  { href: "/budgets", label: "Budgets", exact: true },
  { href: "/budgets/activity", label: "Activity" },
];

export const CARDS_TABS: ModuleTab[] = [
  { href: "/cards", label: "Wallet", exact: true },
  { href: "/cards/activity", label: "Activity" },
];

export const SHARED_TABS: ModuleTab[] = [
  { href: "/shared", label: "Shared", exact: true },
  { href: "/shared/activity", label: "Activity" },
];
