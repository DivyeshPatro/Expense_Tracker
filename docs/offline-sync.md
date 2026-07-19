# Offline Sync

Ledgerly never prevents you from recording a financial event, connectivity
or not. This document explains the mechanism that makes that true: the
Universal Outbox, the server's Intent-based idempotency ledger, the sync
protocol between them, and what happens when two writers disagree.

For *why* this exists at all, see
[ADR 0001](adr/0001-offline-first.md) and
[ADR 0002](adr/0002-universal-outbox.md). For the full original design
reasoning (including UX copy decisions and a six-months-later risk
analysis), see [`project/offline-sync-spec.md`](../project/offline-sync-spec.md)
— this document describes what's actually built today, which in a couple
of places is narrower than that spec's original ambition; those gaps are
called out explicitly below rather than glossed over.

## The core guarantee

**The server is the sole canonical ledger.** The client never runs a
second implementation of balance math — it queues *intent* ("I spent
₹420 at Swiggy") and displays it optimistically, but the number that
actually counts is always computed server-side, in the same
`$transaction` reverse-apply path every write has always used. Offline
sync adds a durable queue and a conflict protocol around that path; it
never duplicates it.

## System overview

```
┌─────────────────────────────── CLIENT ────────────────────────────────┐
│                                                                        │
│   UI action ──► enqueueMutation() ──► outbox (IndexedDB)              │
│                                          │  strict FIFO per device    │
│                                          ▼                            │
│                                     drain loop                        │
│                    triggers: mount · 'online' · tab focus · 30s poll  │
│                                          │                            │
└──────────────────────────────────────────┼────────────────────────────┘
                                            │  POST /api/sync (batched,
                                            │  cookie auth, ordered array)
                                            ▼
┌─────────────────────────────── SERVER ─────────────────────────────────┐
│  applyOne(intent) per item, in order:                                  │
│    zod validate → assertCanWrite/assertCanRead → checkOverride →       │
│    $transaction [ Intent row insert (idempotency) →                    │
│                    reverse old balances → apply →                      │
│                    audit(actorUserId, intentId, deviceId, clientTs) ]  │
│  → per-intent result code (§ Result codes below)                       │
└──────────────────────────────────────────┬─────────────────────────────┘
                                            ▼
                                   PostgreSQL (the split-sum
                                   trigger is the final arbiter)
```

The read path is unchanged: after a drain applies at least one intent,
the client calls `router.refresh()` — the existing Server Component read
model *is* the pull side of sync. There is no separate "sync down" API.

## The Intent table — server-side idempotency

```prisma
model Intent {
  id         String   // intentId, client-generated (uuid v4)
  userId     String
  deviceId   String
  kind       String   // "expense.create" | "loan.update" | ...
  entityId   String
  status     String   // applied | overridden | failed
  clientTs   DateTime
  appliedAt  DateTime @default(now())
  @@id([userId, id])
}
```

Every mutating write inserts its Intent row **inside the same database
transaction** as the actual balance/ledger change. A unique-constraint
violation on `(userId, id)` means this exact intent already applied —
the handler returns the *recorded* outcome without touching the ledger
again. This is what makes replaying an intent (a network retry, a
duplicate drain after a crash) safe: **at-least-once delivery from the
client becomes exactly-once effect on the ledger**, for free, using
Postgres's own constraint as the lock.

> **Known gap:** the spec calls for a 30-day retention/pruning cron on
> this table (`Intent(userId, appliedAt)` index is provisioned for it).
> That cron does not exist. Intent rows currently accumulate indefinitely
> except when a user deletes their entire account
> (`data-management.ts`'s `deleteUserAccount`, which does
> `db.intent.deleteMany({ where: { userId } })`). This is a real, open
> item — see [`docs/adr`](adr/) if a decision is made to build it, and
> note it changes `STALE_INTENT` semantics (see below) if implemented
> exactly as originally spec'd, since pruning an Intent row an active
> conflict check still needs would reopen the actor-attribution bug
> [ADR 0008](adr/0008-lww-conflict-resolution.md) closed.

## The client outbox (IndexedDB, `src/lib/offline/db.ts`)

Database `ledgerly`, three object stores:

| Store | Key | Purpose |
|---|---|---|
| `outbox` | `intentId` | queued mutations, FIFO via a `seq` index |
| `syncLog` | autoincrement | 200-entry ring buffer feeding the Sync Center's activity feed (local-only, never synced) |
| `meta` | fixed keys | `deviceId`, `deviceName` (UA-derived), `deviceAddedAt` |

`enqueueMutation(kind, entityId, payload, baseVersion)` — the one entry
point every mutating UI surface uses instead of calling a server action
directly (this is the "Universal" in Universal Outbox; see
[ADR 0002](adr/0002-universal-outbox.md)):

- Validates the payload against a per-kind zod schema.
- **Coalesces** with any existing queued intent for the same `entityId`:
  a second edit before the first has drained reuses the same `intentId`
  and keeps the *original* `baseVersion` (not the newer one) — one
  server mutation results, not two. A delete queued behind a pending edit
  overwrites that intent's `kind` to `tx.delete` in place.
- If IndexedDB is unavailable (private browsing), falls back to calling
  the server action directly with an ephemeral, non-persisted intent
  object — still attached so a *later* conflict check on the same entity
  doesn't misattribute the write (see `directMutationFallback`).

## The drain loop

Fires on: initial mount (so a queue left behind by a killed tab drains on
reopen), the browser's `online` event, the tab becoming visible again,
and a 30-second poll (only actually drains if the queue is non-empty).
Every `enqueueMutation` also schedules an immediate drain.

Processes the whole batch as one ordered POST to `/api/sync` — strict
FIFO, applied server-side in array order, one result per intent.

## Sync result codes

| Code | Meaning | Client behavior |
|---|---|---|
| `OK` | applied cleanly | remove from outbox |
| `OK_OVERRIDE` | applied, overwrote a stale version from the *same actor* (solo LWW) | remove from outbox, log "replaced an edit from {device}" |
| `CONFLICT` | version mismatch from a *different* authorized actor | park as needs-attention; client renders both versions, offers **Keep mine** / **Keep theirs** — see [ADR 0008](adr/0008-lww-conflict-resolution.md) |
| `INVALID_REF_SOFT` | the referenced category was deleted elsewhere | server auto-heals (`categoryId = null`) and applies anyway; client shows a soft notice |
| `INVALID_REF_HARD` | the referenced account no longer exists | needs-attention, guided fix |
| `NOT_AUTHORIZED` | the actor was removed from the transaction's group since queuing | needs-attention, discard-only |
| `GROUP_DELETED` | the transaction's group was deleted since queuing (FK `onDelete: SetNull` already orphaned the row) | needs-attention, "keep as personal" or discard |
| `STALE_INTENT` | queued longer than 30 days | needs-attention, "review and re-add" |
| `VALIDATION` | zod rejection, deleted target row, or an unexpected server error | needs-attention (error text is sanitized — see the security section of [`architecture.md`](architecture.md)) |

Two codes described in the original spec are **not** wire-level codes in
the actual implementation, worth knowing if you're reading the code
alongside this doc:

- **`DUPLICATE`** isn't returned as its own code. A replayed intent that
  already applied resolves to the *recorded* prior outcome — `OK` or
  `OK_OVERRIDE` — via the same Intent-table lookup described above. It's
  a philosophy ("replays are safe"), not a distinct branch the client
  handles.
- **`AUTH_EXPIRED`** is a top-level HTTP 401 on the whole `/api/sync`
  request (session gone), not a per-intent result. The client checks
  `res.status === 401`, holds the entire queue, and prompts sign-in.

`RETRYABLE` is purely a client-side inference: it's what the client
labels a whole-batch transport failure (network error, non-2xx before a
JSON body is even parsed) — the server never returns this string.

## Retry, backoff, and poison-pill parking

A transport-level failure (not a per-intent result — a failure to reach
the server at all) triggers exponential backoff: `1s × 2ⁿ`, capped at 5
minutes. If the *head* of the FIFO queue — nothing behind it is even
attempted — has failed **20 times or for 24 hours, whichever comes
first**, it's parked as needs-attention with a generic "couldn't sync
after repeated attempts" message, so one permanently-erroring intent
can't block a user's queue forever.

Needs-attention items block only *later intents for the same entity*;
everything else keeps draining.

## Conflict resolution

See [ADR 0008](adr/0008-lww-conflict-resolution.md) for the reasoning.
Mechanically: `checkOverride` (`src/server/services/transactions.ts`)
looks up the most recent `Intent` row for the entity being written
(actor-aware — it does **not** filter by the current actor's own
`userId`, a fix made specifically so it can see a *different* person's
prior edit) and compares that intent's actor to the incoming write's:

- **Same actor, any device** → apply silently (`OK_OVERRIDE`), both
  versions kept in the audit log.
- **Different actor, on a group-shared transaction** → `CONFLICT`,
  nothing is written, both versions surface to the user.

Field-level merge (both people's non-overlapping edits both surviving)
is explicitly not built — whole-record last-write-wins/conflict is the
deliberately simpler choice, revisited only if measured conflict rates
justify it.

## Transaction status lifecycle

```
submit ──► pending ──► syncing ──► synced (terminal — badge fades, absence is the signal)
            ▲             │
   edit ─────┘             ├─ transport failure ──► pending (backoff, retries)
  (coalesces in place)     ├─ 20 attempts / 24h ──► needs attention
   delete = cancelled       └─ server rejects ─────► needs attention (or auto-heals)
   (undoable 5s)
```

A synced ledger shows **zero** sync chrome by design — a persistent
checkmark on every row would teach users to ignore the one badge that
actually matters.

## What's not built (honest gaps, not silently omitted)

- **Intent pruning cron** — see above.
- **Background Sync API.** `public/sw.js` is intentionally thin: it
  precaches the app shell and serves an offline fallback page for
  navigation — it does **not** register a `sync` event or attempt any
  background drain. The entire drain mechanism lives in the foreground
  React app (timers and event listeners in `offline-context.tsx`). If a
  tab is closed while offline, nothing resumes sync until the app is
  reopened — the mount-time drain call is what compensates for that.
  This is a materially narrower scope than the original spec's
  Background-Sync ambition; it's accurate to describe the current build
  as "foreground-ladder only."
- **Offline reading** (cached snapshots for browsing data with no
  connection) — not built. The outbox covers writes only.
- **Push notifications** for needs-attention items — not built; in-app
  only today.

## Where this shows up in the product

| Surface | Component |
|---|---|
| Transaction rows / detail sheet | pending badge, conflict card | `src/components/shell/transaction-detail.tsx` |
| Sync Center (`/settings/sync`) | full queue view, device identity, export log | `src/app/(app)/settings/sync/sync-center.tsx` |
| Dashboard | offline chip, needs-attention feed entry | `src/components/dashboard/notification-center.tsx` |
| Dev-only diagnostic | queue/intent health readout | `src/components/shell/offline-debug.tsx` |

## Multi-writer collaboration

Once a transaction is tagged with a `groupId`, more than one real person
can author writes against it. See [`shared-expenses.md`](shared-expenses.md)
for the authorization model this sync layer builds on top of, and
[ADR 0008](adr/0008-lww-conflict-resolution.md) for how conflicts between
different people are resolved.
