# Shared Expenses

Shared expenses let a transaction be split with other people — from an
ad-hoc "friend" who never signs up, to a collaborative Group where
multiple real accounts can read and edit the same transactions. This
document covers the group/split/settlement model and the authorization
rules that make multi-writer collaboration safe; for how concurrent edits
are synchronized and reconciled, see [`offline-sync.md`](offline-sync.md).

## The core modeling decision

A shared expense is not a different kind of object — it's a normal
`Transaction` with a split attached. `Transaction.userId` means two
separable things, and keeping them separate is what makes collaboration
possible without forking the schema:

- **Whose private namespace it's filed under** — which `Account`/
  `Category` the expense belongs to. If Bob pays for groceries from his
  own bank account, the transaction is filed under Bob's `userId`,
  because that's his money, in his books. This is set once at creation
  and never reassigned.
- **Who is authorized to read or write it** — the transaction's own
  `userId`, **union** any member of `Transaction.groupId` (when set)
  with sufficient role. Ownership is one valid path to authorization, not
  the only one.

A transaction not attached to a group — a solo expense, or an ad-hoc
split with a friend who isn't organized into a named Group — stays
exactly what it's always been: single-writer, owned by one `userId`,
untouched by any of the collaboration rules below. Collaboration is
activated specifically by `Transaction.groupId`.

## Participants, Groups, and roles

**`Participant`** is a "friend" in your own contact list — no signup
required. A participant becomes a real, authorized collaborator only once
its `linkedUserId` is set (they accepted an invitation). Until then it's
a label, not an actor: it can be a split payee, but it can't authorize
anything.

**`Group`** is a collaborative expense group. Its creator is its
*implicit* OWNER — deliberately no `GroupMember` row is created for them.
Every other member's role lives in `GroupMember.role`:

| Role | Can | Cannot |
|---|---|---|
| **OWNER** | everything ADMIN can, plus rename/delete the group, change any member's role | — |
| **ADMIN** | add/remove MEMBERS, edit or delete any transaction in the group | remove the OWNER or another ADMIN, delete the group |
| **MEMBER** | create transactions in the group, edit any transaction in the group (field limits below apply), delete only what they created | delete someone else's transaction, manage members, delete/rename the group |

A group's roster is always expressed through `Participant`, never
directly through `User` — the canonical identity source is the group
creator's own contact list.

**Leaving a group:** any MEMBER/ADMIN can remove themselves at will. The
OWNER cannot leave while other members remain (ownership transfer isn't
built yet — a known, deliberately deferred gap; leaving as the *last*
member is equivalent to deleting the group). A departed member's own past
transactions never freeze — they keep read/write access to rows where
they're the `userId`, via the ownership path, independent of group
membership. What they lose is visibility into everyone *else's*
transactions in that group.

## What's authorized, field by field

| Action | Personal (`groupId` null) | Group transaction |
|---|---|---|
| Read | `userId` only | `userId`, or any member of `groupId` |
| Update — `accountId` | `userId` only | the row's own `userId` only |
| Update — every other field | `userId` only | `userId`, or any MEMBER+ of `groupId` |
| Delete | `userId` only | the row's own `userId`, or ADMIN+ |

`accountId` stays locked to the row's own owner because it references a
private financial account — bank accounts are never shared, only the
*right to edit an expense entry* is. Every other field (amount, merchant,
category, date, notes, split shares) is editable by any authorized group
member. Authorization is always re-derived live, server-side, at the
moment a mutation is applied — never cached, never trusted from the
client, and never decided at the moment an offline intent was queued. A
device that queued an edit while it still had access re-checks access
when it finally reaches the server; see [ADR 0008](adr/0008-lww-conflict-resolution.md)
and [`offline-sync.md`](offline-sync.md) for what happens if access was
revoked in between.

## The split model

`ExpenseSplit` records how much each participant (or the owner) owes for
a transaction. The sum of split amounts must equal the transaction's
total — enforced by a deferred Postgres constraint trigger, not just
application code, so it can never silently drift even from a bug.

Split modes: **equal** (remainder paise go to the payer), **exact**
(explicit per-person amounts), **percent**/**ratio** (proportional
shares, floored to paise with the remainder to the payer). All are live
end-to-end. A fifth schema value, `CUSTOM`, exists but nothing in the
product sets it.

## Paid-by and balance calculation

Every split records who actually paid (`paidByParticipantId`, defaulting
to the transaction owner). Net balances between the owner and each
participant are `Σ(what they were owed) − Σ(what they owed)` — the same
signed-paise convention the Lending module reuses (see
[`lending.md`](lending.md)): positive means they owe you, negative means
you owe them.

## Settlement

`src/lib/settlement.ts` implements a deterministic, no-AI settlement
suggestion engine: greedy largest-debtor-to-largest-creditor matching.
Debtors and creditors are each sorted descending by amount owed; at each
step, the largest debtor pays the largest creditor `min(their two
amounts)`, whichever side reaches zero advances. This guarantees **at
most n−1 transfers** to zero out n people's balances — provably fewer
transactions than settling every pairwise debt individually. An epsilon
threshold absorbs paise-level rounding dust so near-zero balances never
produce a spurious tiny "settle ₹1" suggestion.

Recording an actual settlement (`Settlement` — direction + method: UPI,
cash, bank) is separate from the *suggestion* — the algorithm only
recommends who should pay whom; nothing is automatic.

## Invitation flow

An `Invitation` ties to one `Participant` and, optionally, a `groupId` +
`role`. Accepting is atomic: the participant's `linkedUserId` is set, the
invitation is marked accepted, and — if a group was attached — group
membership is granted in the same transaction. Plain 1:1 friend
invitations (no group) behave exactly as they always have; this is
additive, not a replacement.

Invitations are **link-only** — no email delivery is wired up by default
in the base flow (the inviter shares a `/invite/[token]` link directly),
though the app does have a transactional-email path available via Resend
for the cases that need it (password reset; see
[`deployment.md`](deployment.md)). New members get full retroactive
access to a group's history by default — hiding pre-join history was
judged more confusing than useful, and it avoids needing any
join-date bookkeeping.

## Activity timeline attribution

Because a group transaction can now be edited by someone other than its
owner, the audit log needed a way to distinguish "whose ledger this is
filed under" from "who actually made this specific edit" —
`AuditLog.actorUserId` (nullable; null means the row's own owner acted).
The Activity Timeline's history query is extended accordingly: a
non-owning group member asking "what happened to this transaction" sees
the full history, not just edits filed under their own `userId`. See
[`finance-hub.md`](finance-hub.md) for how the Activity Timeline itself
is built.

## Security notes

- **`accountId` is a privacy boundary, not just a write lock.** A
  non-owning viewer's transaction detail response never exposes the real
  account name/type/balance — a generic "paid from Alice's account" form
  instead.
- **Category exposure is scoped to what's actually been used in the
  group** — a non-owning editor sees only categories already referenced
  by an existing transaction in a group they share, not a co-member's
  full private category list. The very first categorized expense in a
  brand-new group has nothing to draw from yet, so non-owning editors
  leave it uncategorized until the group has seeded its own shared set.
- **Cross-tenant leakage** (a member of one group touching a transaction
  in a *different* group they don't share with its owner) is the
  single most damaging failure mode this model introduces, and is
  covered by dedicated negative-path test coverage — not just "can an
  authorized member act," but "can an unauthorized one, even with *some*
  valid group membership elsewhere, definitely not."

See [`project/collaboration-architecture-rfc.md`](../project/collaboration-architecture-rfc.md)
for the complete original design record, including the full migration
history and every open question's resolution.
