// One place that knows every user display preference: its storage, its
// default, and how to parse an untrusted stored value back into a typed one.
//
// Why a registry rather than another ad-hoc cookie each time: before this,
// theme used two cookies, nav layout and dashboard widgets used localStorage
// keys, and expense basis had just added a third cookie — four mechanisms, no
// shared validation, and no single list of what a user can even customise.
//
// Two storage backends, chosen per preference rather than globally:
//
//   • "cookie" — readable during server rendering. Required for anything that
//     changes server-rendered output, otherwise the first paint shows the
//     default and visibly corrects itself after hydration.
//   • "device" — localStorage. For client-only preferences, and for anything
//     too large to put in a cookie (cookies are capped ~4KB per domain, and
//     every one is sent on every request).
//
// Everything here is presentation. No preference may change stored data,
// exported data, or any figure's arithmetic — see expense-basis.ts.

export type PrefStorage = "cookie" | "device";

export interface PrefDef<T> {
  /** Cookie name or localStorage key. Stable — changing it silently resets everyone. */
  readonly key: string;
  readonly storage: PrefStorage;
  readonly fallback: T;
  /** Must total-parse: any junk, stale or hostile value returns the fallback. */
  parse(raw: string | undefined | null): T;
  serialize(value: T): string;
}

export const PREF_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Define a preference. Wraps parse so a throwing parser can never break a page. */
export function definePref<T>(def: PrefDef<T>): PrefDef<T> {
  return {
    ...def,
    parse(raw) {
      if (raw == null || raw === "") return def.fallback;
      try {
        return def.parse(raw);
      } catch {
        return def.fallback;
      }
    },
  };
}

/**
 * Read a cookie-backed preference during server rendering.
 *
 * Takes a getter rather than importing next/headers so this module stays
 * usable from tests and from client code.
 */
export function readPref<T>(def: PrefDef<T>, get: (key: string) => string | undefined): T {
  return def.parse(get(def.key));
}

/** Write a preference from the browser. Cookie prefs must not be put in localStorage or the server stops seeing them. */
export function writePref<T>(def: PrefDef<T>, value: T): void {
  if (typeof document === "undefined") return;
  const raw = def.serialize(value);
  if (def.storage === "cookie") {
    document.cookie = `${def.key}=${encodeURIComponent(raw)};path=/;max-age=${PREF_MAX_AGE_SECONDS};samesite=lax`;
  } else {
    try {
      localStorage.setItem(def.key, raw);
    } catch {
      // Private mode / quota. A lost display preference is not worth throwing over.
    }
  }
}

/** Read a preference from the browser, whichever backend it uses. */
export function readPrefClient<T>(def: PrefDef<T>): T {
  if (typeof document === "undefined") return def.fallback;
  if (def.storage === "cookie") {
    const hit = document.cookie.split("; ").find((c) => c.startsWith(`${def.key}=`));
    return def.parse(hit ? decodeURIComponent(hit.slice(def.key.length + 1)) : undefined);
  }
  try {
    return def.parse(localStorage.getItem(def.key));
  } catch {
    return def.fallback;
  }
}

/**
 * Preferences that predate this registry and still own their own storage.
 * Listed so this file remains the complete index of what a user can customise,
 * and so the next person can see what is left to migrate rather than adding a
 * fifth mechanism. Migrating them means moving working, shipped behaviour
 * (including the theme's anti-flash bootstrap in app/layout.tsx), so it is
 * deliberately a separate change.
 */
export const UNMIGRATED_PREFS = [
  { key: "ledgerly-theme", storage: "cookie", owner: "lib/theme.ts" },
  { key: "ledgerly-skin", storage: "cookie", owner: "lib/theme.ts" },
  { key: "ledgerly-nav-prefs", storage: "device", owner: "lib/nav-prefs.ts" },
  { key: "ledgerly-dash-hidden", storage: "device", owner: "dashboard/mobile-dashboard.tsx" },
] as const;
