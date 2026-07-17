"use client";

// Offline-sync Phase 1: the outbox owner. One provider holds pending intents
// in React state (mirroring IndexedDB), drives the drain ladder — immediate
// on enqueue-while-online, the 'online' event, tab focus, a 30s tick while
// the queue is non-empty, and mount — and exposes createViaOutbox(), the
// offline-tolerant path the three create forms use. The server stays the
// only financial authority: intents replay through the SAME server actions
// (zod → service → $transaction) as live submissions; this file never
// computes anything beyond the spec's bounded display deltas.

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { addExpenseAction, addIncomeAction, addTransferAction, type ActionResult } from "@/app/actions";
import {
  ensureDeviceId,
  getLastSyncAt,
  nextSeq,
  outboxList,
  outboxPut,
  outboxRemove,
  setLastSyncAt,
  OUTBOX_ENABLED,
  type OutboxIntent,
} from "@/lib/offline/db";

export type CreateKind = "expense.create" | "income.create" | "transfer.create";

const ACTIONS: Record<CreateKind, (input: unknown) => Promise<ActionResult>> = {
  "expense.create": addExpenseAction,
  "income.create": addIncomeAction,
  "transfer.create": addTransferAction,
};

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 5 * 60_000;
const TICK_MS = 30_000;

interface OfflineState {
  pending: OutboxIntent[];
  needsAttention: OutboxIntent[];
  lastSyncAt: string | null;
  createViaOutbox: (kind: CreateKind, payload: Record<string, unknown>) => Promise<ActionResult & { queued?: boolean }>;
  syncNow: () => Promise<void>;
}

const Ctx = createContext<OfflineState>({
  pending: [],
  needsAttention: [],
  lastSyncAt: null,
  createViaOutbox: async () => ({ ok: false, error: "Offline support not ready" }),
  syncNow: async () => {},
});

export const useOffline = () => useContext(Ctx);

const newEntityId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 24);

export function OfflineProvider({ userId, children }: { userId: string; children: React.ReactNode }) {
  const router = useRouter();
  const [intents, setIntents] = useState<OutboxIntent[]>([]);
  const [lastSyncAt, setLast] = useState<string | null>(null);
  const draining = useRef(false);
  const deviceIdRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setIntents(await outboxList(userId));
    } catch {
      /* IndexedDB unavailable (private mode) — degrade to online-only */
    }
  }, [userId]);

  const markSynced = useCallback(async () => {
    const iso = new Date().toISOString();
    setLast(iso);
    await setLastSyncAt(iso).catch(() => {});
  }, []);

  const drain = useCallback(async () => {
    if (!OUTBOX_ENABLED || draining.current || typeof navigator === "undefined" || !navigator.onLine) return;
    draining.current = true;
    let applied = 0;
    try {
      const queue = await outboxList(userId);
      for (const intent of queue.filter((i) => i.status !== "needs-attention")) {
        if (intent.nextRetryAt && new Date(intent.nextRetryAt).getTime() > Date.now()) break; // strict FIFO waits out backoff
        try {
          const res = await ACTIONS[intent.kind as CreateKind]({
            ...(intent.payload as Record<string, unknown>),
            intent: { intentId: intent.intentId, deviceId: intent.deviceId, clientTs: intent.clientTs, entityId: intent.entityId },
          });
          if (res.ok) {
            await outboxRemove(intent.intentId);
            applied++;
          } else {
            // terminal (validation, deleted reference): park it — creates are
            // per-entity unique, so nothing behind it is blocked (spec §5)
            await outboxPut({ ...intent, status: "needs-attention", lastError: res.error });
          }
        } catch {
          // network/server unreachable: exponential backoff, stop the drain —
          // everything behind stays FIFO behind this intent (spec §5)
          const attempts = (intent.attempts ?? 0) + 1;
          await outboxPut({
            ...intent,
            attempts,
            nextRetryAt: new Date(Date.now() + Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempts)).toISOString(),
          });
          break;
        }
      }
    } finally {
      draining.current = false;
    }
    await reload();
    if (applied > 0) {
      await markSynced();
      router.refresh(); // the read model is the pull channel (spec §3)
    }
  }, [userId, reload, markSynced, router]);

  const createViaOutbox = useCallback(
    async (kind: CreateKind, payload: Record<string, unknown>): Promise<ActionResult & { queued?: boolean }> => {
      const deviceId = deviceIdRef.current ?? (await ensureDeviceId().catch(() => null));
      if (!deviceId) return ACTIONS[kind](payload); // no IndexedDB → plain online behavior
      deviceIdRef.current = deviceId;
      const intent: OutboxIntent = {
        intentId: crypto.randomUUID(),
        seq: nextSeq(),
        userId,
        deviceId,
        kind,
        payload,
        entityId: newEntityId(),
        clientTs: new Date().toISOString(),
        status: "pending",
        attempts: 0,
      };
      const meta = { intentId: intent.intentId, deviceId, clientTs: intent.clientTs, entityId: intent.entityId };

      if (navigator.onLine) {
        try {
          const res = await ACTIONS[kind]({ ...payload, intent: meta });
          if (res.ok) {
            void markSynced();
            return res;
          }
          return res; // validation error: surface it now, never queue known-bad input
        } catch {
          /* network died mid-flight — fall through to the queue; the intentId
             makes it safe even if the server actually applied it */
        }
      }
      await outboxPut(intent);
      await reload();
      setTimeout(() => void drain(), 0); // if we're actually online, this clears in ~1s
      return { ok: true, queued: true };
    },
    [userId, reload, drain, markSynced]
  );

  const syncNow = useCallback(async () => {
    await drain();
  }, [drain]);

  useEffect(() => {
    if (!OUTBOX_ENABLED) return;
    void reload();
    void getLastSyncAt().then((v) => v && setLast(v)).catch(() => {});
    void ensureDeviceId().then((id) => (deviceIdRef.current = id)).catch(() => {});
    void drain(); // mount: a queue left behind by a killed app drains on reopen

    const onOnline = () => void drain();
    const onVisible = () => document.visibilityState === "visible" && void drain();
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    const tick = window.setInterval(() => {
      void outboxList(userId)
        .then((q) => {
          if (q.some((i) => i.status !== "needs-attention")) void drain();
        })
        .catch(() => {});
    }, TICK_MS);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const pending = intents.filter((i) => i.status !== "needs-attention");
  const needsAttention = intents.filter((i) => i.status === "needs-attention");

  return <Ctx.Provider value={{ pending, needsAttention, lastSyncAt, createViaOutbox, syncNow }}>{children}</Ctx.Provider>;
}
