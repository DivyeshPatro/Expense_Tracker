# ADR 0003 — Why `LoanEntry` stayed a flat event log

## Context

The Lending module needs to represent two kinds of event between the user
and a contact: money the user gave them (a loan) and money the user got
back (a repayment — or, symmetrically, money the user borrowed and later
repaid). See [`lending.md`](../lending.md) for the full model.

## Problem

Modeling "a loan" can go two structurally different ways: a single mutable
row per loan whose status field changes as repayments happen ("open" →
"partially settled" → "settled"), or a flat log of discrete events with no
row ever representing "the loan" as a stateful object.

## Alternatives considered

1. **A stateful `Loan` model**, one row per loan, with a `status` enum and
   a `remainingAmount` column mutated on every repayment. Familiar
   (mirrors how a bank statement UI often reads), but conflates "the fact
   that money moved" with "the current derived state of a relationship" —
   the latter changes shape the moment partial/multiple repayments,
   re-allocation, or manual settlement-picking exist.
2. **A double-entry accounting ledger.** More rigorous, but far heavier
   than what a personal lending tracker between friends needs, and a
   mismatch with the rest of the app's single-entry `Transaction` model.
3. **A flat, kind-discriminated event log — `LoanEntry { kind: GAVE | GOT,
   amount, occurredAt, ... }` — structurally identical whether recording a
   fresh loan or a repayment, with settlement state derived separately.**
   Chosen.

## Decision

`LoanEntry` has no status field and is never "the loan" as a singular
object — it's one event. A GAVE entry and a GOT entry are the same shape;
what connects a repayment to the loan(s) it pays off is a separate,
additive join (`LoanAllocation` — see
[`0004-loanallocation-additive.md`](0004-loanallocation-additive.md)), and
settlement status is always computed from that join, never stored on
`LoanEntry` itself (see
[`0006-derived-financial-metrics.md`](0006-derived-financial-metrics.md)).

This mirrors the existing `Transaction` model's own philosophy — an
expense and an income row are structurally identical (signed by `type`,
not by being different tables) — and the sign convention
(`computeLoanBalances`'s Σ GAVE − Σ GOT, positive ⇒ they owe you) directly
reuses `netBalances()`'s existing convention from shared expenses.

## Consequences

- The same list/edit/delete UI, the same offline-sync machinery
  (`version`, soft-delete, `exactlyOnce`) already built for `Transaction`
  applies to `LoanEntry` with no new conceptual model to design or test.
- A "loan" as a user-facing concept is always a *view* — one GAVE entry
  plus whatever `LoanAllocation` rows reference it — never a row you can
  query directly and trust.
- Changing settlement logic (e.g. adding a new allocation strategy) never
  requires a schema migration on `LoanEntry`, because it never held
  settlement state to begin with.
