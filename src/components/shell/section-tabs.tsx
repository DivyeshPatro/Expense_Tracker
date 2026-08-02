"use client";

// Spends ↔ Insights: analytics is no longer a top-level destination — it's the
// "Insights" tab of the Spends section, sitting beside the transaction list.
// Rendered on both /transactions and /analytics so they read as one section
// with two views; the current period (p/from/to/month) is carried across.

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

const TABS = [
  { href: "/transactions", label: "Spends" },
  { href: "/analytics", label: "Insights" },
];

export function SpendInsightsTabs() {
  const path = usePathname();
  const qs = useSearchParams().toString();
  const q = qs ? `?${qs}` : "";
  return (
    <div className="inline-flex gap-1 bg-side border border-line2 rounded-[11px] p-1 self-start">
      {TABS.map((t) => {
        const active = path.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={`${t.href}${q}`}
            aria-current={active ? "page" : undefined}
            className="px-4 h-9 inline-flex items-center rounded-[8px] text-[12.5px] font-bold no-underline transition-colors"
            style={active ? { background: "var(--card)", color: "var(--ink)", boxShadow: "var(--sh)" } : { color: "var(--mut)" }}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
