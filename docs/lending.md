# Lending

The Lending module tracks money you personally give to or receive back
from a contact — a friend, a roommate, anyone not organized into a
collaborative [Group](shared-expenses.md). It is deliberately **personal
and single-writer**: unlike group expenses, a lending relationship has
exactly one ledger owner, so none of the collaboration/authorization
machinery in [`shared-expenses.md`](shared-expenses.md) applies here.

## Philosophy

Money you give a friend and money they give back are the same kind of
fact — a movement of money between you and them — expressed with opposite
sign. Ledgerly models them as one flat, symmetric event log
(`LoanEntry`, discriminated by `kind: GAVE | GOT`) rather than a
stateful "Loan" object whose status field gets mutated as repayments
happen. See [ADR 0003](adr/0003-loanentry-flat.md) for the full reasoning
— in short, this mirrors how `Transaction` already treats expense and
income as the same shape, and it means settlement logic can change
without ever migrating the entry model itself.

**Nothing about a loan's settlement state is ever stored.** Remaining
balance, settled amount, and status (`OPEN`/`PARTIAL`/`SETTLED`/`OVERDUE`)
are computed at read time from the allocation records described below.
See [ADR 0006](adr/0006-derived-financial-metrics.md) for why — Ledgerly
already has one cautionary example of a cached financial value
(`Account.balance`) that needs a standing reconciliation job to catch
drift, and lending was deliberately built to never need one.

## Data model

### `LoanEntry`

One row per money movement. `kind` is `GAVE` (you → them) or `GOT`
(them → you) — same table, same shape, same offline-sync machinery
(`version` for conflict detection, soft-delete + undo) that `Transaction`
already uses. Optionally references a funding `Account` (e.g. a credit
card — see Card Billing Intelligence below) and carries an optional
`dueDate` (meaningful for `GAVE` entries).

The running balance with a contact is `Σ GAVE − Σ GOT` — positive means
they owe you, negative means you owe them. This is the exact sign
convention `netBalances()` already established for shared-expense
settlements, reused rather than reinvented.

### `LoanAllocation`

A repayment (`GOT` entry) can pay off one or several outstanding loans
(`GAVE` entries); one loan can be paid off across several separate
repayments. `LoanAllocation` is the join table recording each
GAVE↔GOT pairing and the paise amount applied — created by settlement,
**never edited in place**, only created or deleted. See
[ADR 0004](adr/0004-loanallocation-additive.md).

A loan's derived status comes from summing its `LoanAllocation` rows:

```ts
// src/lib/loan-settlement.ts — computeLoanStatus
remainingAmount = max(0, originalAmount - settledAmount)
status =
  remainingAmount <= 0           → SETTLED
  dueDate && dueDate < now       → OVERDUE   (even if partially paid — the
                                               outstanding remainder is what's late)
  settledAmount > 0              → PARTIAL
  else                           → OPEN
```

A fully-settled loan is never "overdue," even past its due date — once
it's paid off, the due date no longer means anything.

## Settlement

### FIFO (automatic default)

When a repayment doesn't specify which loan it's paying off — the common
case — `allocateFifo()` applies it against the contact's open loans
**oldest `occurredAt` first**, capped at each loan's own remaining
balance, until the repayment is exhausted or every loan is covered. See
[ADR 0005](adr/0005-fifo-settlement.md) for why oldest-first was chosen
over largest-first or pro-rata. Any amount left over once every open loan
is covered is simply unallocated (an overpayment/credit) — the aggregate
net balance already reflects the full repayment regardless of per-loan
attribution.

### Manual allocation

A repayment can instead be explicitly earmarked against specific loans.
`validateManualAllocation()` checks that every targeted loan exists, has
enough remaining balance, amounts are positive, and the total doesn't
exceed the repayment — before anything is persisted.

Both paths write to the same `LoanAllocation` table and feed the same
derived-status computation; manual allocation isn't a special case
grafted on top of FIFO, it's the same mechanism with a different source
for which loans get how much.

## Contact balances

`lendingBalances()` (`src/server/services/lending.ts`) computes each
contact's net balance, overdue count, and last-transaction date from
**all** of that user's loan entries — deliberately unbounded, because
it's scoped to one user's own data (naturally small — years of personal
lending rarely exceeds a few thousand rows) and because truncating it
would produce a *wrong* balance, not just a shorter list. It's
`cache()`-wrapped so the Dashboard and the Contacts list, which both need
it in the same request, hit Postgres once.

The Contact Ledger view shows a contact's full timeline. The fetch itself
is also intentionally unbounded (`ContactSummaryCard`'s "Total Lent" /
"Average Loan" / "Largest Loan" stats are computed from the exact same
array and are documented as all-time — truncating the fetch would make
those numbers wrong, not just hide old rows). What's paginated instead is
the *render*: the timeline shows 30 entries at a time with a "Show more"
button revealing more of the already-fetched array, so a long-lived
contact doesn't mean mounting hundreds of DOM rows at once.

## Card billing intelligence

When a `GAVE` entry is funded from a credit card (`accountId` points at a
`CREDIT_CARD` account with `statementDay`/`dueDay` configured),
`cardCycleForDate()` (`src/lib/card-billing.ts`) computes which billing
cycle that spend falls into and when that cycle's payment is due — one
rule handling every edge case (variable month lengths, leap years,
December→January rollover, statement-day-after-due-day) uniformly:

- A spend belongs to the cycle whose statement day (clamped to that
  month's real length) is the next one on or after it.
- The due date is the next date after the statement date carrying the
  card's `dueDay` — this alone produces the right month rollover in both
  directions with no separate branching.

**Card Recovery** (`cardRecoveryDashboard`) groups a user's card-funded
loans by cycle and card, surfacing "lent this cycle / recovered this
cycle / outstanding / past due" per card, so recovering the money before
the card's own due date (and avoiding paying interest on money you
already lent out) is a specific, trackable thing rather than something
buried in the general contact list.

## Reminder engine

`generateReminders()` (`src/lib/lending-reminders.ts`) is data-only by
design — it produces structured `ReminderCandidate` records, not a
notification delivery mechanism (that's a deliberately deferred future
phase). Two independent reminder families exist per loan, since they
track two different deadlines that can both apply to the same loan
simultaneously:

- **Loan due date** (set by the user): `overdue` / `due_today` /
  `due_tomorrow` / `due_this_week`.
- **Card billing due date** (only for card-funded loans with billing
  details configured): `recover_before_card_due` / `card_due_tomorrow` /
  `card_due_this_week`.

Only loans with a remaining balance produce reminders — a fully settled
loan generates none, regardless of its due date.

## Reports

`lendingReportsData()` produces the Lending Reports tab: monthly
lending/recovery trend, a cumulative outstanding-balance trend,
receivable vs. payable, an all-time recovery rate, card exposure, overdue
loans, and top borrowers.

This is the one place lending's usually-unbounded reads *are* bounded,
because the underlying stat genuinely doesn't need the whole ledger: the
monthly/trend charts only need the selected window (default 6 months)
plus a single running-balance carry-in figure computed as one
`groupBy` aggregate over everything before the window. The all-time
recovery rate is a separate `groupBy` aggregate (lent vs. recovered
totals) rather than pulling every entry into JS to sum — Postgres does
the summing, the query returns two rows, not a full history's worth.

## Where this shows up in the product

| Surface | Component |
|---|---|
| `/lending` — contacts list, workspace | `src/components/lending/lending-workspace.tsx`, `contacts-list.tsx` |
| Contact Ledger (per-contact timeline) | `src/components/lending/contact-ledger.tsx` |
| Loan Detail (single entry + its allocations) | `src/components/lending/loan-detail.tsx` |
| Card Recovery | `src/components/lending/card-recovery.tsx` |
| Reminders | `src/components/lending/reminders-panel.tsx` |
| Reports | `src/components/lending/lending-reports.tsx` |
| Dashboard summary | `src/app/(app)/dashboard/page.tsx` (via `lendingBalances`) |

## Offline sync

Lending entries use the identical outbox/conflict machinery
[`offline-sync.md`](offline-sync.md) describes for transactions —
`loan.create` / `loan.update` / `loan.delete` are three more
`MutationKind`s routed through the same `enqueueMutation`. Lending is
personal-only, so the actor-aware `CONFLICT` branch
([ADR 0008](adr/0008-lww-conflict-resolution.md)) never applies here —
every loan entry has exactly one legitimate actor, and any version
mismatch is always the same person on a different device (silent
last-write-wins).
