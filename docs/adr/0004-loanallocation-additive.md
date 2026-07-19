# ADR 0004 — Why `LoanAllocation` is additive-only

## Context

A single repayment (GOT entry) can pay down one or several outstanding
loans (GAVE entries); conversely, one loan can be paid off across several
separate repayments over time. This is a many-to-many relationship that
needs to be inspectable — "which repayment paid off which loan, and how
much of it" — for both automatic FIFO allocation and manual override (see
[`lending.md`](../lending.md)).

## Problem

Recording *that* a loan is settled isn't enough; the system (and the user,
looking at Loan Detail) needs to see *why* — which specific repayment(s)
cover it. A single running counter loses that trail the moment more than
one repayment touches the same loan.

## Alternatives considered

1. **A `settledAmount` counter on `LoanEntry`, incremented on repayment.**
   Simplest, but destroys the audit trail — there's no way to answer "which
   repayment(s) settled this loan" after the fact, and undoing a repayment
   requires reversing an aggregate rather than deleting a specific record.
2. **A join table (`LoanAllocation`) recording each GAVE↔GOT pairing and
   the paise amount applied, created by settlement and never mutated in
   place — only ever created or deleted.** Chosen.

## Decision

`LoanAllocation` rows are written once, by FIFO auto-allocation
(`allocateFifo`) or by an explicit manual allocation
(`validateManualAllocation`), and are never edited afterward — only
created or deleted (e.g. when the repayment itself is deleted/undone).
This matches how `ExpenseSplit` and other financial join tables in this
codebase already behave: additive records, not mutable counters.

## Consequences

- Full settlement history is reconstructible: "why does this loan show
  ₹500 settled?" has a concrete, visible answer (the specific
  `LoanAllocation` rows, shown in Loan Detail), not just a trusted number.
- FIFO and manual allocation share the same underlying storage and the
  same downstream status computation (see
  [`0006-derived-financial-metrics.md`](0006-derived-financial-metrics.md))
  — neither is a special case of the other.
- Every "remaining balance" read must aggregate allocation rows rather
  than trust a cached counter — an intentional cost, addressed by
  batching/caching at the query layer (`cache()`-wrapped shared loaders),
  not by reintroducing a stored counter.
