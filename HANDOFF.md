# Session Handoff — Ledgerly

> Public repository. Never record real contact names, real balances tied to a
> person, production row ids, or any private financial detail in this file.
> Describe findings structurally instead — it loses nothing technical.

## Current Status

**DEVELOPMENT FROZEN — deliberately, by the owner's decision (2026-08-09).**

Seven UX epics shipped and merged to `ledgerly-app`. No further implementation
until a week of real-world usage produces a friction log. Do not start EPIC 20,
21 or 23 — their priority is explicitly to be decided by that log, not by the
original audit.

### ✅ SHARED-EXPENSE WORK COMPLETE (2026-08-16)

A real bug surfaced during the usage week, was diagnosed, fixed, and the
resulting production data was repaired with the owner's explicit approval.
Nothing outstanding; no autonomous work remains.

**The bug.** A group's dashboard filters expenses on `Transaction.groupId`, but
"Split with friends" and "Group" were independent controls, with Group collapsed
inside `AdvancedFields` and defaulting to Personal. Splitting an expense among a
group's members therefore saved it as a personal expense that the group could
never see. On one real group, all but one expense went missing this way — the
overwhelming majority of that group's spend. **The split arithmetic was never
wrong; attribution was.** A separate defect meant one real person existed as two
contact records, each carrying part of the same debt.

**Three root causes, all fixed and committed:**

1. **Split ≠ group** — `modals.tsx`. Group is now surfaced outside Advanced
   whenever Split is on, and inferred when exactly one group contains everyone
   picked. When several do, it asks and blocks save rather than guessing;
   quietly defaulting to Personal was the original bug. Also fixed: opening Add
   Expense from a group page pre-selected the first two contacts alphabetically
   instead of that group's members.
2. **No repair path** — `transactions.ts`. `updateExpense()` accepted `groupId`
   but omitted it from the write, making group assignment write-once. It now
   persists it (guarded by `assertCanCreateInGroup` inbound, ADMIN+ outbound,
   plus a category-namespace check). `rehomeExpense()` is the minimal form — a
   single-column UPDATE — so fixing attribution never rewrites financial rows.
3. **Duplicate people** — `layout.tsx` / `split-editor.tsx` /
   `lib/duplicate-contact.ts`. `lendingOnly` hid imported contacts from the split
   picker; one was unreachable there, so a second record was created under the
   same name. Lending contacts are now listed with a badge (and search, since the
   list can run to hundreds), and creating a contact whose name already exists
   warns and offers the existing record **by id**.

**Production repairs performed (both approved, both verified):**

| operation | scope | method |
|---|---|---|
| Re-home orphaned expenses | 5 rows, `Transaction.groupId` only | one transaction, dry run first |
| Merge duplicate identity | 2 `ExpenseSplit` rows repointed, 1 contact removed | one transaction, dry run first |

Both followed the same discipline: assert preconditions inside the transaction →
mutate → re-assert every financial invariant → commit, with any failed assertion
throwing and rolling back the whole thing. Each was run first in dry-run mode
(identical code path, deliberate rollback) and the rollback verified to have left
no trace. **No amount was written by either operation** — only which group a row
belongs to, and which contact a split points at. Every balance total was byte
-identical before and after.

Post-repair verification (structural, no figures): 0 orphaned split expenses
remain, exactly one contact record survives the merge, the duplicate's id has
zero references anywhere, the sum of all `ExpenseSplit` rows is unchanged, and
null-participant split rows are unchanged (all legitimate owner shares).

**🔴 Hazard to keep for any future identity merge.**
`ExpenseSplit.participantId` is nullable with `ON DELETE SET NULL`, and every
balance reader treats a null participant as *the owner's own share*. Deleting a
duplicate contact before repointing its splits therefore does **not** error — it
silently converts that person's debt into the owner's own and shrinks what
everyone owes. `mergeParticipants()` (`src/server/services/shared.ts`) repoints
every reference first and asserts zero remaining references before it will
delete anything. There is a regression test that deliberately performs the naive
delete-first order and proves money disappears.

### ✅ GROUP SETTLEMENT — DETAILED OBLIGATIONS MADE GROUP-WIDE (2026-08-17)

The last owner-centric assumption in the settlement screen, found by the owner
reading the Detailed view against the underlying splits.

**Root cause.** `computeGrossObligations()` returned
`{ participantId, owesYou, youOwe }` — two buckets per member, **both keyed to
the owner**. That shape structurally cannot express "member A owes member B", so
whenever a *member* fronted a bill the obligations were misfiled in both
directions at once: the other sharers' shares were booked as owed to the owner,
and the whole amount the payer had fronted was booked as owed *by* the owner,
aggregating several people's debts onto one person. On a bill split five ways
this read as one row for the full fronted amount instead of four separate
per-share obligations.

It stayed invisible because the aggregate was still right: `owesYou − youOwe`
equalled that member's `net`. **Only the attribution was wrong.** The balance
engine and the payment plan were never affected — which is why Fewest Payments
always showed the correct answer and Detailed did not.

**The model now.** `computeDetailedObligations()` returns
`{ fromId, toId, amount }[]` keyed by **pair**, with `OWNER_SENTINEL` standing in
for the owner (who has no participant row). For each expense, everyone who
shared it owes **the person who paid** their own share; the payer's own share is
not an obligation to anybody. Settlements reduce the specific pair they were
paid against, flipping direction rather than going negative if over-settled.

**Detailed vs Fewest Payments** — two different answers to two questions, from
one set of numbers:

| | Detailed | Fewest payments |
|---|---|---|
| Question | why does this person owe? | who pays whom? |
| Source | `computeDetailedObligations()` | `minimizeSettlements()` |
| Shape | every obligation, un-minimised | the shortest clearing plan |
| Both | group-wide, viewer-independent, any pair of people | |

They are mathematically consistent without being the same list: executing either
leaves every participant at exactly zero.

**Conservation invariant** (asserted in tests): for every participant,
`Σ owed out − Σ owed in` equals their `paid − share` net from
`computeMemberBalances()` exactly, the owner included.

**⚠️ Stricter than what it replaced.** The new function reads **splits only**,
where the old one used `expense.amount` for the payer's outlay. `splitEqual`,
`splitByWeights` and `splitExact` all guarantee shares sum to the total, so real
data cannot diverge — but a malformed row would now surface as a reconciliation
gap instead of being silently absorbed. One old fixture whose splits did not sum
to its amount was corrected, not loosened.

**Untouched by this change:** `computeMemberBalances()`, `minimizeSettlements()`,
`computeSuggestions()`, the `balance = paid − share` rule, settlement storage,
settlement permissions, and the schema.

**Still true:** only the group's owner can record a settlement, so
member-to-member rows show "between them" with no action. Recording those would
need the settlement schema to model participant↔participant.

**Verification.** TypeScript, ESLint, 635 unit, 214 integration, `next build`,
and six E2E suites (collab 22, settlement-share 17, members-balances 32,
shared-ia 37, group-rehome 26, participant-merge 10). Detailed rendered without
overflow at 360/390/430/1440. New `src/lib/detailed-obligations.test.ts` (21
tests) covers owner-pays, member-pays-for-everyone, several payers, unequal
splits, partial/over/full settlement, member-to-member, identical output across
three different account holders, Detailed-vs-plan consistency, and paise
conservation on a split that does not divide evenly.

**Production was not touched** — local Docker only, no migration, no deploy.

### ✅ SORT CONTROL ON THE LENDING DASHBOARD (2026-08-20)

Extends the contact-ledger sort to the dashboard's Contacts list.

**What was there.** The dashboard has two lists. The Contacts list already had a
search but no sort and no date grouping — its order came from the server
(`lendingBalances` → `orderBy: { displayName: "asc" }`), i.e. alphabetical. The
Recent-entries panel is server-truncated to 8 rows and grouped by day.

**Applied to the Contacts list only.** Sorting a `limit: 8` panel by "Oldest"
would show the oldest OF THE 8 NEWEST — misleading, so the entries panel and its
day headings are untouched. The Contacts list has no date headings at all, so
the show/hide-headings rule does not arise there.

**New `sortLendingContacts` / `CONTACT_SORTS` in `loan-sort.ts` — a SIBLING of
the history sort, not a reuse.** A contact row carries a *signed net*, a
*last-activity* date and a *name*; an entry carries an amount and its own date.
Deliberately not coupled to `FIFO_ORDER`.

- Recent (default) / Oldest / Highest amount / Lowest amount / Person
- "Amount" is |net| — the list mixes "they owe you" with "you owe them", so size
  of the balance is the useful question
- Contacts with no transactions sort LAST in both date directions — an empty
  contact is not "the oldest"
- Every comparison falls back to name, so equal balances or equal dates cannot
  swap between renders
- **The default changes from alphabetical to Recent.** "Person" restores the
  previous behaviour exactly.

**Financially inert, proved end to end.** `dashboard-sort-safety.integration
.test.ts` takes a full snapshot — summary totals, per-contact balances,
`LoanAllocation` rows, running balances, open-loan order — under each of the
five sorts and asserts `snapshots.size === 1`, on the FIFO-ambiguous fixture
(two same-day loans + a partial repayment). It separately asserts the five sorts
DO produce different screen orders, so it cannot pass vacuously.
`loan-settlement.ts`, `lending.ts` and `lending-import.ts` are not in the diff.

**Verification.** 711 unit (+16), 261 integration (+7), tsc, eslint, next build.
Browser 13/13 including no overflow at 360/390/430/1440. Pre-existing E2E
unchanged: `e2e-lending` 2/5, `e2e-lending-settlement` 0/1, `e2e-lending-import`
16/17 — that last one returned 13/17 on one run and 16/17 on two more; it is
flaky, not regressed, and its FIFO checks pass. No schema change. Production
untouched.

### ✅ DETERMINISTIC FIFO + LENDING SORT CONTROL (2026-08-20)

**🔴 Correction to the entry below.** That note said the FIFO allocation query
was fixed. It was not — `lending.ts` line 611 is the running-balance
accumulation for the loan detail view, not the allocator. The real allocator was
still nondeterministic.

**Real root cause.** `allocateFifo()` sorted by
`a.occurredAt.localeCompare(b.occurredAt)`, and `occurredAt` is a **date-only
string**, so two loans on the same day compare EQUAL. `Array.prototype.sort` is
stable, so that tie silently inherited whatever order the caller passed — and
the caller, `loadOpenLoans()`, ran **no ORDER BY at all** and did not even select
`createdAt`. Which loan a repayment consumed was decided by Postgres's physical
row order.

**Fix — ordering only; the greedy loop is untouched.**
- `OpenLoan` gains `createdAt`; new exported **`FIFO_ORDER`** = `occurredAt`
  then `createdAt`, used by the allocator AND by `openLoansForContact` so the
  picker's "next to be paid" is what actually gets paid.
- `loadOpenLoans()` (and `lending-import.ts`'s own copy) order
  `[occurredAt asc, createdAt asc]` and select `createdAt`.
- Import rows not yet in the DB carry a sentinel `createdAt` that sorts after
  anything already stored for that day, preserving file order.

**⚠️ Which test actually guards this.** Mutation-checked by removing the
tiebreak: `fifo-determinism.test.ts` fails **8 tests**;
`fifo-vs-display-sort.integration.test.ts` still passes 9/9, because
`loadOpenLoans`' ORDER BY masks the comparator. The two layers are
belt-and-braces — either alone yields the right allocation — but **the pure
test is the regression guard**, not the integration one.

**Lending sort control.** A single `<select>` inline with the existing search
field (no new card or toolbar): Recent (default) / Oldest / Highest amount /
Lowest amount. `src/lib/loan-sort.ts` is presentation only — local `useState`,
never sent to the server, never imported by any service, and `sortLoanEntries`
copies rather than mutates so the summary and running-balance figures stay
chronological. Month headings show only for date sorts; under an amount sort
rows jump between months and the headings become noise.

**Proof of independence (end to end, real service + DB):** two same-day loans
(A ₹1,000 entered first, B ₹500 second), ₹700 partial repayment recorded once
per display sort. The screen order changes (`B>A` / `A>B` / `A>B` / `B>A`) while
the allocation is byte-identical every time — A receives ₹700, A remaining ₹300,
B remaining ₹500, read back from `LoanAllocation`.

**Verification.** 695 unit (+32), 254 integration (+9), tsc, eslint, next build.
Widths 360/390/430/1440 verified on each one's real rendering path (mobile opens
the ledger as a modal; desktop inline) — no overflow, control 141×48.
Pre-existing E2E unchanged: `e2e-lending` 2/5, `e2e-lending-import` 16/17,
`e2e-lending-settlement` 0/1. No schema change. Production untouched.

### ✅ LENDING ENTRIES SORT NEWEST-ENTERED FIRST (2026-08-20)

Same complaint as the settlement ordering, in the Lending module.

**Cause.** Lending already writes `istNoon(input.date)` correctly — one instant
per day — but the display query ordered on `occurredAt` **alone**, with no
tiebreak. Same-day rows therefore came back in whatever order Postgres returned,
which reads as unsorted to anyone who has just added one. Fixed to
`[{ occurredAt: "desc" }, { createdAt: "desc" }]`, matching the transaction list.

**🔴 Also fixed, and more consequential: the FIFO allocation was
nondeterministic.** `applyLoanAllocation`'s query ordered on `occurredAt` asc
with no tiebreak, so two loans made on the SAME DAY had no defined order and
which one a repayment paid down was undetermined between runs. Now
`[{ occurredAt: "asc" }, { createdAt: "asc" }]`, matching the statement query
that already had it. Oldest entered first is both stable and what FIFO means.
Every existing FIFO test still passes, so no allocation changed.

**Verification.** New `lending-order.integration.test.ts` (4 tests): newest
entered first within a day, date still wins across days, the order is stable
across repeated reads, and single/empty histories are unaffected. 663 unit, 245
integration, tsc, eslint, next build.

**Pre-existing E2E failures, confirmed unrelated** by stashing the change,
rebuilding at HEAD and re-running: `e2e-lending` 2/5 and `e2e-lending-import`
16/17 fail identically without it (nav slots, summary cards, a "+ You Gave"
button — none of which an `orderBy` can affect). `e2e-lending-settlement` 0/1
remains the long-standing "+ You Got" timeout.

### ✅ SETTLEMENTS SORT WITH THE DAY, NOT ABOVE IT (2026-08-20)

Reported as "the list looks sorted by amount". It was not — the give-away was
₹2,127 sitting above ₹2,947 — but settlements did sort above every expense of
the same day whatever the entry order.

**Cause.** The settlement cash leg was written with `occurredAt: new Date()`, a
precise instant. **Every other transaction write in the app uses
`istNoon(date)`** — one canonical time per day — so same-day rows tie on
`occurredAt` and the `createdAt` tiebreak orders them by when they were actually
entered. A precise stamp (06:57Z) beat every same-day expense (06:30Z), so a
settlement made at 12:26 IST outranked an expense added at 14:47 IST.

**Fix.** `istNoon(todayYMD())`, matching every other write.

**Timezone note.** `toYMD`/`todayYMD` are pinned to Asia/Kolkata via
`Intl.DateTimeFormat`, independent of the server clock — at 19:00 UTC they
correctly return the *next* day, where a naive `toISOString().slice(0,10)` would
not. Nothing needed changing; `settlement-date.test.ts` pins it so it cannot
regress.

**Production data:** the four existing cash legs normalised from precise
timestamps to the canonical stamp. Only `occurredAt` — no amounts, no balances,
no settlements.

**Verification.** `settlement-date.test.ts` (4 tests) covers the IST midnight
boundary; a new case in `settlement-cash-leg.integration.test.ts` asserts the
cash leg shares the day's stamp and that an expense entered *after* a settlement
sorts above it. 663 unit, 241 integration, tsc, eslint, next build, six E2E.

**⚠️ Test-fixture lesson.** The integration fixture created its expense with a
raw `new Date()`, unlike the app, so the first assertion failed for the wrong
reason. Fixtures must use `istNoon` if they are to reflect production ordering.

### ✅ THE GROUP STATEMENT LISTS ITS EXPENSES (2026-08-19)

The exported statement reported "Total expenses 7 / ₹15,157" and then showed
only member balances and settlement history. The seven rows that produced the
figure were absent, so the sheet could not be checked against anything — and
this is the sheet people take to the group to verify the maths.

**Cause.** `exportGroupStatementXlsx()` never wrote them. `GroupDashboardData`
already carries `expenses` (the group page renders it); the export simply
skipped the section.

**Now.** A Date / Description / Category / Amount / Paid by / Split / Your share
table between the member balances and the settlement history. Oldest first — the
service returns newest-first for the screen, but a statement reads
chronologically. An unsplit row reads "not shared" rather than "0 ways",
matching the group page.

**Verification.** New `export-group.integration.test.ts` (7 tests): every expense
appears; the header is correct; payer, split and your share are recorded;
"not shared" for an unsplit row; chronological order; **the listed amounts
reconcile with the stated total**; and the balance and settlement sections still
survive. 659 unit, 240 integration, tsc, eslint. No schema change.

### ✅ A SETTLEMENT LANDS IN THE LEDGER IT SETTLES (2026-08-19)

Reported: the Shared page showed people as settled while the Srisailam group
still asked them for the full amount.

**Cause — not a sync bug.** `Settlement.groupId` is optional. All eight of the
owner's settlements had been recorded from the Shared page, so `groupId` was
null. `netBalances()` counts every settlement (Shared page → correct); the group
dashboard counts only settlements tagged to it (group page → counted zero, so it
displayed pre-settlement amounts). The group page was faithfully applying a rule
that should not have been reachable.

**How Splitwise avoids it.** In a Splitwise export a payment is a row in the
SAME ledger as the expenses — payer `+amount`, receiver `−amount`, everyone else
zero. Because it lives in that ledger it necessarily moves those balances; there
is no way to record a payment that settles a person but not the group they owe
from. Ledgerly's optional `groupId` is what allowed the divergence.

**Fix.** `recordSettlement()` now infers the group when none is passed, the same
way the expense form infers one from the people picked: if the participant
belongs to exactly ONE of the caller's groups, the settlement is tagged to it.

**🔴 It deliberately does not guess when ambiguous.** With the person in several
groups it stays null rather than settling the wrong ledger — guessing is worse
than the gap. That case still needs the UI to ask; it is the one part not
covered.

**Also in this round:** `softDeleteTransaction()` now refuses to delete a
settlement's cash leg, pointing at the settlement instead. Deleting it directly
removed the money while leaving the settlement in place, so the debt still read
as settled and the balance quietly disagreed — and someone deleting the row to
undo a duplicate settlement had not undone anything. That happened in production.

**Production data repaired (owner-approved, audited):** eight settlements
retagged to Srisailam (no money moved, only the tag); earlier, two duplicate
no-group settlements deleted with their cash legs reversed, and one stale
cash-leg link cleared. Afterwards every person's group-page net equals their true
net. One genuine overpayment remains by the owner's confirmation.

**⚠️ Verification lesson.** A check script summed settlement amounts ignoring
`direction` and reported a false mismatch; three of the rows were FROM_OWNER.
Any settlement arithmetic must sign by direction — `TO_OWNER` positive,
`FROM_OWNER` negative.

**Verification.** New `settlement-group-inference.integration.test.ts` (7 tests):
attaches when unambiguous; the group page reflects it; an explicit group wins;
untagged with no group; untagged with several AND neither group absorbs it;
never reaches across users; shared and group pages agree. Plus 3 new cash-leg
guard tests. 659 unit, 233 integration, tsc, eslint, next build, six E2E suites.
No schema change, so no migration.

### ✅ SETTLEMENTS NOW MOVE REAL MONEY (2026-08-19)

Reported by the owner: money paid into a shared group counts as spending, but
settling up never shows as money coming back.

**Cause.** `recordSettlement()` wrote a `Settlement` row and nothing else — no
transaction, no account touched. So the outbound leg was recorded and the return
leg never was. Cash outflow stayed permanently overstated, and **account
balances drifted from the bank a little further with every settle-up.**

**Now.** The settle sheet has an ACCOUNT field (defaults to the first account;
"Not tracked" keeps the old behaviour). With an account chosen the settlement
also writes its cash leg and applies the balance.

**The representation, and why it is asymmetric:**
- **TO_OWNER (they repay you) → INCOME.** Safe because `personalShareOf()` and
  `netBalances()` both filter on `type: "EXPENSE"`, so it cannot disturb your
  share or anyone's balance.
- **FROM_OWNER (you repay them) → TRANSFER**, not EXPENSE. Three things rule
  EXPENSE out, all verified: with no splits `personalShareOf` counts it in full
  and double-counts the share already borne; with a participant-side split
  `netBalances` re-creates the very debt being settled (it sums every split
  expense, group or not); and a zero-sum split is rejected by the
  `split_sum_constraint` trigger. A TRANSFER moves the money without claiming it
  was consumption — which is the truth.

**🔴 The cash leg carries NO groupId.** The group dashboard reads
`{ groupId, type: "EXPENSE" }`; a grouped row would come back as a group expense
and corrupt the balances it settles. There is a test pinning this.

**Reversal.** New nullable, unique `Settlement.transactionId` (migration
`20260819104059_settlement_cash_leg`, `ON DELETE SET NULL` — the debt record is
the source of truth, the cash leg a mirror). `deleteSettlement()` reverses the
balance and removes the transaction.

**⚠️ Forward-only.** Settlements recorded before this have no cash leg and no
balance was ever applied for them. Backfilling would invent account movements
that may already have been entered by hand — not attempted. Separate,
explicitly-approved data job if ever wanted.

**⚠️ Migration pending on production.** Applied to local Docker only.

**Verification.** New `settlement-cash-leg.integration.test.ts` (9 tests):
repayment lands as income; the cash leg never becomes a group expense; repaying
moves money but is not your spending; the group balance still adjusts
identically; without an account nothing changes from before; deleting reverses
the money; another user's account is refused with nothing moved; and cash in/out
reconcile to exactly your own share once everyone has settled. Plus 659 unit,
223 integration, tsc, eslint, next build, six E2E suites, and a browser run of
the real flow (balance moved ₹100, cash leg INCOME with groupId null, linked).

### ✅ SPLIT PICKER SCOPED TO THE GROUP (2026-08-18)

Reported while editing a group expense: the "Split with friends" picker listed
the owner's entire contact list (~94 people) instead of the group's members.

**Cause.** Both split forms did `const sharedParticipants = refData.participants`
and passed that straight to `SplitEditor` — `modals.tsx` (Add Expense) and
`transaction-detail.tsx` (Edit). `RefData.groups` already carried `memberIds`;
nothing consulted them.

**Why it mattered beyond noise.** A split can only be settled between members:
the group dashboard reads its own roster, so an outsider's share sits on the
expense but never appears in any balance or settlement plan. The picker made
that easy to do by accident.

**Fix.** One exported helper, `participantsForGroup()` in `split-editor.tsx`,
used by both forms:
- no group → everyone (unchanged)
- group chosen → that group's members only
- anyone ALREADY on the split stays listed even if they have since left, so
  editing never hides someone who is still being charged
- unknown group id → fall back to everyone rather than an unescapable empty list

Only what is DISPLAYED is narrowed. `sharedParticipants` stays the full list for
group *inference* ("these people imply exactly one group") — narrowing that
would make choosing people shrink the list the choice is made from.

**Verification.** 9 unit tests (`participants-for-group.test.ts`), plus a browser
check: a group of three with an outsider present now offers exactly the three.
653 unit, 214 integration, tsc, eslint, next build, six E2E suites.
`e2e-group-expenses` stays 24/25 on its pre-existing date-picker timeout.
Production untouched.

### ✅ SETTLE-UP MATCHES SPLITWISE TO THE PAISA (2026-08-18)

Asked for after comparing a Splitwise export against the same group in Ledgerly.

**The algorithm was never the difference.** `minimizeSettlements()` is greedy
largest-debtor → largest-creditor, which is Splitwise's published "simplify
debts" heuristic. Run over the same expenses, the two produce byte-identical
plans — verified against a real export: same four payments, same amounts, same
total.

**The tolerance was.** `computeSuggestions()` passed `SETTLED_THRESHOLD` (₹1) as
the engine's epsilon. minimizeSettlements drops any debtor, creditor **or
transfer** at or below its epsilon *while still decrementing the balances*, so a
group carrying sub-rupee amounts got a plan that silently failed to clear
everyone — e.g. ₹0.75 stranded on one member with no row to pay it. Splitwise
settles to the cent; the plan now settles to the paisa (`epsilon = 0`).

`SETTLED_THRESHOLD` is unchanged and still governs **display** — the "Settled"
badge, the receive list, the detailed rows keep their ₹1 tolerance. This also
made the group page consistent with the Shared page, which already passed no
epsilon.

**A test was passing for the wrong reason.** "no suggestions when everyone is
within the settled threshold" used owner `+50` / member `−50`; under the sign
flip both become *creditors* summing to `+100`, so it produced no transfers at
any epsilon and never tested the threshold at all. Replaced with well-formed
cases.

**UI, same round.** The three-way tab set (Fewest payments / Detailed / I'll
receive) collapsed to one **Settlement** tab with a **Simplify payments**
toggle under it — ON is the minimised plan, OFF the raw obligations — plus the
unchanged "I'll receive" tab. Two views of one question had been presented as
two questions.

**Verification.** TypeScript, ESLint, 644 unit (+9), 214 integration,
`next build`, six E2E suites, no overflow at 360/390/430/1440. New
`src/lib/settlement-splitwise-parity.test.ts` (7 tests) pins the properties
Splitwise's settle-up guarantees: clears every participant exactly across 500
randomised groups, nobody pays more than they owe or receives more than they are
owed, nobody both pays and receives, at most n−1 payments, largest-debtor ↔
largest-creditor pairing, and a guard proving the ₹1 epsilon *would* strand
money. **Production untouched.**

**Not fixed by this:** the owner's live group still differs from the Splitwise
export by ~₹1,074 — a data divergence (different expenses/splits), not an
algorithm one.

**Deliberately deferred:** [#238](https://github.com/DivyeshPatro/Expense_Tracker/issues/238)
— the NET hero and per-expense "your share" are still computed with the owner as
"self", so a member reads the owner's position under a first-person label.

## Shipped

| Epic | | PR | Headline result |
|---|---|---|---|
| 14 Information Hierarchy | #178 | #221 | 13/13 screens lead with information, up from 2/13 |
| 15 Dashboard Simplification | #179 | #222 | 41 cards → 19, 33 chips → 8, zero duplicated obligations |
| 17 Navigation & Settings | #181 | #223 | 4 label mismatches → 0; Settings 3.39 → 1.07 screens |
| 16 Fast Input Flows | #180 | #224 | Amount focused, 9 controls → 1, no iOS zoom |
| 22 People | #219 | #225 | One balance per person |
| 18 Wallet Experience | #182 | #226 | Accounts total; typical wallet above the fold |
| 19 Performance Perception | #183 | #227, #228 | Tap acknowledged in 150–272ms throttled; repeat search 0 requests |
| — v2.1 shared-expense fixes | — | — | split↔group coupling, re-home repair path, duplicate-contact prevention, `mergeParticipants()` |

**No schema changes in any of them** — nothing to migrate against Supabase.
The v2.1 work needed none either: `groupId` and every FK already existed.

## Test coverage added by v2.1

- `src/lib/group-inference.test.ts` — 14 unit tests (inference, ambiguity refusal)
- `src/lib/duplicate-contact.test.ts` — 16 unit tests (normalisation, near-miss, never merges)
- `src/server/services/group-rehome.integration.test.ts` — 23 DB tests
- `src/server/services/participant-merge.integration.test.ts` — 21 DB tests
- `scripts/e2e-group-rehome.ts` — 26 browser checks at 390px
- `scripts/e2e-participant-merge.ts` — 10 browser checks at 390px

Full gate at time of commit: TypeScript clean, ESLint clean, 551 unit tests,
181 integration tests, `next build` successful, both E2E suites green.

All fixtures use synthetic names and synthetic amounts that preserve the
mathematical relationships under test.

## Next Exact Action

**Nothing pending on the shared-expense work.** Both production operations are
done and verified; the code is committed and pushed.

Do NOT re-run either production repair. Both were written to be idempotent, but
there is nothing left to fix.

Then, still pending from before: after the usage week, reprioritise EPIC 20
(Onboarding), 21 (Product Identity) and 23 (Insights & Reporting) against what
the log actually shows. All three remain open with full
Why/Before/After/Success bodies.

Also still open and unprioritised: EPIC 6 #75's remaining children (#76–#82),
minus the layout/search work folded into #206. #78 categories, #81 usage
analytics and #82 statement reminders are features, deliberately not built.

## Friction log — the only artefact this week should produce

One line per hesitation. Nothing else. What you were trying to do, and where
you stopped.

```
Mon
Tue
Wed
Thu
Fri
Sat
Sun
```

Worth watching specifically, since these are unvalidated guesses:
- Do you still reach for "Khata"? (renamed to Lending in #201)
- Does the Settings grouping work without thinking? (#204)
- Is the Home FAB useful, or ignored? (#203)
- Do you ever open Insights? (decides whether EPIC 23 is Sprint 8 at all)
- Does "People" replace how you think about Lending and Shared? (#207)

## Local environment state

- **`.env` untouched all session** (never edited).
- **`.env` currently points at PRODUCTION Supabase**: the local Docker line is
  commented out, the Supabase pooler line is active. So a bare `npm run dev`,
  `npx prisma migrate dev` or `npx prisma db push` hits production. The
  `npm run db:migrate|db:seed|db:reset` scripts remain safe —
  `scripts/db-local.mjs` forces both vars local and refuses anything non-local.
  Uncomment the local line before local work.
- **Production access discipline used throughout 2026-08-16.** All investigation
  ran inside `SET TRANSACTION READ ONLY`, asserting `transaction_read_only = on`
  before reading, so the server itself would reject a stray write with SQLSTATE
  25006. The two approved repairs were the only writes: each a single
  transaction, dry-run first, every invariant re-asserted before commit. No
  migration, no seed, no schema change. All one-off scripts lived in the session
  scratchpad and were never added to the repo.
- **Ports.** A stale `next dev` left over from an earlier session was holding
  :3000 against PRODUCTION and was terminated. All local verification ran on
  :3001 with `DATABASE_URL`/`DIRECT_URL`/`BETTER_AUTH_URL` overridden to local
  in-process — never by editing `.env`. `BETTER_AUTH_URL` must match the port or
  sign-in silently fails to redirect.
- **Local test data** (Docker `ledgerly-pg` only, never production):
  `heavy@ledgerly.test` with 1,400 transactions across 24 months — useful for
  perf work, kept on purpose; a few `*@ledgerly.test` signups; and some small
  fixtures on the seeded demo account.

## Process notes worth keeping

**Stale build artefacts produced five false signals this session** — a phantom
build failure on untouched pages, an unstyled-page measurement, a component that
would not update, a ChunkLoadError, and a lost trace. Kill the server and clear
`.next` when switching between `next dev` and `next build`; never measure
without confirming CSS loaded. This recurred during v2.1: running `next build`
over a `.next` that `next dev` had been using produced a bogus
`Cannot find module for page: /_not-found`.

**Measure runtime claims; never implement from an audit's word.** Three of EPIC
19's four premises were wrong. See the `audit-reliability` memory.

**This is a public repository — sanitize before committing.** The v2.1 work was
initially committed with real contact names, production row ids and real
balances in fixtures and in this file. It was caught at the push gate and the
commits were rewritten before anything reached the remote. Scan the outgoing
diff for personal data as a matter of course, not just for secrets.

<!-- claude-code-stop-failure incident=88d3e7720a001d6e -->

Automatic note: Claude Code stopped with a non-retryable "invalid_request" error at 2026-08-17 14:44:46 IST.
Raw hook input was saved to `.claude/stop-failure-events.jsonl`.
Automatic recovery is disabled for this failure type.
This hook cannot schedule a same-session resume by itself.

<!-- claude-code-stop-failure incident=d5fb21f4ad917cce -->

Automatic note: Claude Code stopped with a rate limit at 2026-08-17 18:06:09 IST.
Raw hook input was saved to `.claude/stop-failure-events.jsonl`.
Automatic recovery is enabled for this failure type.
This hook cannot schedule a same-session resume by itself.

<!-- claude-code-stop-failure incident=4dd660adee16ae57 -->

Automatic note: Claude Code stopped with a temporary server error at 2026-08-17 22:51:28 IST.
Raw hook input was saved to `.claude/stop-failure-events.jsonl`.
Automatic recovery is disabled for this failure type.
This hook cannot schedule a same-session resume by itself.
