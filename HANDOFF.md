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
