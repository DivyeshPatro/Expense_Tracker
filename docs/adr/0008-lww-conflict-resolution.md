# ADR 0008 — Why last-write-wins (with actor-aware escalation) was chosen for conflicts

## Context

Once collaboration allows two different real people to edit the same
group-shared transaction, and offline sync allows edits to arrive out of
order relative to when they were made, the system needs a rule for what
happens when two versions of the same record genuinely conflict — see
[`offline-sync.md`](../offline-sync.md) and
[`shared-expenses.md`](../shared-expenses.md).

## Problem

The rule has to satisfy two different situations that look identical at
the data layer (a version mismatch) but are completely different in
practice:

1. The overwhelmingly common case — the **same person**, editing from
   their phone, then their laptop. This isn't a conflict at all; asking
   them to arbitrate against themselves is pure friction.
2. The rare but serious case — **two different people**, both authorized,
   both editing the same shared transaction. Silently discarding one
   person's real edit with no signal is a trust-destroying failure mode
   for a shared financial ledger.

## Alternatives considered

1. **Global last-write-wins for everyone, always.** Rejected — silently
   discards a different person's real edit with no signal. Unacceptable
   once the record is genuinely shared.
2. **Always block and ask a human, even for the same person's own two
   devices.** Rejected — adds friction to the by-far-most-common case for
   no benefit; the "conflict" isn't real.
3. **Actor-aware hybrid: same actor → silent last-write-wins; different
   actor → block and surface a real conflict.** Chosen.

## Decision

`checkOverride` (`src/server/services/transactions.ts`) looks up the most
recent `Intent` row for the entity being written and compares its actor
to the incoming write's actor:

- **Same actor** (any device) → apply silently, last-write-wins
  (`OK_OVERRIDE`), both versions kept in the audit log. No prompt.
- **Different, both-currently-authorized actors** → reject the write
  (`CONFLICT`); the client shows both versions side by side and the human
  picks **Keep mine** or **Keep theirs**.

This required making the Intent lookup actor-aware — it originally
filtered by the current actor's own `userId`, which meant it could never
see a different person's prior edit at all (see
[`offline-sync.md`](../offline-sync.md) for the mechanism).

## Consequences

- Zero friction for the common case: solo multi-device sync stays exactly
  as invisible as it was before collaboration existed.
- Real, visible conflict resolution for genuine collaboration — nothing
  is ever silently discarded once a second real person is involved.
- **Field-level merge** (both people's non-overlapping edits both
  surviving — e.g. one person changed the amount, the other changed a
  note) was explicitly deferred rather than built speculatively.
  Whole-record LWW/conflict is deliberately the simpler choice; a merge
  algorithm is revisited only if real, measured conflict rates justify
  the added complexity.
