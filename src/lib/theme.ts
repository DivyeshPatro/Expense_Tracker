// Appearance: a two-axis theme system.
//
//   mode  — system | light | dark   (which ground)
//   skin  — an accent family         (which brand hue)
//
// The app is fully token-driven (globals.css), so a skin overrides only --acc;
// --accSoft/--accSoft2 and every Tailwind `*-acc` utility resolve var(--acc) at
// use-time and follow automatically. Grounds (bg/card/ink) are untouched by
// skins — dark mode already is the "cockpit" palette.
//
// State lives on <html> as data-theme (the concrete light|dark the CSS reads),
// data-mode (the user's choice, so we know whether to track the OS), and
// data-skin. Both choices persist in cookies so the server paints them with no
// flash (see the inline bootstrap in app/layout.tsx).

export type ThemeMode = "system" | "light" | "dark";

export const MODE_COOKIE = "ledgerly-theme";
export const SKIN_COOKIE = "ledgerly-skin";

export const DEFAULT_MODE: ThemeMode = "system";
export const DEFAULT_SKIN = "indigo";

export interface Skin {
  id: string;
  label: string;
  /** Light-mode swatch, for the picker chip. */
  swatch: string;
}

/** Accent families. Deliberately distinct from the green/red/amber status
 *  colours, which stay fixed so state always reads the same across skins. */
export const SKINS: Skin[] = [
  { id: "indigo", label: "Indigo", swatch: "#2a63f6" },
  { id: "violet", label: "Violet", swatch: "#7c5cff" },
  { id: "teal", label: "Teal", swatch: "#0fb3a4" },
  { id: "rose", label: "Rose", swatch: "#f2547d" },
  { id: "slate", label: "Slate", swatch: "#5b6b83" },
];

export function isMode(v: unknown): v is ThemeMode {
  return v === "system" || v === "light" || v === "dark";
}
export function isSkin(v: unknown): v is string {
  return typeof v === "string" && SKINS.some((s) => s.id === v);
}

/** The concrete ground a mode resolves to right now (reads the OS for system). */
export function resolveMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "light" || mode === "dark") return mode;
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Applies the choice to <html> and persists it. Client-only. */
export function applyAppearance(mode: ThemeMode, skin: string): void {
  const el = document.documentElement;
  el.dataset.theme = resolveMode(mode); // CSS only ever sees light|dark
  el.dataset.mode = mode;
  el.dataset.skin = skin;
  const year = 31536000;
  document.cookie = `${MODE_COOKIE}=${mode};path=/;max-age=${year};samesite=lax`;
  document.cookie = `${SKIN_COOKIE}=${skin};path=/;max-age=${year};samesite=lax`;
}
