# ADR 0002 — Why the Universal Outbox exists

## Context

Once offline writes are allowed at all (see
[`0001-offline-first.md`](0001-offline-first.md)), every mutating action in
the app — not just "add expense" — needs a durable local record that
survives a killed tab and is guaranteed to eventually reach the server
exactly once.

## Problem

The obvious incremental path is to make each feature offline-capable one at
a time: a local queue for expenses, then a separate one for loan entries,
then settlements. Each of those queues would need its own retry policy,
its own backoff, its own idempotency handling, and its own drain triggers —
logic that has nothing to do with the feature itself but would be
rewritten (and could silently diverge) per feature.

## Alternatives considered

1. **Per-feature local queues.** Rejected — duplicates retry/backoff/
   idempotency logic per mutation kind, and a bug fixed in one queue
   wouldn't be fixed in the others.
2. **A generic, universal outbox: one IndexedDB store, one drain loop, one
   retry/backoff policy, applied to every mutating action via a single
   `enqueueMutation` entry point.** Chosen.

## Decision

`src/lib/offline/db.ts` defines one `outbox` object store (keyed by
`intentId`) and `src/components/shell/offline-context.tsx` exposes one
`enqueueMutation(kind, entityId, payload, baseVersion)` call that every
mutating UI surface uses instead of calling a server action directly. A
single drain loop (mount, `online`, tab-visible, and a 30s poll — see
[`offline-sync.md`](../offline-sync.md)) processes the whole queue in
strict FIFO order, and the server's `Intent` table (keyed
`(userId, intentId)`) is the single idempotency ledger every replayed
intent checks against, regardless of what kind of mutation it is.

## Consequences

- A new mutating feature gets offline support "for free" the moment it's
  routed through `enqueueMutation` and given a `MutationKind` — no new
  queue, no new retry logic.
- Ordering (FIFO) and poison-pill parking (24h / 20 attempts) are enforced
  once, centrally, instead of per feature.
- The tradeoff is a generic queue is less specialized: every payload is an
  opaque JSON blob validated by a per-kind zod schema (`VALIDATORS[kind]`)
  rather than a typed queue per feature — acceptable, since validation
  still happens before enqueue and again server-side.
- The outbox's scope is intentionally narrower than a full offline-first
  framework: it's a write queue only. Offline *reading* (cached snapshots
  for browsing data with no connection) is a separate, not-yet-built
  concern — see [`offline-sync.md`](../offline-sync.md)'s "what's not built"
  section.
