"use client";

// Searchable category picker (v2.1 Spending 2.0 #38/#40/#41/#42). Replaces the
// plain <select> in the transaction forms: a field-styled trigger opens a
// BottomSheet with a search box, a "Recent" shortcut row (most-recently-picked,
// stored per-device), and the full category grid. Recent doubles as
// "frequently used" without any server query — the app layout is kept cheap.

import { useEffect, useMemo, useState } from "react";
import { BottomSheet } from "./bottom-sheet";

export type PickerCategory = { id: string; name: string; icon: string };

const RECENT_CAP = 8;

function readRecent(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Record a pick so it surfaces in the Recent row next time. */
export function pushRecentCategory(key: string, id: string) {
  try {
    const next = [id, ...readRecent(key).filter((x) => x !== id)].slice(0, RECENT_CAP);
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // storage unavailable (private mode) — recent shortcuts just won't persist
  }
}

export function CategoryPicker({
  categories,
  value,
  onChange,
  recentKey,
  label = "Choose a category",
}: {
  categories: PickerCategory[];
  value: string;
  onChange: (id: string) => void;
  recentKey: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [recentIds, setRecentIds] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      setRecentIds(readRecent(recentKey));
      setQ("");
    }
  }, [open, recentKey]);

  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const selected = byId.get(value);
  const recent = recentIds.map((id) => byId.get(id)).filter((c): c is PickerCategory => !!c).slice(0, 6);
  const query = q.trim().toLowerCase();
  const filtered = query ? categories.filter((c) => c.name.toLowerCase().includes(query)) : categories;

  function pick(id: string) {
    onChange(id);
    pushRecentCategory(recentKey, id);
    setOpen(false);
  }

  const catBtn = (c: PickerCategory, chip = false) => (
    <button
      key={c.id}
      type="button"
      onClick={() => pick(c.id)}
      aria-pressed={c.id === value}
      className={
        chip
          ? "inline-flex items-center gap-1.5 px-2.5 h-8 rounded-full text-[12px] font-semibold cursor-pointer border border-line2 bg-card hover:bg-accsoft"
          : "flex items-center gap-2 px-3 min-h-[44px] rounded-[11px] text-[13px] font-semibold text-left cursor-pointer border border-line2 hover:bg-accsoft"
      }
      style={c.id === value ? { background: "var(--accSoft)", borderColor: "var(--acc)", color: "var(--acc)" } : undefined}
    >
      <span className="text-[15px]">{c.icon}</span>
      <span className="truncate">{c.name}</span>
    </button>
  );

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="field flex items-center justify-between gap-2 text-left cursor-pointer">
        <span className="truncate">{selected ? `${selected.icon} ${selected.name}` : "Choose a category"}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--mut2)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
      </button>

      {open && (
        <BottomSheet onClose={() => setOpen(false)} label={label} maxWidth={480} className="gap-2" z={65}>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search categories…"
            aria-label="Search categories"
            className="field"
          />
          {!query && recent.length > 0 && (
            <>
              <div className="label-caps mt-1">Recent</div>
              <div className="flex flex-wrap gap-1.5">{recent.map((c) => catBtn(c, true))}</div>
            </>
          )}
          <div className="label-caps mt-1">{query ? "Results" : "All categories"}</div>
          {filtered.length === 0 ? (
            <div className="text-[12.5px] text-mut2 py-3 text-center">No categories match “{q}”.</div>
          ) : (
            <div className="grid grid-cols-2 gap-1.5">{filtered.map((c) => catBtn(c))}</div>
          )}
        </BottomSheet>
      )}
    </>
  );
}
