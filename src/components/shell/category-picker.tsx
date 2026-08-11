"use client";

// Searchable category picker (v2.1 Spending 2.0 #38/#40/#41/#42). Replaces the
// plain <select> in the transaction forms: a field-styled trigger opens a
// BottomSheet with a search box, a "Recent" shortcut row (most-recently-picked,
// stored per-device), and the full category grid. Recent doubles as
// "frequently used" without any server query — the app layout is kept cheap.

import { useEffect, useMemo, useRef, useState } from "react";
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
  // Which result Enter will choose. Reset to the top on every keystroke, so
  // narrowing the list never leaves the highlight pointing at something the
  // user can no longer see.
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setRecentIds(readRecent(recentKey));
      setQ("");
      setActive(0);
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

  // Keep the highlighted result in view. On a phone the grid scrolls inside the
  // sheet, so without this the "active" row can sit below the fold even once
  // the sheet itself clears the keyboard.
  useEffect(() => {
    if (!query) return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, query]);

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length === 0) return;
      setActive((i) => (e.key === "ArrowDown" ? (i + 1) % filtered.length : (i - 1 + filtered.length) % filtered.length));
      return;
    }
    if (e.key === "Enter") {
      // The heart of the mobile fix: with the keyboard up and one match left,
      // the phone's Go/Done key selects it outright — no reaching past the
      // keyboard, no dismissing it first.
      e.preventDefault();
      const choice = filtered[active] ?? filtered[0];
      if (choice) pick(choice.id);
    }
  }

  const catBtn = (c: PickerCategory, chip = false, idx?: number) => {
    const isActive = query !== "" && idx === active;
    return (
      <button
        key={c.id}
        type="button"
        onClick={() => pick(c.id)}
        onMouseEnter={idx === undefined ? undefined : () => setActive(idx)}
        aria-pressed={c.id === value}
        data-active={isActive || undefined}
        className={
          chip
            ? "inline-flex items-center gap-1.5 px-2.5 h-8 rounded-full text-[12px] font-semibold cursor-pointer border border-line2 bg-card hover:bg-accsoft"
            : "flex items-center gap-2 px-3 min-h-[44px] rounded-[11px] text-[13px] font-semibold text-left cursor-pointer border border-line2 hover:bg-accsoft"
        }
        style={
          c.id === value
            ? { background: "var(--accSoft)", borderColor: "var(--acc)", color: "var(--acc)" }
            : isActive
              ? { borderColor: "var(--acc)", background: "var(--accSoft)" }
              : undefined
        }
      >
        <span className="text-[15px]">{c.icon}</span>
        <span className="truncate">{c.name}</span>
      </button>
    );
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="field flex items-center justify-between gap-2 text-left cursor-pointer">
        <span className="truncate">{selected ? `${selected.icon} ${selected.name}` : "Choose a category"}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--mut2)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
      </button>

      {open && (
        <BottomSheet onClose={() => setOpen(false)} label={label} maxWidth={480} className="gap-2" z={65}>
          {/* Sticky so the search box stays put while results scroll beneath
              it — on a phone the field is the one thing that must never leave
              the screen while typing. */}
          <div className="sticky top-0 z-10 bg-card pb-2 -mx-4 px-4">
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={onSearchKeyDown}
              placeholder="Search categories…"
              aria-label="Search categories"
              // "go" gives the phone keyboard a Go key instead of a newline,
              // which is what makes one-handed "type, Go, done" work.
              enterKeyHint="go"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              className="field"
            />
            {/* Announced, not just shown: a screen-reader user typing needs to
                know the list narrowed and what Enter will choose. */}
            <div role="status" aria-live="polite" className="sr-only">
              {query
                ? filtered.length === 0
                  ? `No categories match ${q}`
                  : `${filtered.length} ${filtered.length === 1 ? "category" : "categories"}, ${(filtered[active] ?? filtered[0]).name} selected`
                : ""}
            </div>
          </div>
          {!query && recent.length > 0 && (
            <>
              <div className="label-caps mt-1">Recent</div>
              <div className="flex flex-wrap gap-1.5">{recent.map((c) => catBtn(c, true))}</div>
            </>
          )}
          <div className="label-caps mt-1">
            {query ? (filtered.length === 1 ? "1 result — press Enter to choose" : "Results") : "All categories"}
          </div>
          {filtered.length === 0 ? (
            <div className="text-[12.5px] text-mut2 py-3 text-center">No categories match “{q}”.</div>
          ) : (
            <div ref={listRef} className="grid grid-cols-2 gap-1.5">
              {filtered.map((c, i) => catBtn(c, false, i))}
            </div>
          )}
        </BottomSheet>
      )}
    </>
  );
}
