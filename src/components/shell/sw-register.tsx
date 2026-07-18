"use client";

// Offline-sync Phase 0: registers the app-shell service worker (production
// only — a SW caching dev-server assets would fight hot reload) and
// establishes this install's device identity in IndexedDB, the id every
// queued intent will carry from Phase 1 on.

import { useEffect } from "react";
import { ensureDeviceId } from "@/lib/offline/db";

export function SwRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      // Dev self-heal: a SW registered by a past production run on this SAME
      // origin (e.g. `next start` on localhost:3000) persists into dev and
      // keeps serving its cache-first /_next/static/* strategy — but dev
      // chunk URLs are stable while their contents change every recompile,
      // so the stale cache manifests as hydration mismatches and webpack
      // "reading 'call'" chunk errors. Unregister it and drop its caches so
      // one dev page load permanently clears the state.
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker
          .getRegistrations()
          .then((regs) => Promise.all(regs.map((r) => r.unregister())))
          .catch(() => {});
      }
      if ("caches" in window) {
        caches
          .keys()
          .then((keys) => Promise.all(keys.filter((k) => k.startsWith("ledgerly-")).map((k) => caches.delete(k))))
          .catch(() => {});
      }
      ensureDeviceId().catch(() => {});
      return;
    }
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // registration failure degrades to plain online behavior — never surface
      });
    }
    ensureDeviceId().catch(() => {
      // IndexedDB unavailable (private mode etc.) — Phase 1 handles this state
    });
  }, []);
  return null;
}
