# Ledgerly Sync & Collaboration — Production Readiness Audit

**Date:** 2026-07-17
**Scope:** the full offline-sync + collaboration stack as it stands after Migration Step 5 —
`authorization.ts`, `transactions.ts` (exactly-once, `checkOverride`, `ConflictError`), `/api/sync`,
the client outbox (`offline-context.tsx`, `lib/offline/db.ts`), `activity.ts`, and the UI surfaces
that consume all of it (`transaction-detail.tsx`, `pending-detail.tsx`, Sync Center).
**Method:** direct re-reading of the current source (not a diff review) — every claim below is
traced to specific code, not restated from earlier design intent. No code was changed.

**Update (2026-07-18) — Phase A (production blockers) resolved:**
- **§1.1 TOCTOU race** — closed via `serializable()`: `exactlyOnceMutate` and `restoreTransaction`
  now run under Postgres `SERIALIZABLE` isolation with bounded retry on genuine serialization
  failures (P2034). Proven with a real concurrency test (`e2e-toctou-race.ts`, 5 rounds of two
  truly simultaneous `Promise.all`-fired updates, no sequencing) — exactly one side wins cleanly
  every time, the other gets an honest `CONFLICT`, never a silent overwrite.
- **§1.2/§1.3/§1.4 Intent completeness** — split-expense create/edit and the private-browsing
  fallback now all construct real (or, when no persisted device identity exists, ephemeral)
  intent metadata, so every mutation path creates an `Intent` row and participates in
  `checkOverride`. `ConflictError` also got a readable message in `actions.ts`'s `fail()`, since
  these direct-call paths can now genuinely reach it.
- **§3.2 `actorUserId` display** — threaded through `AuditRowInput`/`LabelMaps`/`TimelineEvent`
  and rendered in the History card and the Activity page. `groupUpdateChains` was also made
  actor-aware (a change of actor now breaks the 10-minute chain-collapse window), since
  collapsing two different people's edits into one net-diff event would have misattributed it.

24 new checks across three scripts (`e2e-toctou-race.ts`, `e2e-phaseA-ui.ts`, plus 5 new unit
tests in `activity.test.ts`), green twice consecutively, alongside the full pre-existing suite
(329/329 total). §1.5 (group-create failures render through the wrong sheet), §2.1/§2.2
(existence-leak, orphaned audit refs), and everything in the Duplicated Logic / Dead Code /
Maintainability / Performance / UX / Future Enhancements sections below are Phase B — not
addressed in this pass; see the project's own tracking for when that's picked up.

This is a review document, not a task list. Severity labels (HIGH/MEDIUM/LOW) reflect likely
production impact if left unaddressed, not effort to fix.

---

## Executive summary

1. **A real, untested race condition can silently discard a concurrent write.** The
   version-check pattern (`checkOverride`) reads `old.version`, decides, then writes — with no
   compare-and-swap on the actual `UPDATE`. Two genuinely simultaneous requests (not
   client-serialized) can both pass their own stale-read comparison and both apply, with the
   second one silently overwriting the first's data fields with no `OK_OVERRIDE`, no `CONFLICT`,
   no signal at all. Every existing test — including this session's own new ones — validates the
   *sequential* case (A commits, then B drains) and has never exercised true concurrency.
2. **`checkOverride`'s actor attribution is only as complete as the Intent table**, and two
   real code paths (split-expense edits, the private-browsing IndexedDB-unavailable fallback)
   write to `Transaction` without ever creating an `Intent` row. A write through either path is
   invisible to the "who touched this last" lookup, so a *subsequent* conflict check can silently
   default to "same actor" and apply over it with zero warning.
3. **`AuditLog.actorUserId` — the entire point of RFC §5 — is written but never read anywhere.**
   No UI surface displays who actually made an edit when it differs from the row's owner. The
   collaboration audit trail is currently write-only.
4. **The Intent-pruning cron the original spec named as the #1 anticipated scaling failure was
   never built.** The table grows forever, and if pruning is ever added at the spec'd 30-day
   cutoff, it will silently degrade item 2 above for any entity whose real edit history spans
   longer than that.
5. Everything else below is real but lower-stakes: one taxonomy gap (group-tagged creates that
   fail with `NOT_AUTHORIZED`/`GROUP_DELETED` render through a sheet that doesn't know those
   codes exist), a narrow existence-leak on the write path, three-way duplicated boilerplate
   across `updateExpense`/`updateIncome`/`updateTransfer`, and a handful of dead/inert fields.

---

## 1. Correctness issues

### 1.1 — HIGH — TOCTOU race: version check is not atomic with the write it gates
**Where:** `checkOverride` (`transactions.ts:226`) + every `db.transaction.update({ where: { id }, ... })` call that follows it (`updateExpense`, `updateIncome`, `updateTransfer`, `softDeleteTransaction`).

The pattern in all four mutating functions is: read `old` → call `checkOverride(db, actingUserId, old, intent?.baseVersion)` (compares the CLIENT's `baseVersion` against `old.version`, both already-read, in-memory values) → write `db.transaction.update({ where: { id }, data: { ...literal values computed before this line... } })`. The `UPDATE` statement's `WHERE` clause is `{ id }` — it never includes `version: old.version`. Under Postgres's default READ COMMITTED isolation (no isolation level is set on any of these `prisma.$transaction` calls), two overlapping requests for the same row can each:

1. Read `old.version = 5`.
2. Independently conclude "no mismatch" (each compares its own `baseVersion` against its own stale read of 5).
3. Both call `update()`. Postgres serializes the actual writes via row-level locking, but neither `UPDATE` re-validates against the version each transaction *read* — the second writer's `UPDATE` simply applies its own (stale-computed) field values on top of whatever the first writer already committed. `version: { increment: 1 }` stays numerically consistent (Postgres evaluates the increment against the live row at write time), but every *other* field — `amount`, `merchant`, `categoryId`, `notes` — is silently set to the second writer's stale in-memory values, discarding the first writer's change with **no `OK_OVERRIDE`, no `CONFLICT`, no error, no audit-visible signal that this happened.**

This applies to same-actor races (two devices) exactly as much as different-actor races — the actor comparison in `checkOverride` never gets a chance to run, because the version check that *would* have caught the mismatch already returned `{ overridden: false }` based on a read taken before the race window closed.

**Why the test suite hasn't caught it:** every existing race test (`e2e-offline-p3.ts`'s "two-device edit race," this session's new `e2e-collab-offline.ts` conflict tests) explicitly waits for the first writer's commit (`await pageA.waitForSelector("text=Transaction updated"); await pageA.waitForTimeout(800);`) *before* bringing the second writer online. That's a real and valuable test of the *sequential* stale-baseVersion case, but it fully serializes the two writes and therefore can never exercise the interleaved-transaction window this bug lives in. The "silent LWW passes" test result is not evidence this race is safe.

**Likely fix shape** (not implemented, per scope): make the `UPDATE` itself the compare-and-swap — `updateMany({ where: { id, version: old.version }, data: {...} })` and branch on `count === 0` — or raise the transaction isolation level to `Serializable` and handle the resulting retry/abort. Either closes the window; the current code does neither.

### 1.2 — HIGH — Actor attribution is only as reliable as Intent-table completeness
**Where:** `checkOverride` (`transactions.ts:236`), in combination with the two paths below that never write an `Intent` row.

`checkOverride`'s same-actor-vs-different-actor decision is: `const priorIntent = await db.intent.findFirst({ where: { entityId: old.id }, orderBy: { appliedAt: "desc" } }); const sameActor = !priorIntent || priorIntent.userId === actingUserId;`. Two things make this unreliable as a proxy for "who actually last wrote this row":

- **`!priorIntent` defaults to `sameActor = true`.** If no Intent row has ever been recorded for this entity (see 1.3/1.4 below — this is a normal, reachable state, not a corrupt one), *any* version mismatch silently applies as a clean override, regardless of who the real prior writer was.
- **The "most recent Intent" is not the same thing as "the most recent write."** Any write that bypasses intent-tracking (1.3, 1.4) advances `Transaction.version` without ever touching the `Intent` table. A later conflict check can find an *older*, unrelated Intent row (or none) and reason about the wrong actor, or reason about no actor at all.

The net effect: the actor-aware conflict system's correctness silently degrades to "same actor" (i.e., apply without asking) exactly in the cases where a non-intent-tracked write is the thing it should have detected — which is close to backwards, since those are also the writes with the least other protection (see 1.3).

### 1.3 — MEDIUM-HIGH — Split-expense edits bypass version/conflict checking entirely
**Where:** `EditExpenseForm`'s split branch (`transaction-detail.tsx`), `ExpenseForm`'s split branch (`modals.tsx`) — both call `updateExpenseAction`/`addExpenseAction` directly, never through `enqueueMutation`/the outbox.

Split-expense creates and edits have been direct, online-required calls since Phase 1 (a pre-existing, previously-reasonable restriction: "splits touch other participants' balances"). The consequence that matters now: these calls never construct an `IntentMeta`, so `intent` is `undefined`, so `checkOverride`'s very first line (`if (baseVersion === undefined ...) return { overridden: false }`) returns immediately — **the split-edit path can never produce `OK_OVERRIDE` or `CONFLICT`, and never creates an `Intent` row.** It always applies blindly, unconditionally, regardless of what changed underneath it since the form was opened — for the owner's own edits (unchanged risk profile from Phase 1) *and*, as of Step 4/5, for two different real people who could now both be looking at the same split transaction at once. There is currently no signal to either party that this happened.

This also directly feeds 1.2: a split edit is exactly the kind of untracked write that can make a *later*, unrelated conflict check reason about the wrong prior actor.

### 1.4 — MEDIUM — The private-browsing (no-IndexedDB) fallback has the same gap
**Where:** `directMutationFallback` (`offline-context.tsx:56`), reached when `ensureDeviceId()` fails (no IndexedDB — private browsing / storage disabled).

`enqueueMutation`'s payload is passed straight through to `updateExpenseAction`/`updateIncomeAction`/`updateTransferAction`/`deleteTransactionAction` with no `intent` field constructed. Same consequence as 1.3: `checkOverride` short-circuits, no version check, no conflict detection, no Intent row. This was an acceptable simplification when it only meant "no offline queueing" for a solo user; it now also silently means "no conflict protection at all" for a collaborative edit made from a private-browsing session. Authorization (`assertCanWrite`) is still fully enforced on this path — there's no security gap here, only a data-integrity one.

### 1.5 — MEDIUM — Group-tagged CREATE failures render through a sheet that doesn't know the new taxonomy
**Where:** `PendingDetailSheet`/`PendingView` (`pending-detail.tsx`) vs. the `NOT_AUTHORIZED`/`GROUP_DELETED`/`CONFLICT` handling added to `TransactionDetailSheet` only (`transaction-detail.tsx`).

A group-tagged `expense.create`/`income.create`/`transfer.create` intent *can* fail with `NOT_AUTHORIZED` or `GROUP_DELETED` — `addExpense`/`addIncome`/`addTransfer` all call `assertCanCreateInGroup` when `groupId` is set, and that throws the same `NotAuthorizedError` `/api/sync`'s `applyOne` already classifies for updates. Concretely: a member queues "create expense in Group X" while offline, is removed from Group X before the queue drains, comes back online. Sync Center routes a failed *create*-kind intent to `PendingDetailSheet` (`sync-center.tsx`'s `QueueRow` onClick: `i.kind.endsWith(".create") ? openModal("pendingDetail", ...) : openModal("txDetail", ...)`), which has none of the three new early-return cards — it falls through to the old generic line (`FAILURE_COPY[intent.lastErrorCode] || cleanCopy(intent.lastError)`). Since neither code is in `FAILURE_COPY` and neither carries a server `error` string, the user sees a bare "This couldn't be synced," with "Edit & retry" and "Discard" as the only actions — retrying doesn't make sense for either code (no amount of editing restores membership or un-deletes a group), and nothing explains why. `CONFLICT` cannot reach this path (creates never call `checkOverride`), so only the two authorization-failure codes are affected. This is a genuine, currently-shipped gap in Step 5's own scope, not a hypothetical.

### 1.6 — LOW — The "impossible state" defensive branch leaks a raw internal message
**Where:** `checkOverride`, the `if (!old.groupId) throw new Error("Unexpected multi-actor edit on a personal transaction")` branch (`transactions.ts:245`).

This is meant to be unreachable under correct operation (a personal row's `assertCanWrite` only ever permits its own owner, so two actors on a `groupId === null` row should be a contradiction) — but it's a plain `Error`, not a typed one, so `/api/sync`'s catch-all maps it to `{ code: "VALIDATION", error: e.message }` and the raw string reaches the client toast verbatim. Low likelihood, but if a future bug (or the race in 1.1) ever produces this state, the user sees an internal assertion message instead of anything actionable.

### 1.7 — LOW (edge case) — `resolveGroupRole` can pick a nondeterministic role under a data-integrity anomaly
**Where:** `resolveGroupRole` (`authorization.ts:31`), `db.groupMember.findFirst({ where: { groupId, participant: { linkedUserId: actingUserId } } })`.

Nothing in the schema prevents two different `Participant` rows (both owned by the group's creator, both eventually linked to the same real `User` via two separate invitations) from both holding a `GroupMember` row in the same group with different roles. `findFirst` would pick one arbitrarily. There's no unique constraint on `(groupId, participant.linkedUserId)` — only on `(groupId, participantId)`. Narrow, requires either an operator mistake or two accepted invitations for the same person, but worth knowing about before it's someone's actual support ticket.

---

## 2. Security

### 2.1 — LOW-MEDIUM — The write path leaks group-transaction existence to any authenticated caller
**Where:** `classifyAuthFailure` (`route.ts:106`), contrasted with `getTransactionDetail`'s explicit "unauthorized reader gets exactly the same `null` a nonexistent row would produce" design (§10).

Any authenticated user who submits a syntactically valid `expense.update`/`income.update`/`transfer.update`/`tx.delete` intent referencing an arbitrary real transaction ID they have no relationship to gets back `NOT_AUTHORIZED` (row exists, still group-tagged) or `GROUP_DELETED` (row exists, `groupId` now null) rather than a uniform not-found. This confirms the ID belongs to *someone's* group transaction, and roughly when that group stopped existing — no amounts, names, or owners leak. This behavior predates Step 5 (steps 2–3's `NotAuthorizedError` was already distinguishable from `MutationTargetGoneError`'s message text via `/api/sync`'s old catch-all); Step 5 only sharpened the granularity from one distinguishable failure to two. Transaction IDs are unguessable `cuid`s, so the practical exploitability is low, but it is a real, measurable inconsistency with the read path's own stated principle.

### 2.2 — LOW-MEDIUM — `AuditLog` has no declared relation (and no cascade) for either `userId` or `actorUserId`
**Where:** `model AuditLog` (`schema.prisma:508`) — both fields are bare `String`/`String?`, no `@relation`.

Account deletion (`deleteUserAccount`/`deleteMyAccountAction`) or any future cleanup of a `User` row leaves that user's historical `AuditLog` rows in place with a dangling reference — for `userId`, that's arguably intentional (financial history shouldn't disappear with an account), but it means `actorUserId` can end up pointing at a user who no longer exists, with nothing to catch or represent that state. Since nothing currently reads `actorUserId` (see 3.2), this is dormant today, but it's the kind of thing that becomes a NPE or a blank "undefined edited this" the moment 3.2 gets fixed.

---

## 3. Architectural inconsistencies & hidden assumptions

### 3.1 — Two independent gates that are assumed, but not enforced, to always run together
`assertCanWrite` (authorization) and `checkOverride` (versioning/conflict) are two separate function calls, invoked back-to-back by convention in `updateExpense`/`updateIncome`/`updateTransfer`/`softDeleteTransaction`. Nothing ties them together structurally — a future call site (or the two existing ones in 1.3/1.4) can call `assertCanWrite` alone and skip `checkOverride` (by omitting `intent`) without anything flagging that as unusual. The codebase currently gets this right by convention and comments, not by construction.

### 3.2 — `actorUserId` is captured but never surfaced — RFC §5's core deliverable is write-only
**Where:** written in `audit()` (`audit.ts:30`); confirmed absent from `toRowInput` (`activity.ts:59`, which maps a raw audit row to `AuditRowInput` and does not carry `actorUserId` through), from `TimelineEvent` (`lib/activity.ts:32`, no actor field in the type at all), and from every presenter in `lib/activity.ts`.

The RFC's own justification for this column was explicit: *"This is the one new piece of information collaboration actually requires: 'Bob edited this, even though it's filed under Alice.'"* A full schema column, an `audit()` parameter, and five call-site threadings later, there is no code path that reads it back. The History card correctly shows *that* an edit happened (this session's Step 4 fix to `entityHistory` made sure of that), but never *who* made it when that differs from the row's owner. This is the single most concrete "the feature isn't actually done" finding in this audit — it's a display gap, not a data gap, so it's cheap to close, but as shipped today a collaborating group gets zero attribution UI despite the underlying data existing.

### 3.3 — Intent retention/pruning was specified, never built, and would conflict with actor-attribution if built as originally specified
**Where:** `project/offline-sync-spec.md` §18 point 1 ("Intent-table growth... Baked in: 30-day retention + pruning cron + `STALE_INTENT` semantics"); no cron exists (`src/app/api/cron/daily/route.ts` only materializes recurring rules and reconciles balances — confirmed by reading it directly).

Two separate problems compound here. First, the simple one: the `Intent` table has no bound and grows by one row per synced create/update/delete forever — exactly the failure mode the original spec named as the *first* thing to break at scale, with a fix that was designed but never implemented. Second, a new tension Step 5 introduces: if that 30-day pruning cron is ever built exactly as originally specified, it will start silently reintroducing 1.2/1.1-shaped problems for any entity whose real edit history spans longer than 30 days — pruning the very rows `checkOverride`'s actor comparison depends on. `STALE_INTENT`'s 30-day client-side rejection window is a *different* mechanism (rejects intents that waited too long to even attempt syncing) and doesn't protect against this — a perfectly fresh intent can still lose its ability to find an accurate "who wrote this last" answer if the *other* actor's write happened more than 30 days ago and its Intent row was pruned. This wasn't reconciled anywhere in the RFC because the RFC was written before the pruning cron's absence was confirmed.

### 3.4 — Phase 3's "at most one outstanding intent per entity" — already correctly flagged, worth re-confirming
The RFC's own §13 caveat already states this precisely: the invariant holds *within one person's own outbox* and no longer holds *globally* once two different people can each queue independently against the same entity. This audit re-confirms that framing is accurate and that `CONFLICT` handling is the intended (and, in the sequential case, correctly tested) answer to it. No new issue here beyond what's already documented — included for completeness since it's adjacent to 1.1/1.2.

---

## 4. Duplicated logic

### 4.1 — `updateExpense`/`updateIncome`/`updateTransfer` repeat the same seven-step shape almost verbatim
Fetch `old` → type-check → `assertCanWrite` → `checkOverride` → reverse old balances → apply the DB update → reapply new balances → `audit()`. Roughly 35 near-identical lines × 3. This isn't just verbose — it's a real drift risk that already manifested during this engagement: Step 5's `checkOverride` signature change had to be applied in lockstep across all three functions (plus `softDeleteTransaction`), and it would have been easy to update three and miss the fourth. A shared "mutate a transaction" helper parameterized by type-specific balance/update logic would remove this risk, at the cost of an abstraction the codebase's own conventions (documented elsewhere in this project) generally avoid introducing without a second consumer already in hand — noting the tradeoff rather than recommending a specific resolution.

### 4.2 — Taxonomy-code-to-copy mapping has no single source of truth
"What does code X mean to a human" is currently answered in three different places with three different mechanisms: `FAILURE_COPY` (static strings, `pending-detail.tsx`), `SYNC_LOG_DETAIL` (static strings, `offline-context.tsx`), and the bespoke JSX in `NotAuthorizedCard`/`GroupDeletedCard`/`ConflictCard` (`transaction-detail.tsx`, dynamic, built from the intent's own remembered payload). Each was added independently as its taxonomy code was built out across Phases 2/3 and Steps 4/5. None of the three is aware of the other two, so (as 1.5 shows) it's possible for a new code to be handled in one but silently fall through the cracks in another.

---

## 5. Dead / inert code

- **`meta.schemaVersion`** (`lib/offline/db.ts:128`) is written on every `ensureDeviceId()` call and never read anywhere. The spec named it as a migration-detection field; the actual reconciliation logic that would consult it was never built.
- **`AuditLog.actorUserId`** — see 3.2. Not dead in the sense of being unreachable code, but dead in the sense of having no observable effect on anything a user can see.
- **The `NOT_AUTHORIZED`/`GROUP_DELETED` handling gap in `PendingDetailSheet`** (1.5) is the inverse of dead code — live server behavior with no corresponding live client behavior to receive it usefully.

No fully unreachable functions or unused exports were found in the reviewed files beyond the above — the service layer's public surface (`transactions.ts`, `groups.ts`, `invitations.ts`, `authorization.ts`) is consistently used by either `actions.ts`, `/api/sync`, or both.

---

## 6. Maintainability

- **`ConflictSnapshot` is defined twice** — once in `transactions.ts` (server) and once, by hand, in `lib/offline/db.ts` (client), with a comment acknowledging the duplication ("kept as a plain duplicate type... since this file runs in the browser"). The two must be kept in sync manually; nothing would catch a field being added to one and not the other except a runtime shape mismatch.
- **The taxonomy code union is declared three times independently**: `SyncResult["code"]` in `route.ts`, `SyncApiResult["code"]` in `offline-context.tsx`, and implicitly wherever `lastErrorCode` string values are compared (`transaction-detail.tsx`, `pending-detail.tsx`). No shared enum or const array. Adding a tenth code means finding and updating all three (plus, per 4.2, wherever its copy lives) with no compiler help tying them together — TypeScript's structural typing means a typo'd string literal in one place fails silently rather than as a type error.
- **Role requirements are asserted in prose, not data.** `assertCanWrite`'s comment documents "write-account: refused outright," "write: MEMBER role+," "delete: ADMIN role+" — this is correct today, but a reviewer (or a future editor) has to trust the comment against the `if`/`throw` chain rather than reading it off a table. `authorization.ts`'s own doc comment for §2 *does* contain this as a markdown table already (in the RFC) — the code itself doesn't encode it as inspectable data.

---

## Performance opportunities

- **`resolveGroupRole` costs two queries per call** (group lookup + membership lookup) and is invoked independently by `assertCanRead`, `assertCanWrite`, `assertCanCreateInGroup`, and `getTransactionDetail` — each of those re-derives live rather than trusting a cached value, which is the correct security posture (§10's own stated principle) but means a single page load touching several group transactions pays this cost repeatedly with no batching. Not a bug; worth knowing before group-heavy usage patterns (e.g., a future group activity feed) get built on top of it without a batching strategy in mind.
- **`checkOverride`'s conflict-branch queries** (actor name + category name lookups) and `classifyAuthFailure`'s extra query only fire on the rare failure/conflict path — confirmed via direct measurement this session (~65ms/intent for clean batches, unaffected by the actor-aware changes; conflict/override paths add one or two queries only when actually hit). No action needed; noted for completeness since the audit was asked to cover performance.
- **Intent table growth** (3.3) is a performance concern as well as a correctness one — an unbounded, append-only table with a `(userId, entityId, appliedAt)` and a `(entityId, appliedAt)` index will get slower to query and larger to store over time with no plan in place to bound it.

## UX improvements

- The conflict card shows two full snapshots side by side but doesn't highlight which individual fields actually differ, despite the RFC's own §7 asking for "changed fields highlighted." Implemented as two plain cards instead, on the reasoning that they're compact enough to compare at a glance — a real simplification from the spec, not an oversight, but worth naming as a gap against the written design.
- 1.5's dead-end generic failure message for a rejected group-tagged create is the most user-visible gap in this list — it's the one place in the whole collaborative flow where a real user hits a wall with no explanation.
- Split-expense edits remaining online-required (1.3) is an old, known limitation, but it's now also the only remaining place where a collaborative edit can't ever be queued offline at all — worth re-surfacing now that "collaborative edits work offline" is otherwise true everywhere else.

## Future enhancements (already named, not new — collected here for a single reference point)

- Discoverability: no UI surface lets a non-owner find another member's group transaction (flagged at the end of Migration Step 4).
- Ownership transfer: no way to represent a former OWNER as a plain member of their own former group (flagged during the authorization foundation work, steps 1–3).
- `GROUP_DELETED` → "Keep as personal": RFC §8's reassignment recovery is underspecified for the locked-`accountId` non-owner case; implemented as Discard-only instead (flagged during Migration Step 5).
- Field-level merge for non-overlapping concurrent edits: explicitly deferred by the original spec's own §18 point 5, pending real conflict-rate data.
- Intent pruning cron (3.3): specified, never built — and now has a design dependency on 1.2/3.3's tension that didn't exist when it was originally specified.
