# Collaboration Architecture RFC — Group-Based Shared Editing

**Status:** Migration step 4 (UI cutover) implemented (2026-07-17). Steps 1–3 (the authorization
foundation) were completed first: schema migration, `assertCanRead`/`assertCanWrite`/
`assertGroupRole` wired into every mutating service function, group role enforcement
(leave/promote/remove), and invitation/role wiring — §15's exit-criteria suite is green (26/26).
Step 4 makes `TransactionDetailSheet` and the create flow collaboration-aware for non-owner
members (new `CollaborativeEditForm`, group context banner, honest Edit/Delete gating by
`canEditFields`/`canDelete`, locked `accountId` display, group-scoped category picker via
`listGroupCategories`, amount lock + faithful split resubmission when a transaction has an
existing split) — 24 new browser-driven checks (`e2e-collab-ui.ts`), green twice consecutively,
alongside the full 264-check pre-existing regression suite (288/288 total, run twice
consecutively, zero regressions). One §5-specified fix completed as part of this step, not
deferred: `entityHistory`'s audit-log query was still owner-`userId`-scoped, which would have
made a non-owner's History card silently empty the moment step 4 made it reachable — now
OR-extended via `assertCanRead` exactly as §5/§13 already specified.

**Known gap, explicitly deferred by product decision (2026-07-17):** there is currently no UI
surface (transaction list, dashboard, or notification) that lets a non-owner *discover* another
member's group transaction — every existing list/ledger query stays strictly scoped to the
viewer's own `userId`, and `/shared`'s `GroupsPanel` is group membership CRUD only, never a
transaction feed. `TransactionDetailSheet`/`CollaborativeEditForm` are fully correct once reached,
but nothing in the product currently links to them for a non-owner. This was flagged rather than
invented — extending the list/dashboard queries has real implications (would a member's own
dashboard *totals* start including other members' group spending?) that this RFC never addressed,
and the product owner chose to defer discoverability rather than have it designed as a side effect
of Step 4. `e2e-collab-ui.ts` reaches the sheet via a `?tx=<id>` deep link added as test-facing
plumbing (mirrors the existing `/activity?entity=<id>` pattern; `getTransactionDetail` still
no-ops to "no longer exists" for anyone unauthorized). Revisit as its own scoped follow-up.

**Migration step 5 (offline sync layer) implemented (2026-07-17).** `checkOverride` (§6.1/§6.2) is
now actor-aware: the Intent lookup drops the `userId` filter (new `Intent(entityId, appliedAt)`
index) so it can see a *different* real person's prior edit, not just the current actor's own
history. A version mismatch from the SAME real person (any device) still applies silently as LWW,
byte for byte unchanged from Phase 3. A mismatch from a DIFFERENT authorized actor on a group
transaction now throws a new `ConflictError` instead of applying — the whole `$transaction` rolls
back, nothing is written, and `/api/sync` returns the new `CONFLICT` code with a server-resolved
snapshot (amount, merchant, category name, date, notes, the conflicting actor's name — §7). The
conflict card (`ConflictCard` in `transaction-detail.tsx`) renders both versions with [Keep mine]
(requeues against the version that just conflicted, reusing the exact same apply path — no new
server logic) and [Keep theirs] (discards the local intent, no server call). §8's two recovery
scenarios are both implemented: a removed member's queued edit returns `NOT_AUTHORIZED` (Discard
only, copy built from the intent's own remembered `groupName` since the removed member can no
longer read the row at all to look it up fresh); a deleted group's queued edit returns
`GROUP_DELETED` (the FK's `onDelete: SetNull` already orphans the row to personal at the DB level
for free — the taxonomy code just names what happened). Non-owner (collaborative) edits/deletes
now flow through the SAME outbox every solo edit already used — the online-required restriction
Step 4 used as a stopgap is gone, since checkOverride can now safely tell a real second writer
apart from the same person's other device. 20 new checks (`e2e-collab-offline.ts`, hybrid
Prisma+Playwright with two independently-authenticated real users), green twice consecutively,
alongside the full 288-check pre-existing suite (308/308 total, run twice consecutively, zero
regressions — including the pre-existing solo two-device race test, now also verified unaffected
on a group-tagged transaction).

**Known gap, flagged rather than invented (2026-07-17):** §8's "group deleted" recovery specifies
"[Keep as personal] (sets `groupId = null`, `userId` = the acting member)" for a non-owner's
orphaned queued edit. This is well-defined in the *original* single-writer context the copy was
borrowed from (the acting member was always already the row's owner, so "userId = acting member"
was trivially already true) — but for a genuine non-owner, it would mean reassigning the
transaction to someone who was never authorized to pick its `accountId` (locked to the original
owner throughout the whole edit, per §1) into their own account namespace, which the RFC never
specifies how to resolve. Implemented instead: [Discard] only for `GROUP_DELETED`, matching the
sibling `NOT_AUTHORIZED` scenario's "no guided fix" shape. [Keep as personal]'s reassignment
mechanics need their own design pass — likely alongside the deferred ownership-transfer work
(§3.1) rather than invented here.

One implementation-time gap from steps 1–3 found and deliberately deferred, not silently dropped:
ownership transfer (§3.1) needs a small schema decision (there's currently no way to represent a
former OWNER as a plain member of their own former group) — `leaveGroup` blocks an OWNER from
leaving a non-empty group until that's designed, rather than leaving a group ownerless. Open
questions #1 and #4 (§14) stand as adopted defaults, not yet formally confirmed by the product
owner; #2 and #3 are resolved.

Discoverability (a UI surface for a non-owner to find another member's group transaction),
ownership transfer, and the `GROUP_DELETED` → [Keep as personal] mechanics above are the named
follow-ups — none started, all deliberately out of scope for step 5 per the migration's own staged
rollout (§12).

**Product decision this RFC implements (given, not re-litigated here):** *Groups are
collaborative. Any linked participant with permission to a group can edit transactions in that
group, both online and offline.*

**Scope boundary (deliberate, stated up front):** collaboration is activated by
`Transaction.groupId`. A transaction **not** attached to a group — a solo expense, or an ad-hoc
split with a friend who isn't organized into a named group — remains exactly what it is today:
single-writer, owned by one `userId`, untouched by anything in this document. Users who want
collaborative editing organize the split under a Group (already a UI concept). This keeps the
blast radius of Phase 4 to "group transactions" specifically, rather than every split in the
product.

---

## 1. The core modeling decision

Today, `Transaction.userId` means two things at once: "whose Account/Category namespace this
expense is filed against" *and* "who is allowed to touch it." Every service function conflates
them into one `where: { id, userId }` clause. Collaboration requires splitting these apart:

- **`userId` (unchanged meaning, now read-only after creation):** whose private namespace the
  transaction's `accountId`/`categoryId` belong to. If Bob pays for groceries out of his own bank
  account, the transaction is filed under Bob's `userId` — that's *his* money, in *his* books.
- **Authorization to read/write (new):** the transaction's own `userId`, **union** any member of
  `Transaction.groupId` (when set) with sufficient role. `userId` becomes *one* valid path to
  authorization, not the *only* one.

This is why the RFC does not model a group transaction as one row that "belongs to the group" —
it stays filed under whoever recorded it, and group membership is what lets *other* people also
read and edit that row. This preserves the existing Account/Category ownership model completely
(bank accounts are never shared, only the *right to edit an expense entry* is) and avoids forking
the schema into a parallel "shared ledger" data structure.

**Field-level consequence:** `accountId` references a private financial account and stays
editable only by the transaction's own `userId`. Every other field — amount, merchant, category,
date, notes, split shares, `paidByParticipantId` — is editable by any authorized group member.
This is stated once here and referenced by number (§1) throughout the rest of the document
instead of being re-derived per section.

---

## 2. Authorization model

| Action | Personal (`groupId == null`) | Group transaction (`groupId` set) |
|---|---|---|
| Read | `userId` only | `userId`, or any member of `groupId` (any role) |
| Create (in this group) | n/a | any member of `groupId`, MEMBER role+; creator becomes the row's `userId` (§1) |
| Update — `accountId` | `userId` only | the row's own `userId` only (§1) |
| Update — every other field | `userId` only | `userId`, or any member of `groupId`, MEMBER role+ |
| Delete | `userId` only | the row's own `userId`, or any member of `groupId` with ADMIN role+ |
| Read the group's participant roster (needed to construct a valid split edit) | n/a | any member of `groupId`, any role |
| Read categories to label a shared expense | n/a | any member of `groupId`, any role — but scoped to categories already used within that group's own transactions, not the owning member's full private list (revised from the original recommendation — see §10) |

**Authorization is always re-derived live, server-side, at the moment a mutation is applied —
never cached, never trusted from the client, and never decided at intent-*enqueue* time.** A
device that queued an edit while it still had access re-checks access when it finally reaches the
server. This is a direct extension of the existing non-negotiable "server is the sole financial
authority" principle from the original offline-sync spec — nothing new in philosophy, just a
wider definition of "authorized."

**Ghost (unlinked) participants have no role and cannot act.** `GroupMember.role` only takes
effect once the member's `Participant.linkedUserId` is set — an unlinked participant is a label,
not an actor, exactly as today.

---

## 3. Group roles

The schema already declares `GroupRole { OWNER, ADMIN, MEMBER }` — it exists in
`GroupMember.role` today but is never read by any authorization check. This RFC proposes wiring
it up rather than inventing a new enum:

| Role | Can | Cannot |
|---|---|---|
| **OWNER** | everything ADMIN can, plus: rename/delete the group, change any member's role, transfer ownership | — |
| **ADMIN** | add/remove MEMBERS, edit or delete any transaction in the group | remove the OWNER or another ADMIN, delete the group |
| **MEMBER** | create transactions in the group, edit any transaction in the group (§1 field limits apply), delete transactions they created themselves | delete transactions created by someone else, add/remove members, delete/rename the group |

Exactly one OWNER per group (the creator, by default). This is a conventional three-tier model
chosen specifically because it's a zero-schema-cost fit for what's already declared — the
alternative (inventing a finer-grained permission system) isn't justified by anything in the
product decision, which only asked for "permission to a group," not per-field ACLs.

### 3.1 Leaving a group — resolved (2026-07-17, was open question §14 #3)

**Any MEMBER or ADMIN may remove themselves at will** — "leave" is self-targeted removal, and
self-targeting bypasses the normal "only ADMIN+ may remove a member" gate (you never need
someone else's permission to remove yourself). No confirmation flow beyond the client's own
"Leave group?" prompt; the server-side operation is identical to `removeGroupMember`, just
authorized by `actingUserId === targetParticipantId`'s linked user rather than by role.

**The OWNER cannot leave while other members remain** — they must transfer ownership first (a
new, minimal operation: reassign OWNER to a chosen ADMIN or MEMBER, demote themselves to ADMIN,
*then* leave as an ADMIN would). If the OWNER is the last remaining member, leaving is equivalent
to deleting the group (reuses the existing `deleteGroup` path). This avoids "group with no
owner" ever being a reachable state, matching the conventional pattern most collaborative tools
already use (Slack, GitHub orgs, etc.) rather than inventing a Ledgerly-specific rule.

**A departed member's own past transactions do not freeze.** This requires no new mechanism —
it's already the correct consequence of §2's authorization rule: `Transaction.groupId` isn't
touched by a membership change, and any *current* group member (regardless of who authored the
row) is authorized to edit it. Stating it here explicitly because it wasn't spelled out
elsewhere: leaving revokes *group-derived* access, but never retroactively changes who owns which
row.

**A departed member keeps read/write access to transactions where `userId` is their own** — that
authorization path (§2's first column) comes from ownership, not group membership, and leaving a
group doesn't touch it. What they lose is the *second* path: visibility into and editing rights
over every other member's transactions in that group. Concretely — Bob leaves Flat 402; he can
still see and edit expenses he personally recorded there, but loses access to Alice's and
Carol's.

**Leaving and being removed produce the identical end state** (no `GroupMember` row) and are
therefore handled by the identical logic everywhere else in this RFC — §8's offline behavior
("you're no longer part of this group") applies uniformly regardless of whether the departure was
voluntary. No new taxonomy code or copy variant is needed for "you left" vs. "you were removed."

---

## 4. Transaction ownership semantics

Restating §1 as concrete rules:

1. `Transaction.userId` is set once, at creation, to the creating member's own `userId`. It is
   **never reassigned** by an edit — "who recorded this" is immutable, exactly like `createdAt`.
2. `Transaction.groupId` is set once, at creation, from the form the user was in (creating a
   transaction *inside* a group view sets it; creating a personal expense leaves it null). Moving
   a transaction in or out of a group after the fact is out of scope for this RFC — it's a
   different, harder problem (whose namespace does it move to?) that the product hasn't asked for.
3. `accountId` is readable by every authorized viewer but its *value* is intentionally vague to
   non-owning viewers in API responses — see §10 (Security).
4. Soft-delete (`deletedAt`) and restore follow the same authorization rule as delete/undo
   respectively — an ADMIN who deleted someone else's group transaction can also undo it within
   the same UX window; ownership of the *undo* action isn't separately modeled.

---

## 5. Audit attribution

**Gap found in the existing code:** `AuditLog.userId` is filed against the transaction's owner
namespace, not the acting user — every `audit()` call site passes the same `userId` that scopes
the whole service function. There is currently no column recording *who actually performed the
action* when it differs from whose ledger it's filed under. `_sync.deviceId` (stuffed into the
`after` JSON blob by `withSyncMeta`) gets close but only identifies a device, not a person, and
isn't queryable without a JSON scan.

**Proposed:** add `AuditLog.actorUserId String?` (nullable, additive).

- For personal transactions and for a group transaction edited by its own `userId`: leave it
  null, or set it equal to `userId` — either reads correctly as "acted by the ledger owner." No
  existing call site needs to change behavior.
- For a group transaction edited by a *different* authorized member: `actorUserId` = that
  member's session `userId`. This is the one new piece of information collaboration actually
  requires: "Bob edited this, even though it's filed under Alice."

`audit()` gains an optional fifth parameter. Every call site inside a group-authorized mutation
path passes the session's `userId`; every other call site is unchanged.

**Read-path consequence:** `activity.ts`'s Activity Timeline query is scoped
`where: { userId, ... }` today — a non-owning group member querying "history for this
transaction" would see nothing, because the audit rows are filed under the owner's `userId`, not
theirs. The query needs an OR-extension: rows where `userId` matches the viewer, **or**
`entityId` belongs to a transaction whose `groupId` the viewer is an authorized member of. This
is the one non-trivial *read*-path change in the whole RFC; everything else is either additive or
write-path.

---

## 6. Offline synchronization for multiple independent writers

This is the section closest to what Phases 0–3 already built, and most of it needs **no change**
— see §12 for the full unchanged/redesign inventory. The two pieces that do change:

### 6.1 `checkOverride`'s "who did I just overwrite" query

Today (`src/server/services/transactions.ts`):

```ts
const priorIntent = await db.intent.findFirst({ where: { userId, entityId }, orderBy: { appliedAt: "desc" } });
```

This filters by the *current actor's own* `userId` — it can never see an Intent written by a
*different* user against the same entity. Under solo-only writes this was invisible (there was
never a different user), but it's a real bug the moment a second writer exists: Bob's edit would
never detect that Alice's edit landed first, and vice versa.

**Fix:** drop the `userId` filter — the lookup becomes "the most recent Intent against this
entity, from anyone":

```ts
const priorIntent = await db.intent.findFirst({ where: { entityId }, orderBy: { appliedAt: "desc" } });
```

### 6.2 LWW vs. CONFLICT branches on who the two writers are, not just whether the transaction has a group

A version mismatch on a *group* transaction should not automatically mean "block and ask a
human" — if it's the **same person's** two devices (their phone, then their laptop), that's still
just Alice talking to herself, and solo LWW is the right, silent behavior (spec §13, unchanged).
It's only a real conflict when the two writers are **different people**.

```
baseVersion mismatch detected
  → look up the most recent Intent for this entityId (§6.1)
  → compare its actor (Intent.deviceId's owning userId) to the incoming intent's actor
      same actor  → solo LWW: apply anyway, tag OK_OVERRIDE (Phase 3 behavior, unchanged)
      different actor
        transaction has no groupId → defensive reject (INVALID_REF_HARD): this path
                                       shouldn't be reachable for a genuinely solo record
        transaction has a groupId  → CONFLICT (§7): do not apply, park it
```

Everything else in the outbox/drain/batch machinery — per-device IndexedDB, FIFO ordering,
poison-pill parking, backoff, the batched `/api/sync` transport shape — is untouched. A group
member's device is, from the outbox's point of view, just another device with its own queue;
nothing about *how* it drains changes, only *what gets authorized* when it lands.

### 6.3 Authorization inserted into every mutating service function

The single biggest code-touching change in this RFC. Every mutating function currently does:

```ts
const old = await db.transaction.findFirst({ where: { id, userId, deletedAt: null } });
if (!old) throw new MutationTargetGoneError();
```

This conflates "does the row exist" with "is this user allowed to touch it" — a row that exists
but belongs to someone else looks identical to a row that doesn't exist at all, which is exactly
what solo semantics wanted (never leak the existence of another user's data) but is wrong for
group transactions (a real 403 shouldn't look like a 404, and "you were removed from this group"
needs its own honest copy — see §8). The fix separates the two:

```ts
const old = await db.transaction.findFirst({ where: { id, deletedAt: null } });
if (!old) throw new MutationTargetGoneError();
await assertCanWrite(db, actingUserId, old, { field: /* which field, for the accountId lock */ });
```

`assertCanWrite` is new, shared logic: if `old.userId === actingUserId`, allow everything. Else,
if `old.groupId` is set, resolve the acting user's `GroupMember.role` for that group (via
`Participant.linkedUserId = actingUserId` — §9) and check it against §2's table. Else, throw a
new `NotAuthorizedError` (§8) — distinct from `MutationTargetGoneError`, since the remediation
copy is different ("you're no longer part of this group" vs. "this was deleted").

This touches `updateExpense`, `updateIncome`, `updateTransfer`, `softDeleteTransaction`,
`getTransactionDetail`, and the create path for group-tagged expenses. It's mechanical and
repeated, not architecturally novel per call site — one shared `assertCanWrite` helper, five call
sites updated to use it.

---

## 7. Conflict resolution rules

**New taxonomy code:** `CONFLICT` — named in the original spec's table since Phase 1 but never
implemented (nothing could produce it without a second writer). It now gets a real
implementation and a real response shape.

Unlike every other non-OK code so far, `CONFLICT` needs to carry data, not just a message — the
client has its own queued payload but has no idea what the *other* writer's version looks like.
The `/api/sync` response for a `CONFLICT` result includes a snapshot of the current server-side
row (the fields relevant to what changed) so the client can render the exact spec §12 copy:

> *"This changed while you were away."* Two stacked versions — **"Yours · ₹500 · from this
> phone · 2:10 PM"** vs. **"Rohan's · ₹450 · 2:14 PM"** — changed fields highlighted.
> [Keep mine] (requeues against the new version) / [Keep Rohan's] (discards the intent; logged).

- **[Keep mine]:** the client re-enqueues the same edit, but with `baseVersion` bumped to the
  server's current version — this is now an *explicit, human-confirmed* override, so it reuses
  the exact same OK_OVERRIDE apply path from §6.2 (same actor-mismatch branch, just triggered by
  consent instead of happening silently). No new server-side apply logic needed — only the
  decision to reach it changes.
- **[Keep theirs]:** the client discards its local intent (`cancelPending`, already built in
  Phase 2/3) — no server call needed, since the server's current state already reflects "theirs."
- **Field-level merge** (amount and notes edited by different people, both preserved) is
  explicitly out of scope, carrying forward the original spec's own §18 deferral: whole-record
  LWW/conflict now, field-level merge later *if* measured conflict rates justify it. Building it
  speculatively before real usage data exists isn't warranted.

**UI consequence:** the needs-attention view built in Phase 3 (`TransactionDetailSheet`'s status
line + single-column Fix/Discard) doesn't fit a two-version comparison. `CONFLICT` needs its own
card, distinct from the existing Fix/Discard pattern — this is genuinely new UI, not a copy
variant of what exists.

---

## 8. Group removal / membership changes while offline

Two distinct scenarios, two distinct copies (per spec §12's rule: name the thing, plain past
tense, one primary action):

**Removed from the group, group still exists:**
> *"You're no longer part of **Flat 402**, so **₹500 · Groceries** couldn't be saved."*
> [Discard] only — no guided fix exists, since re-gaining access requires being re-invited, which
> isn't something the failed edit can trigger itself.

**The group itself was deleted:**
> *"**Flat 402** was deleted, so this couldn't be saved. Keep it as a personal expense instead?"*
> [Keep as personal] (sets `groupId = null`, `userId` = the acting member — reuses the *exact*
> copy and guided-fix pattern the original spec already wrote for the owner's-own-multi-device
> "group deleted" scenario in §12; it turns out to fit the multi-writer case perfectly, no new
> copy needed) / [Discard]

Both are detected by the same `assertCanWrite` re-check (§6.3) at drain time — never by anything
the client remembered from before it went offline. A removed member's stale queued intent,
replayed at any point in the future, is rejected the same way regardless of how long it sat in
the outbox (this is also the security backstop referenced in §10).

**Schema consequence:** `Transaction.groupId` needs a real `onDelete: SetNull` foreign key
(currently it's a bare unenforced string — see §9). Deleting a group must never cascade-delete
real financial history; it should orphan the transaction back to a personal record under its own
`userId`, matching exactly how `categoryId` already behaves when a category is deleted (spec §5's
existing `INVALID_REF_SOFT` precedent — same pattern, different field).

---

## 9. Invitation acceptance effects

Today, `Invitation` is tied to exactly one `participantId` and accepting it only sets
`linkedUserId` — a 1:1 friend link, nothing group-related.

**Proposed:** extend `Invitation` with two new nullable columns: `groupId String?` and
`role GroupRole?` (default `MEMBER` when a groupId is present). `createInvitation` gains an
optional group/role argument; `acceptInvitation` becomes atomic:

```ts
await prisma.$transaction(async (db) => {
  await db.participant.update({ where: { id: invitation.participantId }, data: { linkedUserId: userId } });
  await db.invitation.update({ where: { token }, data: { status: "ACCEPTED" } });
  if (invitation.groupId) {
    await db.groupMember.upsert({
      where: { groupId_participantId: { groupId: invitation.groupId, participantId: invitation.participantId } },
      create: { groupId: invitation.groupId, participantId: invitation.participantId, role: invitation.role ?? "MEMBER" },
      update: {},
    });
  }
});
```

Plain 1:1 invitations (no `groupId`) behave exactly as they do today — this is additive, not a
replacement.

**New member's visibility into existing history:** recommended default is full retroactive
access — the group's transaction history is a shared ledger, and hiding pre-join history would
be more confusing than useful, and it's also the simplest rule to implement correctly (§5's
audit-visibility query is keyed on *current* membership, not join date, and that's the version
that needs no extra "joined-at" bookkeeping). Flagging this explicitly as a product call, not a
purely technical one — happy to revisit if the product owner wants a join-date cutoff.

**A required index this depends on:** resolving "which groups is user X an authorized member of"
requires joining `GroupMember → Participant WHERE Participant.linkedUserId = X` — a query that
runs on essentially every group-transaction request. `Participant` currently has no index on
`linkedUserId`. Add `@@index([linkedUserId])`.

---

## 10. Security considerations

- **Authorization is always re-derived live, never trusted from the client or cached across a
  session** — stated in §2, repeated here because it's the load-bearing security property of the
  whole design. A removed member's queued intent, or a forged `groupId` on a create payload, is
  worthless without a live, server-side `GroupMember` row backing it up.
- **`accountId` is a privacy boundary, not just a write lock.** §1/§4 already lock *writes* to the
  owning member; reads need the same care. `getTransactionDetail`'s response, when the viewer is
  an authorized group member but not the transaction's own `userId`, should not expose the
  owner's account name/type/balance-adjacent metadata — show something generic ("paid from
  Alice's account") rather than the real account label. This is a genuinely new
  response-shaping requirement on the read path, not just a new check on the write path.
- **Category exposure is a smaller risk than account exposure, but still scoped narrowly — resolved
  (2026-07-17).** Categories carry no sensitive financial detail (a name, an icon,
  EXPENSE/INCOME), so this is a deliberately more permissive boundary than the account lockdown
  above — but "any co-member's full private category list" was rejected as broader than
  necessary: a member's personal categories unrelated to the group (e.g. a solo "Gym membership"
  category) have no reason to be visible to their flatmates. **Resolved scope: a group member may
  read only the categories already referenced by at least one existing transaction within a group
  they share** — `SELECT DISTINCT categoryId FROM Transaction WHERE groupId = X`, no schema
  change, a new read-only service function scoped by group rather than by owner. This is
  naturally self-bootstrapping (the set grows as the group's shared expenses get categorized) and
  needs no new join table.

  Two consequences worth stating: (1) when a member creates a *new* group transaction (filed
  under their own `userId`, per §1), they use their own full category list as normal — the
  narrower scope only applies when a *non-owning* member edits someone else's existing
  transaction. (2) the very first categorized expense in a brand-new group has no prior
  categories to draw from; in that case the category field is left uncategorized/null for
  non-owning editors rather than falling back to the owner's full list — categorization by a
  non-owner is only available once the group has at least one categorized transaction to seed
  the shared set from.
- **Removed-member replay is closed by §6.3/§8's live re-check, not by anything client-side.**
  There is no code path where a stale local "am I still a member" cache is consulted for a
  security decision — only for optimistic UI (e.g., graying out an edit button before the server
  confirms), which is allowed to be wrong and simply gets corrected when the real request lands.
- **Cross-tenant leakage is the biggest new risk class this phase introduces**, and it's a risk
  in the *correctness* of `assertCanWrite`, not in any offline-specific mechanism. A bug that lets
  Bob touch a transaction outside any group he shares with its owner is the single most damaging
  failure mode here. **Recommend this gets dedicated negative-path test coverage as a hard exit
  criterion** — not just "Bob can edit group transactions he's a member of," but "Bob cannot edit
  Alice's personal transactions, and cannot edit a *different* group's transactions even if he's
  a member of some other group with Alice."
- **Rate limiting, session lifetime, device-encryption reliance** — all unchanged from the
  existing model (Better Auth defaults, 30-day sessions, OS-level storage encryption). Nothing
  about multi-writer access changes the threat model at this layer.

---

## 11. Database / schema changes

All additive; no destructive migration; no existing row needs to change.

| Change | Table | Nullable/default | Why |
|---|---|---|---|
| Add real FK + index | `Transaction.groupId` | already nullable; add `@relation(..., onDelete: SetNull)` + `@@index([groupId])` | currently a bare, unenforced string — needs to actually reference `Group` and cascade-null on group deletion (§8), and needs an index since it becomes a live authorization-path lookup |
| New column | `AuditLog.actorUserId String?` | nullable, no default | who acted, distinct from whose ledger (§5) |
| New columns | `Invitation.groupId String?`, `Invitation.role GroupRole?` | both nullable | atomic group-invite acceptance (§9) |
| New index | `Participant.linkedUserId` | — | hot path for "what am I authorized to touch" (§9) |
| No change | `GroupMember.role` | already exists, already defaulted `MEMBER` | just start enforcing it (§3) |
| No change | `Intent` table shape | — | still correct as-is (§12) |

Nothing here requires a data backfill: `groupId` is null on every existing row (nothing writes it
today), `actorUserId` defaults to a safe "null means owner acted" reading, and `Invitation`'s new
columns are simply absent on every historical invitation.

---

## 12. Migration strategy

Rollout in dependency order, each step independently shippable and safely stoppable:

1. **Schema migration** — every change in §11, all additive, zero behavior change. Safe to
   deploy alone; nothing reads the new columns/relations yet.
2. **`assertCanWrite` + the five call-site updates (§6.3), shipped but not yet reachable** — no
   UI surfaces group-collaborative editing yet, so this is pure plumbing under a code path that
   only personal transactions currently exercise (and for those, `assertCanWrite` short-circuits
   on `old.userId === actingUserId`, identical to today's behavior). Covered by the new
   positive/negative authorization test suite (§10) before moving on.
3. **Group invitation + role wiring (§9)** — `createInvitation`/`acceptInvitation` extended;
   still no UI lets a non-owner *edit* anything yet, so this only changes who *can* act, not what
   the product does.
4. **UI cutover** — `TransactionDetailSheet` and the create flow become group-aware for
   non-owner members; this is the first user-visible change in the whole rollout.
5. **Offline sync layer** — §6.1/§6.2's `checkOverride` changes, the `CONFLICT` taxonomy code and
   its response shape, the conflict-card UI, §8's group-removal copy. Deliberately last, because
   a multi-writer conflict can only be tested meaningfully once real multi-writer authorization
   (steps 2–4) already works online.

Each step can be rolled back independently by simply not shipping the next one — there's no
point in this sequence where an in-flight step leaves data in a state the previous step can't
still read correctly, because every change up through step 4 is either additive or gated behind
authorization that defaults to "just the owner" until the UI actually offers otherwise.

---

## 13. Component inventory — unchanged vs. redesigned

**Unchanged, as built in Phases 0–3:**
- IndexedDB shape: `outbox`, `syncLog`, `meta` stores; `OutboxIntent`/`SyncLogEntry` types.
- `nextSeq()` FIFO ordering; the drain ladder (mount / `online` / `visibilitychange` / 30s tick).
- Poison-pill parking (24h/20 attempts) and exponential backoff — per-actor mechanics with no
  ownership assumption in them at all.
- `Intent` table shape and its composite `(userId, id)` primary key.
- `exactlyOnce()` (create idempotency) and `exactlyOnceMutate`'s pre-check-by-intentId — both
  already keyed by *actor*, which turns out to already be the right key for a multi-writer world.
- Everything about solo (`groupId == null`) transactions — Phase 0–3 behavior, byte for byte.
- Category/account soft-heal (`INVALID_REF_SOFT`) and hard-fail (`INVALID_REF_HARD`) for the
  solo path.
- Sync Center, device identity, `syncLog` locality, the "device name appears exactly twice"
  rule for the *solo* OK_OVERRIDE copy path.
- `/api/sync`'s transport shape: ordered array in, sequential processing, ordered results out.
- Session/auth model (Better Auth, 30-day sessions, cookie cache).
- `enqueueMutation`'s per-outbox coalescing (still correct for what it does — see the one caveat
  below).

**Redesigned:**
- `checkOverride`'s Intent lookup (§6.1) and its LWW-vs-CONFLICT branch (§6.2).
- The `where: { id, userId }` pattern in every mutating service function, split into
  existence-check + `assertCanWrite` (§6.3).
- `/api/sync`'s `applyOne` — gains the authorization resolution step per intent.
- `TransactionDetailSheet` — new conflict-card view, `accountId` field lock for non-owner
  editors, group-context awareness.
- `listParticipants` / category listing reads — group-scoped cross-user extensions (§2).
- `activity.ts`'s audit query — OR-extended for group visibility (§5).
- `audit()` — new optional `actorUserId` parameter.
- Invitation flow — `groupId`/`role` carrying, atomic membership grant on accept (§9).
- Taxonomy: `CONFLICT` gets a real implementation; a new not-authorized code for §8's
  "removed from group" scenario.

**One caveat on an "unchanged" item, worth flagging honestly:** Phase 3's "at most one
outstanding intent per entity" invariant was true *within a single user's own outbox* and stays
true there — but it's no longer true *globally* once two different people can each have their own
queued edit against the same group transaction, one in Alice's outbox and one in Bob's. That's
correct and expected (they really are two independent intents, not something to coalesce), but
it's the reason §6.2's actor-comparison logic has to exist at all — the client-side invariant
that made Phase 3's conflict handling simple no longer holds server-side, and §7's `CONFLICT` path
is what replaces it.

---

## 14. Open questions — status (2026-07-17)

1. **Retroactive history for new members (§9):** full access by default. **Adopted as the
   working default**, not yet formally confirmed by the product owner — revisit if it turns out
   to matter in practice.
2. **Category read exposure (§10):** *resolved, not the original recommendation* — scoped to
   categories already used within the shared group, not a co-member's full private list. See §10
   for the full design.
3. **Leaving a group:** *resolved* — see §3.1. Self-removal at MEMBER+, OWNER must transfer
   ownership first, departed members' past transactions never freeze, leaving and being removed
   are handled identically everywhere.
4. **[Keep mine]'s explicit-override audit copy (§7):** **Adopted as the working default** (yes,
   it should read differently from a silent solo `OK_OVERRIDE`) — not yet formally confirmed,
   exact copy still to be written when §7 is implemented.

Question 3 was the one blocking item; it's resolved. Implementation of the foundation (§§1–5,
§11–12 steps 1–3, exit criteria in §15) may proceed. 1 and 4 remain revisitable defaults, not
locked decisions — flagging again here so they aren't mistaken for settled just because
implementation has started.

---

## 15. Exit criteria — authorization foundation (migration steps 1–3)

Formalizing §10's test-coverage recommendation as explicit, required exit criteria for the
foundation work (schema + `assertCanWrite` + invitation/role wiring), before moving on to UI
cutover or the offline-sync layer. All of these are **new tests**, exercising `assertCanWrite`
and the five updated service-function call sites directly (not through the UI, since no UI
surfaces group-collaborative editing until migration step 4).

**Positive paths — a member with the right role can act:**
- A group MEMBER can create a new transaction tagged with that group's `groupId`.
- A group MEMBER can edit every field of a transaction created by a *different* member of the
  same group, except `accountId`.
- A group ADMIN can delete a transaction created by a different member; a plain MEMBER can delete
  only their own.
- A group OWNER can do everything an ADMIN can, plus rename/delete the group and change roles.
- A departed member (left or removed) retains full access to transactions where they are the
  `userId`, even with no `GroupMember` row remaining (§3.1).

**Negative paths — the cross-tenant leakage risk named in §10:**
- A user who is *not* a member of a transaction's group cannot read, edit, or delete it.
- A user who is a member of some *other* group cannot touch a transaction in a group they don't
  share with its owner, even though they have *a* valid `GroupMember` row somewhere.
- A plain MEMBER cannot set or change `accountId` on a transaction they don't own, even if every
  other field in the same request is otherwise valid (the lock is field-level, not
  request-level — a request touching multiple fields must reject the whole write if it includes
  a disallowed `accountId` change, not silently drop just that field).
- A plain MEMBER cannot delete a transaction created by someone else.
- A MEMBER cannot add/remove other members or rename/delete the group; an ADMIN cannot remove the
  OWNER or another ADMIN, or delete the group.
- A user removed from a group (or who left) loses access to every other member's transactions in
  that group on their *very next* request — no caching or stale-permission window.
- An unlinked (ghost) participant's `linkedUserId` being null is never sufficient to authorize a
  write, regardless of what role is stored against them.

**Read-path scoping:**
- A group member can list only the categories already used in a group they share (§10); they
  cannot enumerate another member's full private category list via any exposed query.
- A group member reading a transaction they don't own never receives the owner's real account
  name/type/balance metadata in the response (§10) — only a generic "paid from {name}'s account"
  form.

This suite is the hard gate for moving from migration step 3 to step 4 (§12) — UI work on
non-owner editing doesn't start until every case above has a passing test.
