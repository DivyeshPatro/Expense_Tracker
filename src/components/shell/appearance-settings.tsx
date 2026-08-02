"use client";

// Settings → Appearance: pick a mode (System / Light / Dark) and an accent skin.
// Applies live to <html> and remembers the choice in cookies (so it paints with
// no flash next load). Reads the current state off <html>'s data-* on mount, so
// it always reflects whatever the header toggle or a previous visit left.

import { useEffect, useState } from "react";
import { applyAppearance, DEFAULT_MODE, DEFAULT_SKIN, isMode, isSkin, SKINS, type ThemeMode } from "@/lib/theme";

const MODES: { id: ThemeMode; label: string; icon: string }[] = [
  { id: "system", label: "System", icon: "◐" },
  { id: "light", label: "Light", icon: "☀" },
  { id: "dark", label: "Dark", icon: "☾" },
];

export function Appearance() {
  const [mode, setMode] = useState<ThemeMode>(DEFAULT_MODE);
  const [skin, setSkin] = useState<string>(DEFAULT_SKIN);

  useEffect(() => {
    const el = document.documentElement;
    setMode(isMode(el.dataset.mode) ? el.dataset.mode : DEFAULT_MODE);
    setSkin(isSkin(el.dataset.skin) ? el.dataset.skin! : DEFAULT_SKIN);
  }, []);

  function pickMode(m: ThemeMode) {
    setMode(m);
    applyAppearance(m, skin);
  }
  function pickSkin(s: string) {
    setSkin(s);
    applyAppearance(mode, s);
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-[11px] font-bold text-mut2 tracking-[.06em] uppercase mb-2">Mode</div>
        <div className="inline-flex p-1 rounded-[12px] bg-side border border-line2 gap-1" role="group" aria-label="Theme mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => pickMode(m.id)}
              aria-pressed={mode === m.id}
              className={`h-11 min-w-[92px] px-3 rounded-[9px] text-[12.5px] font-semibold cursor-pointer inline-flex items-center justify-center gap-2 transition-colors ${
                mode === m.id ? "bg-card text-ink shadow-sm border border-line2" : "text-mut border border-transparent hover:text-ink"
              }`}
            >
              <span aria-hidden>{m.icon}</span>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-[11px] font-bold text-mut2 tracking-[.06em] uppercase mb-2">Accent</div>
        <div className="flex gap-3 flex-wrap">
          {SKINS.map((s) => {
            const active = skin === s.id;
            return (
              <button
                key={s.id}
                onClick={() => pickSkin(s.id)}
                aria-pressed={active}
                aria-label={s.label}
                title={s.label}
                className="w-11 h-11 rounded-full cursor-pointer grid place-items-center transition-transform"
                style={{
                  background: s.swatch,
                  boxShadow: active ? "0 0 0 2px var(--card), 0 0 0 4px var(--acc)" : "0 0 0 1px var(--line2)",
                }}
              >
                {active && (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
