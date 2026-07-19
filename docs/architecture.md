# Architecture

Ledgerly is a Next.js 15 (App Router) application with three strict
layers: **UI never touches Prisma directly; services never touch HTTP.**
This document explains what each layer is responsible for and how data
flows between them. For *why* particular decisions were made rather than
*what* the code does, see [`docs/adr/`](adr/).

## Layers

```
┌─────────────────────────────────────────────────────────────┐
│  UI (src/app, src/components)                                │
│    Server Components read via service functions directly.    │
│    Client Components mutate via Server Actions.               │
└───────────────────────────┬────────────────────────────────────┘
                             │  actions.ts: zod validate → service → revalidate
┌───────────────────────────▼────────────────────────────────────┐
│  Validators (src/validators)                                   │
│    Zod schemas — money parsed to integer paise at the boundary. │
└───────────────────────────┬────────────────────────────────────┘
                             ▼
┌──────────────────────────────────────────────────────────────┐
│  Service layer (src/server/services)                          │
│    Domain logic, authorization, Prisma queries, audit writes. │
│    One file per domain (transactions, lending, groups, ...).  │
└───────────────────────────┬────────────────────────────────────┘
                             ▼
┌──────────────────────────────────────────────────────────────┐
│  Prisma (prisma/schema.prisma, src/server/db.ts)               │
│    Single schema spanning every phase. A deferred Postgres     │
│    trigger (split-sum) is the final arbiter the app can't      │
│    bypass even with a bug.                                     │
└──────────────────────────────────────────────────────────────┘
```

`src/lib/` sits beside all of this, not inside it: framework-agnostic,
pure, heavily unit-tested logic (money math, date formatting, the
settlement algorithm, the search parser) that both the service layer and
client components import. If a function doesn't touch Prisma, HTTP, or
React, it belongs in `lib/`, not `server/services/`.

## Module boundaries

| Directory | Owns | Never does |
|---|---|---|
| `src/app/` | routing, page composition, Server Actions (`actions.ts`) | direct Prisma access from a Client Component |
| `src/components/` | presentation — `shell/` (app chrome + shared primitives), `dashboard/`, `lending/`, `shared/` (feature-specific) | business logic beyond client-side derived display state |
| `src/server/services/` | domain logic, one file per domain, authorization checks, Prisma queries, audit writes | HTTP concerns (no `NextResponse`, no reading headers/cookies directly — that's `session.ts`'s job) |
| `src/server/` (root files) | cross-cutting server infrastructure: `auth.ts`, `db.ts` (Prisma singleton), `session.ts`, `email.ts`, `rate-limit.ts` | domain logic |
| `src/lib/` | pure, framework-agnostic logic shared by server and client | Prisma, HTTP, React |
| `src/validators/` | zod schemas — the one place money strings become integer paise | business logic beyond input shape validation |
| `prisma/` | the single schema (all phases), migrations, seed data | — |

## Server Actions vs. the service layer

`src/app/actions.ts` is intentionally thin: every exported action follows
the same shape — `requireUser()` for session scoping, zod-validate (or
delegate validation to the service call), call exactly one service
function, `revalidatePath()` on success, normalize errors through a
shared `fail()` helper. Actions never contain business logic themselves;
if you're writing an `if` statement that decides whether a mutation is
allowed, it belongs in the service layer, not here.

This separation exists because the service layer has a second caller
besides Server Actions: `POST /api/sync` (see
[`offline-sync.md`](offline-sync.md)) calls the same service functions
directly, batched, for offline-queued mutations. A business rule written
into `actions.ts` instead of the service layer would only apply to
online writes — a real, easy-to-introduce bug class this boundary exists
specifically to prevent.

## The validation layer

Every zod schema in `src/validators/index.ts` is the single source of
truth for input shape — server actions and `/api/sync` both validate
through the same schemas, so an offline-queued mutation is held to
exactly the same rules as an online one. Money enters the system as a
user-typed rupee string and is parsed to integer paise **once, at this
boundary** (`toPaise`, `src/lib/money.ts`) — nothing downstream ever
re-parses a currency string.

## The service layer

One file per domain (`transactions.ts`, `lending.ts`, `groups.ts`,
`bills.ts`, ...). A service function is responsible for its entire
transaction boundary: authorization check, the actual Prisma mutation
(inside a `$transaction` when it touches more than one table), and the
audit log write, all together — never split across a service function
and its caller. Patterns that recur across every mutating service
function:

- **`assertCanWrite`/`assertCanRead`** (`authorization.ts`) — re-derived
  live on every call, never cached, never trusted from the client. See
  [`shared-expenses.md`](shared-expenses.md) for the full authorization
  model this backs.
- **Reverse-then-apply for balance changes** — an edit reverses the old
  transaction's effect on account balances before applying the new one,
  inside the same transaction, so a balance is never computed from a
  diff that could be wrong under concurrent writes.
- **`audit()`** — every mutation appends an `AuditLog` row with a
  before/after JSON snapshot; this is the only writer, and it's the sole
  data source for the Activity Timeline (see
  [`finance-hub.md`](finance-hub.md)) — a pure projection, not a second
  history mechanism.
- **Exactly-once via the Intent table** — mutations reachable from
  offline sync insert an `Intent` row inside the same transaction as the
  mutation itself; see [`offline-sync.md`](offline-sync.md).

## The Prisma layer

One schema (`prisma/schema.prisma`) spans every product phase — there
was never a rewrite between the personal-ledger phase, the shared-expense
phase, and the lending/offline-sync phases, by design (see the project's
own stated goal of never rewriting the schema to add a phase). `src/server/db.ts`
exports a single memoized `PrismaClient` instance (reused across hot
reloads in development).

**The database itself enforces invariants the application layer can't be
trusted to always get right:** a deferred constraint trigger guarantees
`Σ ExpenseSplit.owedAmount = Transaction.amount` on every commit, not
just on the code path that happens to remember to check. This is a
deliberate belt-and-suspenders choice — application-level validation
catches most mistakes before they reach the database, but the trigger is
what makes a violation *structurally impossible* rather than merely
unlikely.

## UI organization and the shared component strategy

`src/components/shell/` holds app chrome (sidebar, top bar, modals, ⌘K
palette, toasts) and — importantly — the small, generic primitives every
feature-specific form reuses (`Field`, `AmountInput`, `DateField`,
`useFocusTrap`, `useSubmit`). Feature-specific UI lives in its own
directory (`dashboard/`, `lending/`, `shared/`) and imports from `shell/`,
never the reverse — `shell/` has no dependency on any specific feature.

The modal system is a single shared `Modals()` component
(`src/components/shell/modals.tsx`) that switches on a `ModalType` and
renders the right form — one dialog, one focus trap, one set of ARIA
attributes, covering every "add/edit X" surface in the app, rather than
fifteen independent modal implementations each needing its own
accessibility work.

## Data flow: a mutation, end to end

1. A Client Component calls `enqueueMutation()` (writes through the
   offline outbox — see [`offline-sync.md`](offline-sync.md)) or, for
   non-outbox-routed writes, a Server Action directly.
2. The Server Action (or `/api/sync`'s batch handler) validates the
   payload against the shared zod schema.
3. The relevant service function re-derives authorization, opens a
   `$transaction`, reverses old effects, applies new effects, writes the
   `Intent` row (if applicable) and the `AuditLog` row.
4. Postgres's own trigger is the last checkpoint before commit.
5. On success, `revalidatePath()` invalidates the Next.js Server
   Component cache for affected routes — the existing Server Component
   read model **is** the pull side of sync; there's no separate "refresh"
   API.

## Data flow: a read

Server Components call service-layer read functions directly (no HTTP
round trip, no client-side fetch) — `requireUser()` for session scoping,
then straight into e.g. `listAccountRows(userId)`. Several hot read paths
(`listAccountRows`, `lendingBalances`, `listCategories`) are wrapped in
React's `cache()` so that when a page composes several components that
each need the same data (see [`finance-hub.md`](finance-hub.md)'s
dashboard composition), it hits Postgres once per request, not once per
component.

## Security posture

Covered in depth by each subsystem doc, but the cross-cutting pieces:
security headers and rate limiting live in `src/middleware.ts` (Edge
Runtime — see its own comments for why `@upstash/redis`'s edge-safe
import path matters there specifically); authentication is Better Auth
with httpOnly session cookies; every server action and service function
scopes to `requireUser()`'s session, never a client-supplied user id;
raw internal errors (Prisma exceptions, unexpected throws) are sanitized
before reaching the client — see `src/app/actions.ts`'s `fail()` and
`src/app/api/sync/route.ts`'s catch blocks.

## Where to look next

- [`offline-sync.md`](offline-sync.md) — the Universal Outbox, conflict
  resolution, sync protocol.
- [`lending.md`](lending.md) — the personal lending ledger.
- [`shared-expenses.md`](shared-expenses.md) — groups, splits,
  collaboration.
- [`finance-hub.md`](finance-hub.md) — the dashboard and activity
  timeline.
- [`adr/`](adr/) — why, not how.
