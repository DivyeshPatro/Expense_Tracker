# ADR 0006 — Why settlement status is derived, never stored

## Context

A loan's "remaining balance," "settled amount," and status
(`OPEN`/`PARTIAL`/`SETTLED`/`OVERDUE`) all depend on the sum of its
`LoanAllocation` rows, which changes whenever a repayment is added,
deleted, or reallocated (see
[`0004-loanallocation-additive.md`](0004-loanallocation-additive.md)).

## Problem

Storing these as columns on `LoanEntry` means every allocation write must
remember to also update the cached fields on every loan it touches — a
well-understood class of bug (cache invalidation), and an unusually
dangerous one in a financial ledger: a stale `settled` flag could hide
real outstanding debt, or a stale `remaining` amount could let a second
repayment double-count against an already-settled loan.

Ledgerly already has a live example of exactly this failure mode:
`Account.balance` **is** a stored, cached value (updated alongside every
transaction write), and the app runs a dedicated daily reconciliation job
(`reconcileAll`) specifically because that cached balance *can* drift
from the ledger and needs a standing check to catch it.

## Alternatives considered

1. **Store `settledAmount`/`status` as columns on `LoanEntry`, updated
   transactionally alongside every allocation write** — mirrors
   `Account.balance`'s existing pattern, including its existing failure
   mode and the reconciliation job it requires.
2. **Compute them on read, every time, from the `LoanAllocation` rows
   that actually exist.** Chosen.

## Decision

`computeLoanStatus()` (`src/lib/loan-settlement.ts`) and the shared
loaders in `src/server/services/lending.ts`
(`allGaveEntriesData`, `lendingBalances`) always derive
settled/remaining/status from summing `LoanAllocation` rows against the
`LoanEntry.amount` at read time. No column on `LoanEntry` stores any of
this.

## Consequences

- Correctness is structural: there is no cached copy to drift, so the
  class of bug `reconcileAll` exists to catch on the `Account` side
  simply cannot occur here.
- Costs an aggregation per read instead of a column read — mitigated by
  wrapping the shared loaders in React's `cache()` so a single request
  rendering multiple lending surfaces (Card Recovery, Reminders, Reports)
  computes the underlying allocation sums once, not once per surface (see
  [`finance-hub.md`](../finance-hub.md) and
  [`lending.md`](../lending.md)).
- Report-level aggregates (e.g. `lendingReportsData`'s all-time recovery
  rate) push the summation into a Postgres `groupBy` rather than pulling
  every row into Node — same derive-don't-store principle, applied at the
  database layer instead of the application layer.
