# ADR 0007 — Why the Finance Hub aggregates existing services

## Context

The dashboard (Finance Hub) shows a synthesized view across accounts,
transactions, budgets, bills, lending, shared expenses, and notifications
— data owned by many independent domain services (see
[`finance-hub.md`](../finance-hub.md)).

## Problem

A dashboard summarizing seven domains could either re-derive its own
optimized queries for the summary view, or reuse each domain's own
already-correct, already-tested service functions. Re-deriving risks the
dashboard's numbers silently diverging from the domain page's own numbers
— e.g. the dashboard says a contact owes ₹500, the Lending page says ₹450,
and now there are two sources of truth for the same fact with no way to
know which one is stale.

## Alternatives considered

1. **A dedicated dashboard/finance-hub service with its own queries**,
   hand-optimized for the summary view. Faster to fetch in theory (one
   combined query instead of several), but duplicates business logic
   already written and tested per domain, and every future change to
   e.g. lending balance math would need to be made twice.
2. **The dashboard page composes calls to each domain's own existing
   service functions** — `lendingBalances()`, `listBills()`,
   `unifiedSearch()`, the same functions their own pages call. Chosen.

## Decision

`src/app/(app)/dashboard/page.tsx` fires a `Promise.all` of calls into
each domain's existing service layer and assembles the results into
dashboard sections (attention strip, health widget, lending summary,
bills, settlements, recent activity). It never queries Prisma directly
for domain data, and it never re-implements a domain's own math (e.g.
lending net balances, bill urgency).

## Consequences

- Dashboard numbers are guaranteed consistent with each domain's own
  page, because they run the exact same code path.
- Adding a new module's dashboard summary is "call its existing service
  function," not "design a new query" — the dashboard has no domain logic
  of its own to maintain.
- The dashboard fires several independent service calls per render rather
  than one hand-optimized combined query. Accepted because each call is
  already cheap and several are `cache()`-wrapped (deduped within the
  same request when a component and the page both need the same data) —
  correctness-by-construction was judged more valuable than shaving
  milliseconds off an already-fast page.
