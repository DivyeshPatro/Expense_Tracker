// Offline-sync client store (offline-sync-spec §4.1) — Phase 0 skeleton.
// Hand-rolled promise wrapper over IndexedDB (no dependency, per the spec's
// budget): an `outbox` store for intents and a `meta` store for device
// identity. Phase 0 ships the plumbing only — nothing enqueues yet, and the
// flag below stays off until Phase 1 lands the drain loop and sync UI.

export const OUTBOX_ENABLED = false; // flipped by offline-sync Phase 1

const DB_NAME = "ledgerly";
const DB_VERSION = 1; // bump + migrate in onupgradeneeded when stores change (spec §4.1 "schemaVersion")

export interface OutboxIntent {
  intentId: string; // uuid v4 — server idempotency key
  seq?: number; // autoincrement, FIFO order
  userId: string; // outbox is never adopted by a different user (spec §15)
  deviceId: string;
  kind: string; // "expense.create" | ...
  payload: unknown; // exact zod input of the corresponding server action
  entityId: string;
  baseVersion?: number; // update/delete only
  clientTs: string;
  status: "pending" | "syncing" | "needs-attention";
  attempts: number;
  nextRetryAt?: string;
  lastError?: string;
}

interface MetaRecord {
  key: string;
  value: string;
}

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

async function withStore<T>(store: "outbox" | "meta", mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
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
  await metaSet("schemaVersion", String(DB_VERSION));
  return id;
}

function defaultDeviceName(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const browser = ua.includes("Edg/") ? "Edge" : ua.includes("Chrome") ? "Chrome" : ua.includes("Safari") ? "Safari" : ua.includes("Firefox") ? "Firefox" : "Browser";
  const os = ua.includes("Windows") ? "Windows" : ua.includes("Mac") ? "Mac" : ua.includes("Android") ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone" : "device";
  return `${browser} on ${os}`;
}

export async function outboxCount(): Promise<number> {
  return withStore("outbox", "readonly", (s) => s.count());
}
