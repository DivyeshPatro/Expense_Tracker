"use client";

// Per-device navigation preferences, stored in localStorage like the dashboard
// widget customization. A same-tab custom event keeps the bottom nav, the
// sidebar and the settings editor in sync live; the storage event covers other
// tabs. SSR and the first client render both use the defaults (no localStorage
// on the server), then the effect swaps in the stored prefs after hydration —
// no mismatch, at most a one-frame settle for a customised layout.

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_PREFS, normalizePrefs, type NavPrefs } from "@/lib/nav-prefs";

const KEY = "ledgerly-nav";
const EVENT = "ledgerly:nav-prefs";

function read(): NavPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return normalizePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizePrefs(null);
  }
}

export function useNavPrefs(): { prefs: NavPrefs; save: (next: NavPrefs) => void; reset: () => void; ready: boolean } {
  const [prefs, setPrefs] = useState<NavPrefs>(DEFAULT_PREFS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setPrefs(read());
    setReady(true);
    const onChange = () => setPrefs(read());
    window.addEventListener(EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  const save = useCallback((next: NavPrefs) => {
    const norm = normalizePrefs(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(norm));
    } catch {
      // storage unavailable (private mode) — the change just won't persist
    }
    window.dispatchEvent(new CustomEvent(EVENT));
  }, []);

  const reset = useCallback(() => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // ignore
    }
    window.dispatchEvent(new CustomEvent(EVENT));
  }, []);

  return { prefs, save, reset, ready };
}
