// Offline-sync client store (offline-sync-spec §4.1). Hand-rolled promise
// wrapper over IndexedDB (no dependency, per the spec's budget): an `outbox`
// store for intents, a `syncLog` ring buffer for the Sync Center activity
// feed, and a `meta` store for device identity. Phase 1 turned the outbox
// on: solo creates queue when the network is gone and drain automatically
// (see offline-context.tsx for the ladder). Phase 2 made write-behind
// universal and added the syncLog.

export const OUTBOX_ENABLED = true; // Phase 1 (offline-sync-spec §17)

const DB_NAME = "ledgerly";
const DB_VERSION = 2; // bump + migrate in onupgradeneeded when stores change (spec §4.1 "schemaVersion")
const SYNC_LOG_CAP = 200; // spec §4.1 "ring buffer, max 200 entries"

/** collaboration-architecture-rfc §7: mirrors the server's ConflictSnapshot —
 * kept as a plain duplicate type (not imported from server code) since this
 * file runs in the browser. */
export interface ConflictSnapshot {
  serverVersion: number;
  serverActorName: string;
  serverUpdatedAt: string;
  amount: number;
  merchant: string;
  categoryName: string | null;
  ymd: string;
  notes: string | null;
}

export interface OutboxIntent {
  intentId: string; // uuid v4 — server idempotency key
  seq?: number; // autoincrement, FIFO order
  userId: string; // outbox is never adopted by a different user (spec §15)
  deviceId: string;
  deviceName?: string; // Phase 3: update/delete only — surfaced in OK_OVERRIDE copy (spec §13)
  kind: string; // "expense.create" | ...
  payload: unknown; // exact zod input of the corresponding server action (delete: a small {amount, merchant} display snapshot only)
  entityId: string;
  baseVersion?: number; // Phase 3: update/delete only — entity version last seen locally (spec §4.1)
  clientTs: string;
  status: "pending" | "syncing" | "needs-attention";
  attempts: number;
  nextRetryAt?: string;
  firstFailedAt?: string; // Phase 3: poison-pill parking clock — set on the first RETRYABLE failure, distinct from clientTs (which moves on every coalesced edit)
  lastError?: string;
  lastErrorCode?: string; // taxonomy code from /api/sync (spec §5) — drives copy + retry-eligibility
  // collaboration-architecture-rfc migration step 5 — collaborative edits only:
  conflict?: ConflictSnapshot; // set when lastErrorCode === "CONFLICT" (§7) — drives the conflict card
  groupName?: string; // remembered at enqueue time (§8) — the transaction's server-side groupId may already be null (orphaned/removed) by the time a NOT_AUTHORIZED/GROUP_DELETED failure needs to explain why, so this can't be re-read from the entity at parking time
}

interface MetaRecord {
  key: string;
  value: string;
}

/** One entry in the Sync Center activity feed (spec §4.1, §8). Local-only, never synced. */
export interface SyncLogEntry {
  id?: number; // autoincrement
  ts: number; // epoch ms
  label: string; // "₹420 · Swiggy"
  status: "synced" | "healed" | "needs-attention" | "offline" | "cancelled" | "overridden";
  detail?: string;
}

type StoreName = "outbox" | "meta" | "syncLog";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("outbox")) {
        const outbox = db.createObjectStore("outbox", { keyPath: "intentId" });
        outbox.createIndex("bySeq", "seq", { unique: false });
        outbox.createIndex("byStatus", "status", { unique: false });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("syncLog")) {
        const log = db.createObjectStore("syncLog", { keyPath: "id", autoIncrement: true });
        log.createIndex("byTs", "ts", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await requestToPromise(fn(db.transaction(store, mode).objectStore(store)));
  } finally {
    db.close();
  }
}

async function metaGet(key: string): Promise<string | undefined> {
  const rec = await withStore<MetaRecord | undefined>("meta", "readonly", (s) => s.get(key) as IDBRequest<MetaRecord | undefined>);
  return rec?.value;
}

async function metaSet(key: string, value: string): Promise<void> {
  await withStore("meta", "readwrite", (s) => s.put({ key, value }));
}

/** Stable per-install identity (spec §4.1 `meta`): created on first call,
 * shown on intents and (later) in conflict copy as a friendly device name. */
export async function ensureDeviceId(): Promise<string> {
  const existing = await metaGet("deviceId");
  if (existing) return existing;
  const id = crypto.randomUUID();
  await metaSet("deviceId", id);
  await metaSet("deviceName", defaultDeviceName());
  await metaSet("deviceAddedAt", new Date().toISOString());
  await metaSet("schemaVersion", String(DB_VERSION));
  return id;
}

export async function getDeviceName(): Promise<string | undefined> {
  return metaGet("deviceName");
}

export async function getDeviceAddedAt(): Promise<string | undefined> {
  return metaGet("deviceAddedAt");
}

function defaultDeviceName(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const browser = ua.includes("Edg/") ? "Edge" : ua.includes("Chrome") ? "Chrome" : ua.includes("Safari") ? "Safari" : ua.includes("Firefox") ? "Firefox" : "Browser";
  const os = ua.includes("Windows") ? "Windows" : ua.includes("Mac") ? "Mac" : ua.includes("Android") ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone" : "device";
  return `${browser} on ${os}`;
}

// ─────────── outbox operations (Phase 1) ───────────

let seqTiebreak = 0;

/** Monotonic-enough FIFO key: wall clock + in-session tiebreak. */
export function nextSeq(): number {
  return Date.now() * 100 + (seqTiebreak = (seqTiebreak + 1) % 100);
}

export async function outboxPut(intent: OutboxIntent): Promise<void> {
  await withStore("outbox", "readwrite", (s) => s.put(intent));
}

export async function outboxRemove(intentId: string): Promise<void> {
  await withStore("outbox", "readwrite", (s) => s.delete(intentId));
}

export async function outboxList(userId: string): Promise<OutboxIntent[]> {
  const all = await withStore<OutboxIntent[]>("outbox", "readonly", (s) => s.getAll() as IDBRequest<OutboxIntent[]>);
  // outbox is never adopted by a different user (spec §15)
  return all.filter((i) => i.userId === userId).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

export async function getLastSyncAt(): Promise<string | undefined> {
  return metaGet("lastSyncAt");
}

export async function setLastSyncAt(iso: string): Promise<void> {
  await metaSet("lastSyncAt", iso);
}

// ─────────── provisional display math (spec §8: bounded paise addition ONLY,
// display-only, recomputed per render, never persisted) ───────────

/** Effect of one pending create on the TOTAL balance, in paise. Transfers
 * net to zero at the total level; friend-paid split expenses are out of
 * Phase-1 scope (solo creates only). Payload amounts are the raw form
 * values — rupee strings — exactly as the server action will parse them. */
export function pendingDeltaPaise(intent: Pick<OutboxIntent, "kind" | "payload">): number {
  const p = (intent.payload ?? {}) as { amount?: unknown };
  const rupees = Number(typeof p.amount === "string" || typeof p.amount === "number" ? p.amount : NaN);
  if (!Number.isFinite(rupees)) return 0;
  const paise = Math.round(rupees * 100);
  if (intent.kind === "expense.create") return -paise;
  if (intent.kind === "income.create") return paise;
  return 0; // transfer.create: −from +to nets to zero on the total
}

export function pendingTotalDelta(intents: Pick<OutboxIntent, "kind" | "payload">[]): number {
  return intents.reduce((sum, i) => sum + pendingDeltaPaise(i), 0);
}

// ─────────── syncLog: Sync Center activity feed (spec §4.1, §8) ───────────

export async function syncLogAppend(entry: Omit<SyncLogEntry, "id">): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("syncLog", "readwrite");
      const store = tx.objectStore("syncLog");
      store.add(entry);
      // ring buffer: trim oldest once over cap, in the same transaction
      const countReq = store.count();
      countReq.onsuccess = () => {
        const over = countReq.result - SYNC_LOG_CAP;
        if (over > 0) {
          const cursorReq = store.index("byTs").openCursor();
          let deleted = 0;
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor && deleted < over) {
              cursor.delete();
              deleted++;
              cursor.continue();
            }
          };
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function syncLogList(limit = SYNC_LOG_CAP): Promise<SyncLogEntry[]> {
  const all = await withStore<SyncLogEntry[]>("syncLog", "readonly", (s) => s.getAll() as IDBRequest<SyncLogEntry[]>);
  return all.sort((a, b) => b.ts - a.ts).slice(0, limit);
}
