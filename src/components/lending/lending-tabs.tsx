"use client";

// Lending module Phase 2, Priority 7 — same tab pattern as
// src/app/(app)/analytics/analytics-tabs.tsx: a picker on mobile (one
// section visible at a time), the full stack always visible on desktop
// (`contents` toggles layout only, nothing here unmounts or refetches).
// Keeps Phase 2's new Card Recovery / Reports content off the global nav —
// everything nests under the existing /lending route.

import { useState, type ReactNode } from "react";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "recovery", label: "Card Recovery" },
  { key: "reports", label: "Reports" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function LendingTabs({ overview, recovery, reports }: { overview: ReactNode; recovery: ReactNode; reports: ReactNode }) {
  const [tab, setTab] = useState<TabKey>("overview");
  const groups: Record<TabKey, ReactNode> = { overview, recovery, reports };

  return (
    <>
      <div className="md:hidden flex gap-1 bg-card border border-line rounded-[9px] p-[3px]">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            aria-pressed={tab === t.key}
            className="flex-1 px-3 py-1.5 rounded-[7px] text-xs font-semibold cursor-pointer border-none"
            style={{ background: tab === t.key ? "var(--acc)" : "transparent", color: tab === t.key ? "#fff" : "var(--mut)" }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-3.5">
        {TABS.map((t) => (
          <div key={t.key} className={tab === t.key ? "contents" : "hidden md:contents"}>
            {groups[t.key]}
          </div>
        ))}
      </div>
    </>
  );
}
