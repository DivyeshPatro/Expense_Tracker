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
import {
  addExpenseAction,
  addIncomeAction,
  addTransferAction,
  deleteTransactionAction,
  updateExpenseAction,
  updateIncomeAction,
  updateTransferAction,
  type ActionResult,
} from "@/app/actions";
import { formatPaise } from "@/lib/money";
import {
  ensureDeviceId,
  getDeviceName,
  getLastSyncAt,
  nextSeq,
  outboxList,
  outboxPut,
  outboxRemove,
  setLastSyncAt,
  syncLogAppend,
  OUTBOX_ENABLED,
  type ConflictSnapshot,
  type OutboxIntent,
} from "@/lib/offline/db";
import { expenseSchema, incomeSchema, transferSchema } from "@/validators";

export type CreateKind = "expense.create" | "income.create" | "transfer.create";
// Phase 3 (offline-sync-spec §17): edit/delete of already-synced solo records
export type MutationKind = "expense.update" | "income.update" | "transfer.update" | "tx.delete";
export type OutboxKind = CreateKind | MutationKind;

// online-branch fallback only (no IndexedDB — private browsing); the outbox
// path below calls the batched /api/sync endpoint instead of these directly
const ACTIONS: Record<CreateKind, (input: unknown) => Promise<ActionResult>> = {
  "expense.create": addExpenseAction,
  "income.create": addIncomeAction,
  "transfer.create": addTransferAction,
};

/** production audit §1.2/§PhaseA.2: a write with no Intent row is invisible
 * to a LATER conflict check, which then silently defaults to "same actor"
 * and applies over it — this used to be true of every private-browsing
 * fallback call, since none of them ever built an `intent` object at all.
 * No persisted device identity is available here (that's WHY this fallback
 * exists), but an ephemeral, call-scoped one is still enough for
 * checkOverride to see the write and for the Intent table to stay complete
 * — deviceName is intentionally omitted, so OK_OVERRIDE copy just falls back
 * to its existing generic "replaced a newer edit" wording. */
function ephemeralIntent(baseVersion?: number) {
  return { intentId: crypto.randomUUID(), deviceId: crypto.randomUUID(), clientTs: new Date().toISOString(), baseVersion };
}

async function directMutationFallback(
  kind: MutationKind,
  entityId: string,
  payload: Record<string, unknown>,
  baseVersion: number
): Promise<ActionResult> {
  const intent = ephemeralIntent(baseVersion);
  if (kind === "tx.delete") return deleteTransactionAction({ id: entityId, intent });
  if (kind === "expense.update") return updateExpenseAction({ id: entityId, ...payload, intent });
  if (kind === "income.update") return updateIncomeAction({ id: entityId, ...payload, intent });
  return updateTransferAction({ id: entityId, ...payload, intent });
}

const expenseValidator = (p: unknown) => {
  const r = expenseSchema.safeParse(p);
  return r.success ? null : (r.error.issues[0]?.message ?? "Invalid input");
};
const incomeValidator = (p: unknown) => {
  const r = incomeSchema.safeParse(p);
  return r.success ? null : (r.error.issues[0]?.message ?? "Invalid input");
};
const transferValidator = (p: unknown) => {
  const r = transferSchema.safeParse(p);
  return r.success ? null : (r.error.issues[0]?.message ?? "Invalid input");
};
// "tx.delete" has no payload to validate — omitted
const VALIDATORS: Partial<Record<OutboxKind, (payload: unknown) => string | null>> = {
  "expense.create": expenseValidator,
  "expense.update": expenseValidator,
  "income.create": incomeValidator,
  "income.update": incomeValidator,
  "transfer.create": transferValidator,
  "transfer.update": transferValidator,
};

// collaboration-architecture-rfc §7/§8: these three codes carry no server
// `error` string (their copy is dynamic — built client-side from the
// intent's own remembered payload/groupName, see FAILURE_COPY's neighbors in
// transaction-detail.tsx) — this is just the syncLog's one-line fallback.
const SYNC_LOG_DETAIL: Partial<Record<SyncApiResult["code"], string>> = {
  CONFLICT: "someone else changed this — needs your review",
  NOT_AUTHORIZED: "you're no longer part of that group",
  GROUP_DELETED: "the group was deleted",
};

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 5 * 60_000;
const POISON_PILL_MS = 24 * 60 * 60 * 1000; // spec §5: RETRYABLE intents park as needs-attention after 24h...
const POISON_PILL_ATTEMPTS = 20; // ...or 20 attempts, whichever first — a permanently-erroring intent can't block the queue forever
const TICK_MS = 30_000;

export function intentLabel(intent: Pick<OutboxIntent, "kind" | "payload">): string {
  // delete intents carry a {amount, merchant} display snapshot only — softDeleteTransaction needs no payload at all (spec §4.1's "exactly the zod input" is a create/update-only description)
  const p = (intent.payload ?? {}) as { amount?: unknown; merchant?: string };
  const paise = Math.round((Number(p.amount) || 0) * 100);
  if (intent.kind === "transfer.create" || intent.kind === "transfer.update") return `${formatPaise(paise)} · Transfer`;
  const name = p.merchant || (intent.kind === "income.create" || intent.kind === "income.update" ? "Income" : "Expense");
  return `${formatPaise(paise)} · ${name}`;
}

interface SyncApiResult {
  intentId: string;
  code:
    | "OK"
    | "OK_OVERRIDE"
    | "VALIDATION"
    | "INVALID_REF_SOFT"
    | "INVALID_REF_HARD"
    | "STALE_INTENT"
    | "CONFLICT"
    | "NOT_AUTHORIZED"
    | "GROUP_DELETED";
  error?: string;
  overriddenByDevice?: string;
  conflict?: ConflictSnapshot;
}

interface OfflineState {
  pending: OutboxIntent[];
  needsAttention: OutboxIntent[];
  lastSyncAt: string | null;
  authExpired: boolean; // spec §12 "Session expired at sync time" — banner, not per-item; queue holds, nothing lost
  createViaOutbox: (kind: CreateKind, payload: Record<string, unknown>) => Promise<ActionResult & { queued?: boolean }>;
  enqueueMutation: (
    kind: MutationKind,
    entityId: string,
    payload: Record<string, unknown>,
    baseVersion: number,
    groupName?: string
  ) => Promise<ActionResult & { queued?: boolean; intentId?: string }>;
  syncNow: () => Promise<void>;
  editPending: (intentId: string, payload: Record<string, unknown>) => Promise<ActionResult>;
  cancelPending: (intentId: string) => Promise<OutboxIntent | null>;
  restorePending: (intent: OutboxIntent) => Promise<void>;
  retryFailed: () => Promise<void>;
  // collaboration-architecture-rfc §7: conflict card actions
  resolveConflictKeepMine: (intentId: string) => Promise<void>;
  resolveConflictKeepTheirs: (intentId: string) => Promise<void>;
}

const Ctx = createContext<OfflineState>({
  pending: [],
  needsAttention: [],
  lastSyncAt: null,
  authExpired: false,
  createViaOutbox: async () => ({ ok: false, error: "Offline support not ready" }),
  enqueueMutation: async () => ({ ok: false, error: "Offline support not ready" }),
  syncNow: async () => {},
  editPending: async () => ({ ok: false, error: "Offline support not ready" }),
  cancelPending: async () => null,
  restorePending: async () => {},
  retryFailed: async () => {},
  resolveConflictKeepMine: async () => {},
  resolveConflictKeepTheirs: async () => {},
});

export const useOffline = () => useContext(Ctx);

const newEntityId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 24);

export function OfflineProvider({ userId, children }: { userId: string; children: React.ReactNode }) {
  const router = useRouter();
  const [intents, setIntents] = useState<OutboxIntent[]>([]);
  const [lastSyncAt, setLast] = useState<string | null>(null);
  const [authExpired, setAuthExpired] = useState(false);
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
              intents: batch.map((i) => ({
                intentId: i.intentId,
                deviceId: i.deviceId,
                deviceName: i.deviceName,
                clientTs: i.clientTs,
                entityId: i.entityId,
                baseVersion: i.baseVersion,
                kind: i.kind,
                payload: i.payload,
              })),
            }),
          });
          if (res.status === 401) {
            // AUTH_EXPIRED (spec §12): hold the whole queue untouched — nothing
            // is lost — and surface the banner instead of retrying silently
            setAuthExpired(true);
            return;
          }
          if (!res.ok) throw new Error(`sync failed: ${res.status}`);
          const body = await res.json();
          results = Array.isArray(body?.results) ? body.results : [];
          setAuthExpired(false); // a real response landed — the session is good again
        } catch {
          // whole-batch transport failure: back off the head only — it's the
          // idempotent retry unit, and strict FIFO means nothing behind it
          // should be attempted either (spec §5). Poison-pill: after 24h or
          // 20 attempts of the SAME intent failing this way, stop retrying
          // silently and park it — a permanently-erroring intent must not
          // block the queue forever (spec §5, §18).
          const head = batch[0];
          const attempts = (head.attempts ?? 0) + 1;
          const firstFailedAt = head.firstFailedAt ?? new Date().toISOString();
          const poisoned = attempts >= POISON_PILL_ATTEMPTS || Date.now() - new Date(firstFailedAt).getTime() > POISON_PILL_MS;
          if (poisoned) {
            await outboxPut({
              ...head,
              attempts,
              firstFailedAt,
              status: "needs-attention",
              lastError: "Couldn't sync after repeated attempts — check your connection and try again.",
              lastErrorCode: "RETRYABLE",
            });
            await syncLogAppend({ ts: Date.now(), label: intentLabel(head), status: "needs-attention", detail: "parked after repeated retries" }).catch(() => {});
          } else {
            await outboxPut({
              ...head,
              attempts,
              firstFailedAt,
              nextRetryAt: new Date(Date.now() + Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempts)).toISOString(),
            });
          }
        }

        if (results) {
          for (let i = 0; i < batch.length; i++) {
            const intent = batch[i];
            const result = results[i];
            if (!result) break; // fewer results than sent — stop rather than misattribute
            if (result.code === "OK" || result.code === "OK_OVERRIDE" || result.code === "INVALID_REF_SOFT") {
              await outboxRemove(intent.intentId);
              const status = result.code === "INVALID_REF_SOFT" ? "healed" : result.code === "OK_OVERRIDE" ? "overridden" : "synced";
              const detail =
                result.code === "OK_OVERRIDE"
                  ? result.overriddenByDevice
                    ? `replaced an edit from ${result.overriddenByDevice}`
                    : "replaced a newer edit"
                  : result.error;
              await syncLogAppend({ ts: Date.now(), label: intentLabel(intent), status, detail }).catch(() => {});
              applied++;
            } else {
              await outboxPut({
                ...intent,
                status: "needs-attention",
                lastError: result.error,
                lastErrorCode: result.code,
                conflict: result.conflict,
              });
              const detail = result.error ?? SYNC_LOG_DETAIL[result.code];
              await syncLogAppend({ ts: Date.now(), label: intentLabel(intent), status: "needs-attention", detail }).catch(() => {});
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
      const validationError = VALIDATORS[kind]?.(payload);
      if (validationError) return { ok: false, error: validationError };

      const deviceId = deviceIdRef.current ?? (await ensureDeviceId().catch(() => null));
      // no IndexedDB (private mode) → plain direct call, no offline tolerance
      // possible either way — still carries an ephemeral intent (see
      // ephemeralIntent's comment) so this create isn't invisible to a later
      // conflict check on the SAME entity
      if (!deviceId) return ACTIONS[kind]({ ...payload, intent: ephemeralIntent() });
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

  // Phase 3 (spec §17): edit/delete of an already-synced entity. At most one
  // outstanding intent per entityId — a second mutation before the first has
  // drained coalesces into it (same intentId, kind can change: e.g. a delete
  // arriving while an edit is still queued supersedes it), never stacking a
  // second intent, exactly like editPending() already does for pending creates.
  const enqueueMutation = useCallback(
    async (
      kind: MutationKind,
      entityId: string,
      payload: Record<string, unknown>,
      baseVersion: number,
      groupName?: string
    ): Promise<ActionResult & { queued?: boolean; intentId?: string }> => {
      if (kind !== "tx.delete") {
        const validationError = VALIDATORS[kind]?.(payload);
        if (validationError) return { ok: false, error: validationError };
      }

      const deviceId = deviceIdRef.current ?? (await ensureDeviceId().catch(() => null));
      if (!deviceId) return directMutationFallback(kind, entityId, payload, baseVersion); // no IndexedDB → plain direct call
      deviceIdRef.current = deviceId;
      const deviceName = await getDeviceName().catch(() => undefined);

      const existing = (await outboxList(userId)).find((i) => i.entityId === entityId);
      const intent: OutboxIntent = existing
        ? {
            ...existing,
            kind,
            payload,
            baseVersion: existing.baseVersion ?? baseVersion, // keep the ORIGINAL reference version — that's still what this device last actually saw
            groupName: groupName ?? existing.groupName,
            clientTs: new Date().toISOString(),
            status: "pending",
            attempts: 0,
            nextRetryAt: undefined,
            firstFailedAt: undefined,
            lastError: undefined,
            lastErrorCode: undefined,
            conflict: undefined,
          }
        : {
            intentId: crypto.randomUUID(),
            seq: nextSeq(),
            userId,
            deviceId,
            deviceName,
            groupName,
            kind,
            payload,
            entityId,
            baseVersion,
            clientTs: new Date().toISOString(),
            status: "pending",
            attempts: 0,
          };

      await outboxPut(intent);
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        await syncLogAppend({ ts: Date.now(), label: intentLabel(intent), status: "offline" }).catch(() => {});
      }
      await reload();
      setTimeout(() => void drain(), 0);
      return { ok: true, queued: true, intentId: intent.intentId };
    },
    [userId, reload, drain]
  );

  const editPending = useCallback(
    async (intentId: string, payload: Record<string, unknown>): Promise<ActionResult> => {
      const list = await outboxList(userId);
      const existing = list.find((i) => i.intentId === intentId);
      if (!existing) return { ok: false, error: "This item already synced or was removed." };
      const validationError = VALIDATORS[existing.kind as OutboxKind]?.(payload);
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
      await outboxPut({ ...intent, status: "pending", attempts: 0, nextRetryAt: undefined, firstFailedAt: undefined, lastError: undefined, lastErrorCode: undefined });
    }
    await reload();
    void drain();
  }, [userId, reload, drain]);

  const syncNow = useCallback(async () => {
    await drain();
  }, [drain]);

  // collaboration-architecture-rfc §7: [Keep mine] requeues the SAME intent
  // against the server's current version (as of the conflict) — no new
  // server-side apply logic needed (§7's own framing): if nothing else has
  // changed by the time this drains, baseVersion now equals the server's
  // version and it just applies like any other clean update. If a THIRD
  // edit landed in the interim, the client correctly sees another conflict
  // rather than silently clobbering it — this is a real, human-confirmed
  // decision each time, not a blind retry loop.
  const resolveConflictKeepMine = useCallback(
    async (intentId: string): Promise<void> => {
      const list = await outboxList(userId);
      const existing = list.find((i) => i.intentId === intentId);
      if (!existing?.conflict) return;
      await outboxPut({
        ...existing,
        baseVersion: existing.conflict.serverVersion,
        status: "pending",
        attempts: 0,
        nextRetryAt: undefined,
        firstFailedAt: undefined,
        lastError: undefined,
        lastErrorCode: undefined,
        conflict: undefined,
      });
      await reload();
      void drain();
    },
    [userId, reload, drain]
  );

  // [Keep theirs]: discard the pending intent locally — the server's current
  // state already reflects "theirs," so no server call is needed (§7).
  const resolveConflictKeepTheirs = useCallback(
    async (intentId: string): Promise<void> => {
      const list = await outboxList(userId);
      const existing = list.find((i) => i.intentId === intentId);
      if (!existing) return;
      await outboxRemove(intentId);
      await syncLogAppend({ ts: Date.now(), label: intentLabel(existing), status: "cancelled", detail: "kept the other person's edit" }).catch(() => {});
      await reload();
    },
    [userId, reload]
  );

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
    <Ctx.Provider
      value={{
        pending,
        needsAttention,
        lastSyncAt,
        authExpired,
        createViaOutbox,
        enqueueMutation,
        syncNow,
        editPending,
        cancelPending,
        restorePending,
        retryFailed,
        resolveConflictKeepMine,
        resolveConflictKeepTheirs,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
