# ADR 0005 — Why FIFO was chosen for automatic settlement

## Context

Most repayments don't specify which loan they're paying off — someone just
says "I paid you back ₹2,000." When a contact has more than one
outstanding loan, the system needs a deterministic default rule for how
that repayment gets allocated across them (see
[`lending.md`](../lending.md) and
[`0004-loanallocation-additive.md`](0004-loanallocation-additive.md)).

## Problem

Without an explicit choice from the user, *some* rule must decide the
allocation, and that rule needs to be predictable and explainable — a
user looking at Loan Detail should be able to understand why a repayment
landed where it did without reading code.

## Alternatives considered

1. **Largest-balance-first.** Pays off the biggest debt first; not how
   people intuitively think about "paying someone back."
2. **Proportional / pro-rata across every open loan.** Mathematically
   tidy, but produces confusing partial-settlement states on every single
   loan at once, and doesn't match how anyone actually thinks about
   repaying a friend.
3. **Oldest-first (FIFO).** Matches everyday social expectation ("pay off
   what's been owed longest") and standard accounting practice for aging
   receivables. Chosen as the automatic default.
4. **Always require manual allocation, no automatic default.** Rejected —
   adds friction to the overwhelmingly common case (one repayment, clearly
   meant to settle up in general, not earmarked for a specific loan).

## Decision

`allocateFifo()` (`src/lib/loan-settlement.ts`) sorts a contact's open
loans by `occurredAt` ascending and applies the repayment amount against
each in order, capped at each loan's own remaining balance, until the
repayment is exhausted or every loan is covered. Manual allocation
(`validateManualAllocation`) remains available as an explicit override —
a user can always pick specific loans to settle instead, validated
against each loan's own remaining balance and the repayment's total.

## Consequences

- Predictable, explainable default: "why did this pay off June's loan and
  not July's?" → because June is older, and that's the stated rule.
- The manual path exists for the real exception case (a repayment
  earmarked for a specific loan) without complicating the default.
- `allocateFifo` is a pure function over plain data (no DB access),
  independently unit-tested from the settlement math it feeds.
- An overpayment (repayment exceeds every open loan's combined remaining
  balance) is deliberately left partially unallocated rather than
  invented a destination for — the aggregate net balance already reflects
  the full repayment regardless of per-loan allocation, so nothing is
  lost, just not attributed to a specific loan.
