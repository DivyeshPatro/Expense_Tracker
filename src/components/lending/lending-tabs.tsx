"use client";

// Lending sub-navigation (same pattern as analytics-tabs): a segmented picker on
// mobile (one section at a time), the full stack on desktop (`contents` toggles
// layout only — nothing unmounts or refetches). Card Recovery was retired as a
// user-facing tab (v2.0 UX polish); the tabs are now the three things people
// actually come to Lending for.

import { useState, type ReactNode } from "react";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "reports", label: "Reports" },
  { key: "activity", label: "Activity" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function LendingTabs({ overview, reports, activity }: { overview: ReactNode; reports: ReactNode; activity: ReactNode }) {
  const [tab, setTab] = useState<TabKey>("overview");
  const groups: Record<TabKey, ReactNode> = { overview, reports, activity };

  return (
    <>
      <div className="md:hidden flex gap-1 bg-card border border-line rounded-[9px] p-[3px]" role="tablist" aria-label="Lending sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            onClick={() => setTab(t.key)}
            aria-selected={tab === t.key}
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
