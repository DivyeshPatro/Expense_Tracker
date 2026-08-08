"use client";

// Offline-sync: status, last sync, pending count, manual Sync now — now the
// entry point into the full Sync Center (activity feed, queue view, device
// info) at /settings/sync (spec §17 Phase 2).

import Link from "next/link";
import { useState } from "react";
import { useOffline } from "@/components/shell/offline-context";

function relative(iso: string | null): string {
  if (!iso) return "not yet";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function SyncCard() {
  const { pending, needsAttention, lastSyncAt, syncNow } = useOffline();
  const [busy, setBusy] = useState(false);

  const status =
    needsAttention.length > 0
      ? { icon: "⚠", text: `${needsAttention.length} change${needsAttention.length === 1 ? " needs" : "s need"} attention`, color: "var(--red)" }
      : pending.length > 0
        ? { icon: "⏳", text: `${pending.length} waiting to sync`, color: "var(--mut)" }
        // Audit L1: this said "Everything is synced" directly above "Last sync:
        // not yet" — a contradiction on the same card. With an empty queue and
        // no sync yet, the honest statement is that there is nothing to sync.
        : lastSyncAt
          ? { icon: "✓", text: "Everything is synced", color: "var(--green)" }
          : { icon: "✓", text: "Nothing waiting to sync", color: "var(--green)" };

  return (
    <section className="card p-6 flex flex-col gap-3">
      <h2 className="text-[13.5px] font-bold m-0">Sync</h2>
      <div className="flex items-center gap-2.5">
        <span className="text-[15px]" style={{ color: status.color }} aria-hidden="true">
          {status.icon}
        </span>
        <div className="flex-1">
          <div className="text-[13px] font-semibold" style={{ color: status.color }}>
            {status.text}
          </div>
          {lastSyncAt && <div className="text-[11.5px] text-mut2">Last sync: {relative(lastSyncAt)}</div>}
        </div>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await syncNow();
            setBusy(false);
          }}
          className="px-3 py-[7px] rounded-lg border border-line2 text-[11.5px] font-semibold text-acc cursor-pointer bg-transparent hover:bg-accsoft disabled:opacity-60"
        >
          {busy ? "…" : "Sync now"}
        </button>
      </div>
      <div className="text-[11.5px] text-mut2">
        Changes you make offline are saved on this device and sync automatically when you’re back online.
      </div>
      <Link href="/settings/sync" className="text-[12px] font-semibold text-acc no-underline self-start">Sync Center →</Link>
    </section>
  );
}
