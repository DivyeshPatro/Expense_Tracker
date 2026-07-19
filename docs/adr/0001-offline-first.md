# ADR 0001 — Why Ledgerly is offline-first

## Context

Ledgerly is a personal finance app whose core job is capturing a financial
event — an expense, a loan given to a friend — at the moment it happens. That
moment is frequently offline: paying an auto-rickshaw driver with no signal,
splitting a restaurant bill in a basement, recording a loan on a flight.

## Problem

A finance app that requires connectivity to log an expense fails at exactly
the moment it matters most. The failure mode isn't a spinner — it's a user
who gives up and never records the expense at all, which defeats the entire
product. A ledger with gaps in it is worse than no ledger, because it's
silently wrong.

## Alternatives considered

1. **Online-only, fail with a retry prompt.** Simplest to build. Rejected —
   this is the exact failure mode above.
2. **Client-side "provisional" tracking with manual export/import.** Puts
   the burden of reconciliation on the user. Rejected — reintroduces the
   multi-app-sync problem Ledgerly exists to eliminate (see the project's
   own framing: "Splitwise + Google Finance + ... but as one system instead
   of five apps").
3. **Full offline-first: durable local queue, automatic background sync,
   server remains the sole canonical ledger.** Chosen.

## Decision

Every mutating action queues locally first and is guaranteed to eventually
reach the server — see [`0002-universal-outbox.md`](0002-universal-outbox.md)
for the mechanism. The server is never bypassed as the source of truth: no
second implementation of balance math exists on the client, only bounded
provisional arithmetic for display (see [`offline-sync.md`](../offline-sync.md)).

## Consequences

- Real, ongoing engineering cost: an IndexedDB outbox, a drain/retry
  protocol, idempotency keys, and (once collaboration existed) conflict
  resolution — see [`0008-lww-conflict-resolution.md`](0008-lww-conflict-resolution.md).
- In exchange, the single biggest reliability failure mode for a
  finance-logging app — "I couldn't log it, so I forgot" — is structurally
  eliminated rather than mitigated with a retry button.
- The server-canonical rule bounds the blast radius of any client-side bug:
  the client can be wrong about what's *pending*, never about what's *true*.
