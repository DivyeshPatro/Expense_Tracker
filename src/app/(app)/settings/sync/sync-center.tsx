"use client";

// Offline-sync Phase 2 (spec §8): the Sync Center — the trust anchor. Status
// hero, the queue (needs-attention pinned first, then pending oldest-first),
// the local activity feed (syncLog ring buffer), Sync now / Retry failed,
// this device's identity, and Advanced (export the log — the only Advanced
// action with a real target today; "Clear offline data" is scoped to the
// Phase 6 read-snapshot store, which doesn't exist yet, so it's deferred
// rather than shipped as a button that clears nothing).

import Link from "next/link";
import { useEffect, useState } from "react";
import { getDeviceAddedAt, getDeviceName, syncLogList, type OutboxIntent, type SyncLogEntry } from "@/lib/offline/db";
import { formatPaise } from "@/lib/money";
import { useOffline } from "@/components/shell/offline-context";
import { useUI } from "@/components/shell/ui-context";

function relative(iso: string | null): string {
  if (!iso) return "not yet";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function shortDate(iso: string | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

const LOG_ICON: Record<SyncLogEntry["status"], { icon: string; color: string }> = {
  synced: { icon: "✓", color: "var(--green)" },
  healed: { icon: "✓", color: "var(--green)" },
  "needs-attention": { icon: "⚠", color: "var(--red)" },
  offline: { icon: "⏳", color: "var(--mut)" },
  cancelled: { icon: "—", color: "var(--mut2)" },
};

const LOG_STATUS_LABEL: Record<SyncLogEntry["status"], string> = {
  synced: "Synced",
  healed: "Synced (uncategorized)",
  "needs-attention": "Needs attention",
  offline: "Waiting for internet",
  cancelled: "Removed",
};

export function SyncCenter() {
  const { pending, needsAttention, lastSyncAt, syncNow, retryFailed } = useOffline();
  const { openModal } = useUI();
  const [syncBusy, setSyncBusy] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [log, setLog] = useState<SyncLogEntry[]>([]);
  const [logLimit, setLogLimit] = useState(20);
  const [device, setDevice] = useState<{ name: string; addedAt: string } | null>(null);
  const [storageEstimate, setStorageEstimate] = useState<number | null>(null);
  const [hasBackgroundSync, setHasBackgroundSync] = useState(false);

  const queue = [...needsAttention, ...pending];
  const retryableCount = needsAttention.filter((i) => i.lastErrorCode === "RETRYABLE").length;

  useEffect(() => {
    void syncLogList(200).then(setLog).catch(() => {});
    // re-read the log whenever the queue shape changes — drain()/cancelPending
    // both append to it, and this page has no other reason to know that happened
  }, [pending.length, needsAttention.length, lastSyncAt]);

  useEffect(() => {
    Promise.all([getDeviceName(), getDeviceAddedAt()]).then(([name, addedAt]) => {
      if (name && addedAt) setDevice({ name, addedAt });
    });
    if (typeof navigator !== "undefined" && "storage" in navigator && navigator.storage.estimate) {
      void navigator.storage.estimate().then((e) => setStorageEstimate(e.usage ?? 0));
    }
    setHasBackgroundSync(typeof window !== "undefined" && "serviceWorker" in navigator && "SyncManager" in window);
  }, []);

  const status =
    needsAttention.length > 0
      ? { icon: "⚠", text: `${needsAttention.length} change${needsAttention.length === 1 ? " needs" : "s need"} attention`, color: "var(--red)" }
      : pending.length > 0
        ? { icon: "⏳", text: typeof navigator !== "undefined" && !navigator.onLine ? "Waiting for internet" : `${pending.length} waiting to sync`, color: "var(--mut)" }
        : { icon: "✓", text: "Everything is synced", color: "var(--green)" };

  async function handleExport() {
    const payload = { exportedAt: new Date().toISOString(), device, queue: [...needsAttention, ...pending], activity: log };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ledgerly-sync-log-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-4 max-w-[640px]" style={{ animation: "rise .25s ease" }}>
      <Link href="/settings" className="text-[12.5px] font-semibold text-acc no-underline self-start">← Settings</Link>

      <section className="card p-6 flex flex-col gap-1">
        <div className="flex items-center gap-2.5">
          <span className="text-[19px]" style={{ color: status.color }} aria-hidden="true">{status.icon}</span>
          <div>
            <div className="text-[15px] font-bold" style={{ color: status.color }}>{status.text}</div>
            <div className="text-[12px] text-mut2">Last sync: {relative(lastSyncAt)}</div>
          </div>
        </div>
      </section>

      {(pending.length > 0 || needsAttention.length > 0) && (
        <section className="card p-6 flex flex-col gap-2">
          {pending.length > 0 && (
            <a href="#queue" className="flex items-center justify-between text-[13px] font-semibold no-underline text-ink">
              Waiting to sync <span className="text-mut2">{pending.length} ›</span>
            </a>
          )}
          {needsAttention.length > 0 && (
            <a href="#queue" className="flex items-center justify-between text-[13px] font-semibold no-underline text-red">
              Needs attention <span>{needsAttention.length} ›</span>
            </a>
          )}
        </section>
      )}

      {queue.length > 0 && (
        <section id="queue" className="card p-6 flex flex-col gap-2 scroll-mt-20">
          <h2 className="text-[13.5px] font-bold m-0">Queue</h2>
          <div className="flex flex-col">
            {queue.map((i) => (
              <QueueRow key={i.intentId} intent={i} onClick={() => openModal("pendingDetail", { intentId: i.intentId })} />
            ))}
          </div>
        </section>
      )}

      <section className="card p-6 flex flex-col gap-3">
        <h2 className="text-[13.5px] font-bold m-0">Recent activity</h2>
        {log.length === 0 ? (
          <div className="text-[12.5px] text-mut2">Nothing yet — synced changes will show up here.</div>
        ) : (
          <div className="flex flex-col">
            {log.slice(0, logLimit).map((entry, idx) => {
              const meta = LOG_ICON[entry.status];
              return (
                <div key={entry.id ?? idx} className="flex items-center gap-3 py-2 border-b border-line last:border-b-0">
                  <span className="w-5 text-center text-[13px] flex-none" style={{ color: meta.color }} aria-hidden="true">{meta.icon}</span>
                  <div className="flex-1 min-w-0 text-[12.5px]">
                    <span className="font-semibold" style={{ color: meta.color }}>{LOG_STATUS_LABEL[entry.status]}</span>{" "}
                    <span className="text-mut">{entry.label}</span>
                  </div>
                  <time className="text-[11px] text-mut2 flex-none">{relative(new Date(entry.ts).toISOString())}</time>
                </div>
              );
            })}
          </div>
        )}
        {log.length > logLimit && (
          <button
            onClick={() => setLogLimit((n) => Math.min(200, n + 20))}
            className="self-center px-4 py-1.5 rounded-lg border border-line2 bg-card text-[12px] font-semibold text-acc cursor-pointer hover:bg-accsoft"
          >
            Show more
          </button>
        )}
      </section>

      <section className="card p-6 flex gap-2.5">
        <button
          disabled={syncBusy}
          onClick={async () => {
            setSyncBusy(true);
            await syncNow();
            setSyncBusy(false);
          }}
          className="flex-1 px-3 py-2.5 rounded-lg border border-line2 text-[12.5px] font-semibold text-acc cursor-pointer bg-transparent hover:bg-accsoft disabled:opacity-60"
        >
          {syncBusy ? "Syncing…" : "Sync now"}
        </button>
        {retryableCount > 0 && (
          <button
            disabled={retryBusy}
            onClick={async () => {
              setRetryBusy(true);
              await retryFailed();
              setRetryBusy(false);
            }}
            className="flex-1 px-3 py-2.5 rounded-lg border border-line2 text-[12.5px] font-semibold text-acc cursor-pointer bg-transparent hover:bg-accsoft disabled:opacity-60"
          >
            {retryBusy ? "Retrying…" : `Retry failed (${retryableCount})`}
          </button>
        )}
      </section>

      <section className="card p-6 flex flex-col gap-2.5">
        <h2 className="text-[13.5px] font-bold m-0">This device</h2>
        <div className="text-[12.5px] text-mut">
          {device ? `${device.name} · added ${shortDate(device.addedAt)}` : "…"}
        </div>
        <div className="flex items-center justify-between text-[12.5px] text-mut">
          <span>Offline data</span>
          <span>{storageEstimate === null ? "…" : storageEstimate < 1024 ? `${storageEstimate} B` : `${(storageEstimate / 1024 / 1024).toFixed(1)} MB`}</span>
        </div>
        <div className="flex items-center justify-between text-[12.5px] text-mut">
          <span>Background sync</span>
          <span>{hasBackgroundSync ? "Automatic ✓" : "Syncs when the app is open"}</span>
        </div>
        <div className="pt-1 border-t border-line">
          <button onClick={handleExport} className="text-[12.5px] font-semibold text-acc cursor-pointer bg-transparent border-none p-0 hover:underline">
            Export sync log
          </button>
        </div>
      </section>
    </div>
  );
}

function QueueRow({ intent, onClick }: { intent: OutboxIntent; onClick: () => void }) {
  const p = intent.payload as { amount?: unknown; merchant?: string };
  const paise = Math.round((Number(p.amount) || 0) * 100);
  const attention = intent.status === "needs-attention";
  const name = intent.kind === "transfer.create" ? "Transfer" : p.merchant || (intent.kind === "income.create" ? "Income" : "Expense");
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 py-[10px] border-b border-line last:border-b-0 bg-transparent border-x-0 border-t-0 cursor-pointer text-left min-h-[44px]"
    >
      <span className="text-[14px] flex-none" style={{ color: attention ? "var(--red)" : "var(--mut)" }} aria-hidden="true">
        {attention ? "⚠" : "⏳"}
      </span>
      <div className="flex-1 min-w-0 text-[12.5px] font-semibold truncate">{formatPaise(paise)} · {name}</div>
      <span className="text-mut2 flex-none">›</span>
    </button>
  );
}
