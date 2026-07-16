"use client";

// Offline-sync Phase 0: registers the app-shell service worker (production
// only — a SW caching dev-server assets would fight hot reload) and
// establishes this install's device identity in IndexedDB, the id every
// queued intent will carry from Phase 1 on.

import { useEffect } from "react";
import { ensureDeviceId } from "@/lib/offline/db";

export function SwRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
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
