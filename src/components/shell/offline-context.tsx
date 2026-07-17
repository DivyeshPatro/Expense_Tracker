"use client";

// Offline-sync Phase 2: the outbox owner. One provider holds pending intents
// in React state (mirroring IndexedDB), drives the drain ladder — immediate
// on enqueue, the 'online' event, tab focus, a 30s tick while the queue is
// non-empty, and mount — and exposes createViaOutbox(), now the ONLY path
// every solo create takes (spec §17 Phase 2: "all in-scope writes flow
// through outbox even online"). The server stays the only financial
// authority: intents replay through the batched /api/sync endpoint, which
// runs the SAME server-side services (zod → service → $transaction) as a
// live submission; this file never computes anything beyond the spec's
// bounded display deltas.

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { addExpenseAction, addIncomeAction, addTransferAction, type ActionResult } from "@/app/actions";
import { formatPaise } from "@/lib/money";
import {
  ensureDeviceId,
  getLastSyncAt,
  nextSeq,
  outboxList,
  outboxPut,
  outboxRemove,
  setLastSyncAt,
  syncLogAppend,
  OUTBOX_ENABLED,
  type OutboxIntent,
} from "@/lib/offline/db";
import { expenseSchema, incomeSchema, transferSchema } from "@/validators";

export type CreateKind = "expense.create" | "income.create" | "transfer.create";

// online-branch fallback only (no IndexedDB — private browsing); the outbox
// path below calls the batched /api/sync endpoint instead of these directly
const ACTIONS: Record<CreateKind, (input: unknown) => Promise<ActionResult>> = {
  "expense.create": addExpenseAction,
  "income.create": addIncomeAction,
  "transfer.create": addTransferAction,
};

const VALIDATORS: Record<CreateKind, (payload: unknown) => string | null> = {
  "expense.create": (p) => {
    const r = expenseSchema.safeParse(p);
    return r.success ? null : (r.error.issues[0]?.message ?? "Invalid input");
  },
  "income.create": (p) => {
    const r = incomeSchema.safeParse(p);
    return r.success ? null : (r.error.issues[0]?.message ?? "Invalid input");
  },
  "transfer.create": (p) => {
    const r = transferSchema.safeParse(p);
    return r.success ? null : (r.error.issues[0]?.message ?? "Invalid input");
  },
};

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 5 * 60_000;
const TICK_MS = 30_000;

function intentLabel(intent: Pick<OutboxIntent, "kind" | "payload">): string {
  const p = (intent.payload ?? {}) as { amount?: unknown; merchant?: string };
  const paise = Math.round((Number(p.amount) || 0) * 100);
  if (intent.kind === "transfer.create") return `${formatPaise(paise)} · Transfer`;
  const name = p.merchant || (intent.kind === "income.create" ? "Income" : "Expense");
  return `${formatPaise(paise)} · ${name}`;
}

interface SyncApiResult {
  intentId: string;
  code: "OK" | "VALIDATION" | "INVALID_REF_SOFT" | "INVALID_REF_HARD" | "STALE_INTENT";
  error?: string;
}

interface OfflineState {
  pending: OutboxIntent[];
  needsAttention: OutboxIntent[];
  lastSyncAt: string | null;
  createViaOutbox: (kind: CreateKind, payload: Record<string, unknown>) => Promise<ActionResult & { queued?: boolean }>;
  syncNow: () => Promise<void>;
  editPending: (intentId: string, payload: Record<string, unknown>) => Promise<ActionResult>;
  cancelPending: (intentId: string) => Promise<OutboxIntent | null>;
  restorePending: (intent: OutboxIntent) => Promise<void>;
  retryFailed: () => Promise<void>;
}

const Ctx = createContext<OfflineState>({
  pending: [],
  needsAttention: [],
  lastSyncAt: null,
  createViaOutbox: async () => ({ ok: false, error: "Offline support not ready" }),
  syncNow: async () => {},
  editPending: async () => ({ ok: false, error: "Offline support not ready" }),
  cancelPending: async () => null,
  restorePending: async () => {},
  retryFailed: async () => {},
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
      const queue = (await outboxList(userId)).filter((i) => i.status !== "needs-attention");
      // strict FIFO: only send the run of intents that aren't backing off
      const backingOffIdx = queue.findIndex((i) => i.nextRetryAt && new Date(i.nextRetryAt).getTime() > Date.now());
      const batch = backingOffIdx === -1 ? queue : queue.slice(0, backingOffIdx);

      if (batch.length > 0) {
        let results: SyncApiResult[] | null = null;
        try {
          const res = await fetch("/api/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              intents: batch.map((i) => ({ intentId: i.intentId, deviceId: i.deviceId, clientTs: i.clientTs, entityId: i.entityId, kind: i.kind, payload: i.payload })),
            }),
          });
          if (res.status === 401) return; // AUTH_EXPIRED: hold the whole queue untouched, retry next tick
          if (!res.ok) throw new Error(`sync failed: ${res.status}`);
          const body = await res.json();
          results = Array.isArray(body?.results) ? body.results : [];
        } catch {
          // whole-batch transport failure: back off the head only — it's the
          // idempotent retry unit, and strict FIFO means nothing behind it
          // should be attempted either (spec §5)
          const head = batch[0];
          const attempts = (head.attempts ?? 0) + 1;
          await outboxPut({
            ...head,
            attempts,
            nextRetryAt: new Date(Date.now() + Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempts)).toISOString(),
          });
        }

        if (results) {
          for (let i = 0; i < batch.length; i++) {
            const intent = batch[i];
            const result = results[i];
            if (!result) break; // fewer results than sent — stop rather than misattribute
            if (result.code === "OK" || result.code === "INVALID_REF_SOFT") {
              await outboxRemove(intent.intentId);
              await syncLogAppend({ ts: Date.now(), label: intentLabel(intent), status: result.code === "OK" ? "synced" : "healed", detail: result.error }).catch(() => {});
              applied++;
            } else {
              await outboxPut({ ...intent, status: "needs-attention", lastError: result.error, lastErrorCode: result.code });
              await syncLogAppend({ ts: Date.now(), label: intentLabel(intent), status: "needs-attention", detail: result.error }).catch(() => {});
            }
          }
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
      const validationError = VALIDATORS[kind](payload);
      if (validationError) return { ok: false, error: validationError };

      const deviceId = deviceIdRef.current ?? (await ensureDeviceId().catch(() => null));
      if (!deviceId) return ACTIONS[kind](payload); // no IndexedDB (private mode) → plain direct call, no offline tolerance possible either way
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
      // universal write-behind (spec §17 Phase 2): every create enqueues
      // first, online or not — the local write is instant (<1ms measured,
      // §20), and the drain below resolves in the background
      await outboxPut(intent);
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        await syncLogAppend({ ts: Date.now(), label: intentLabel(intent), status: "offline" }).catch(() => {});
      }
      await reload();
      setTimeout(() => void drain(), 0);
      return { ok: true, queued: true };
    },
    [userId, reload, drain]
  );

  const editPending = useCallback(
    async (intentId: string, payload: Record<string, unknown>): Promise<ActionResult> => {
      const list = await outboxList(userId);
      const existing = list.find((i) => i.intentId === intentId);
      if (!existing) return { ok: false, error: "This item already synced or was removed." };
      const validationError = VALIDATORS[existing.kind as CreateKind]?.(payload);
      if (validationError) return { ok: false, error: validationError };
      // coalesce in place: same intentId, same seq (FIFO position unchanged) —
      // never a second intent (spec §11)
      await outboxPut({
        ...existing,
        payload,
        clientTs: new Date().toISOString(),
        status: "pending",
        attempts: 0,
        nextRetryAt: undefined,
        lastError: undefined,
        lastErrorCode: undefined,
      });
      await reload();
      setTimeout(() => void drain(), 0);
      return { ok: true };
    },
    [userId, reload, drain]
  );

  const cancelPending = useCallback(
    async (intentId: string): Promise<OutboxIntent | null> => {
      const list = await outboxList(userId);
      const existing = list.find((i) => i.intentId === intentId) ?? null;
      if (!existing) return null;
      await outboxRemove(intentId);
      await syncLogAppend({ ts: Date.now(), label: intentLabel(existing), status: "cancelled" }).catch(() => {});
      await reload();
      return existing;
    },
    [userId, reload]
  );

  const restorePending = useCallback(
    async (intent: OutboxIntent): Promise<void> => {
      await outboxPut(intent);
      await reload();
    },
    [reload]
  );

  const retryFailed = useCallback(async (): Promise<void> => {
    const list = await outboxList(userId);
    // only RETRYABLE-parked items requeue here — structural errors (validation,
    // missing reference, stale) need a human decision, not a blind retry (spec §8)
    const retryable = list.filter((i) => i.status === "needs-attention" && i.lastErrorCode === "RETRYABLE");
    if (retryable.length === 0) return;
    for (const intent of retryable) {
      await outboxPut({ ...intent, status: "pending", attempts: 0, nextRetryAt: undefined, lastError: undefined, lastErrorCode: undefined });
    }
    await reload();
    void drain();
  }, [userId, reload, drain]);

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

  return (
    <Ctx.Provider value={{ pending, needsAttention, lastSyncAt, createViaOutbox, syncNow, editPending, cancelPending, restorePending, retryFailed }}>
      {children}
    </Ctx.Provider>
  );
}
