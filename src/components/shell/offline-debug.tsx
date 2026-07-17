"use client";

// Offline-sync Phase 2 addendum (spec §21): developer-only diagnostic
// readout — never shown to end users. Behind NEXT_PUBLIC_OFFLINE_DEBUG so it
// never ships lit in production; its data sources (pending/needsAttention,
// OUTBOX_ENABLED, SW registration) already exist from Phase 1/2.

import { useEffect, useState } from "react";
import { OUTBOX_ENABLED } from "@/lib/offline/db";
import { useOffline } from "./offline-context";

const DEBUG_ENABLED = process.env.NEXT_PUBLIC_OFFLINE_DEBUG === "1";

export function OfflineDebug() {
  if (!DEBUG_ENABLED) return null;
  return <OfflineDebugReadout />;
}

function OfflineDebugReadout() {
  const { pending, needsAttention } = useOffline();
  const [online, setOnline] = useState(true);
  const [swRegistered, setSwRegistered] = useState(false);

  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    navigator.serviceWorker?.getRegistration()
      .then((r) => setSwRegistered(!!r?.active))
      .catch(() => {});
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  const queueHealthy = pending.every((i) => !i.nextRetryAt || new Date(i.nextRetryAt).getTime() <= Date.now());
  const intentHealthy = needsAttention.length === 0;

  const line = [
    online ? "Online" : "Offline",
    `Pending ${pending.length}`,
    `Queue ${queueHealthy ? "Healthy" : "Backing off"}`,
    `Intent ${intentHealthy ? "Healthy" : "Issues"}`,
    `SW ${swRegistered ? "Registered" : "Not registered"}`,
    `Sync ${OUTBOX_ENABLED ? "Enabled" : "Disabled"}`,
  ].join(" · ");

  return (
    <div
      data-testid="offline-debug"
      className="fixed bottom-1 left-1 z-[90] px-2 py-1 rounded text-[10px] font-mono pointer-events-none select-none"
      style={{ background: "rgba(0,0,0,.78)", color: "#5ee88f" }}
    >
      {line}
    </div>
  );
}
