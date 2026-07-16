"use client";

// Groups the trend/breakdown/merchants sections behind a picker on mobile
// (audit finding: "long scroll... consider tabs to view one analysis at a
// time instead of one long stack") while keeping the full always-visible
// stack on desktop, where there's room for it — same server-rendered
// sections either way, this only toggles which are laid out at a given
// width via `contents` (the inactive ones stay in the DOM, just take no
// layout space, so nothing here needs conditional data-fetching or
// unmounting).

import { useState, type ReactNode } from "react";

const TABS = [
  { key: "trend", label: "Trend" },
  { key: "categories", label: "Categories" },
  { key: "merchants", label: "Merchants" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function AnalyticsTabs({ trend, categories, merchants }: { trend: ReactNode; categories: ReactNode; merchants: ReactNode }) {
  const [tab, setTab] = useState<TabKey>("trend");
  const groups: Record<TabKey, ReactNode> = { trend, categories, merchants };

  return (
    <>
      <div className="md:hidden flex gap-1 bg-card border border-line rounded-[9px] p-[3px]">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
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
