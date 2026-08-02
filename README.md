# Ledgerly

**A personal finance and shared-expense tracker that's offline-first from
the ground up — one system instead of five apps.**

Ledgerly tracks every rupee you earn, hold, spend, or are owed, whether
you're online or not, whether you're the only person touching the ledger
or splitting expenses with a whole flat. It started as a solo personal
ledger and grew into a collaborative shared-expense platform on the exact
same schema — no rewrite between phases.

> Full requirements and the original design record live in
> [`project/`](project/) (`Ledgerly PRD.dc.html`, `Ledgerly
> Architecture.dc.html`, and the phase-by-phase RFCs) — these are the
> source-of-truth specs this build implements. This README and
> [`docs/`](docs/) describe the system *as built*, which in a few places
> is more conservative than those original specs; where that's true, it's
> called out explicitly rather than glossed over.

## Table of contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Technology stack](#technology-stack)
- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Database setup & Prisma workflow](#database-setup--prisma-workflow)
- [Running tests](#running-tests)
- [Linting](#linting)
- [Build process](#build-process)
- [Deployment](#deployment)
- [CI pipeline](#ci-pipeline)
- [Folder structure](#folder-structure)
- [Documentation](#documentation)
- [Roadmap](#roadmap)
- [License](#license)

## Features

**Personal finance**
- Accounts (bank, cash, UPI wallet, credit card, investment) with running
  balances.
- Expense/income/transfer logging in under 3 taps; category
  auto-suggestion from a self-reinforcing merchant-rule dictionary.
- Budgets with exactly-once threshold alerts; bills with due-date
  urgency; idempotent recurring transactions.
- Analytics — trend charts, full category breakdown with drill-down.
- A generic CSV/XLSX import wizard — auto-detects the header row even
  through banner rows and repeated month-section labels, maps columns via
  heuristics, flags duplicates, and remembers the mapping for next time.
  The mapping step *is* the adapter for a new source; no code changes
  needed to support one.

**Shared expenses**
- Friends with no signup required; collaborative Groups with
  OWNER/ADMIN/MEMBER roles once you're ready for more than ad-hoc splits.
- Equal/exact/percent/ratio splits, DB-trigger-enforced to always sum
  correctly.
- A deterministic settlement suggester (greedy netting, at most n−1
  transfers) — no AI anywhere in the product, by design.
- Shareable-link invitations that can grant group membership on
  acceptance.

**Lending**
- A personal GAVE/GOT ledger per contact, separate from the group model.
- FIFO automatic settlement with manual-allocation override.
- **Khatabook migration** — import a Khatabook lending ledger (CSV/XLSX)
  straight into Lending from the Import Center: auto-detected, one contact
  per person, repayments settled by the same FIFO engine, an atomic
  balance-verified import, and one-click undo. Not plain transactions.
- Card Billing Intelligence — know exactly which statement cycle a
  card-funded loan belongs to and when to recover it before interest
  accrues.
- Reports: monthly trend, all-time recovery rate, overdue loans, top
  borrowers.

**Offline-first sync**
- Every mutating action queues locally and is guaranteed to reach the
  server — you're never blocked from recording a financial event by a
  bad connection.
- Actor-aware conflict resolution: your own multi-device edits merge
  silently; a real conflict between two different people surfaces a
  clear choice, never a silent overwrite.
- A Sync Center you can actually trust — full queue visibility, not a
  black box.

**Finance Hub**
- A dashboard composed from each module's own service functions, so its
  numbers can never silently diverge from what that module's own page
  shows.
- A unified activity timeline (a pure projection over the existing audit
  log — no second history mechanism) and a unified ⌘K search, including
  a deterministic natural-language query parser ("swiggy in march").

**Production-grade foundations**
- Security headers, rate limiting, sanitized error responses, password
  reset, invitation-token binding — see
  [`docs/deployment.md`](docs/deployment.md).
- WCAG AA color contrast, keyboard-trapped modals, semantic landmarks, an
  automated accessibility test suite.
- 282 unit tests, 79 integration tests against real Postgres, 25 Playwright
  E2E suites across every major flow, ESLint, and CI on every push.

See [`CHANGELOG.md`](CHANGELOG.md) for the v1.1.0 release notes and the
complete milestone history, and each `docs/*.md` for the reasoning behind
the non-obvious choices.

## Screenshots

<!-- TODO: replace with real screenshots/GIFs before publishing.
     Suggested set: Dashboard (desktop + mobile), Transaction quick-add,
     the offline "Waiting to sync" badge going to "Synced", a Group split,
     the Lending Contact Ledger, and the Sync Center. -->

| Dashboard | Transactions | Lending |
|---|---|---|
| _screenshot placeholder_ | _screenshot placeholder_ | _screenshot placeholder_ |

| Offline sync badge | Group split | Sync Center |
|---|---|---|
| _screenshot placeholder_ | _screenshot placeholder_ | _screenshot placeholder_ |

## Technology stack

- **Next.js 15** (App Router) · **React 19** · **TypeScript** ·
  **Tailwind CSS 4**
- **PostgreSQL 16** (Supabase in production) · **Prisma 6**
- **Better Auth** — email + password, sessions in your own database, no
  third-party identity provider dependency
- **Resend** — transactional email (password reset only; optional, see
  [Environment variables](#environment-variables))
- **Upstash Redis** — rate limiting (optional, fails open if unset)
- **Vitest** (unit) + **Playwright** + **@axe-core/playwright** (E2E and
  accessibility)
- **ESLint 9** (flat config, `next/core-web-vitals` + `next/typescript`)
- All money stored as **integer paise** (`BigInt` columns); formatting is
  `Intl.NumberFormat('en-IN')` at the display edge only. Timezone:
  **Asia/Kolkata**, everywhere.

## Architecture

Three strict layers — UI never touches Prisma directly; services never
touch HTTP:

```
src/
├─ app/                    # routes; (app)/ = authed shell, (auth)/ = sign-in/up
│  ├─ actions.ts           # Server Actions: zod-validate → service → revalidate
│  └─ api/                 # Better Auth handler, cron, offline-sync, export, import
├─ components/
│  ├─ shell/               # app chrome + shared primitives (modals, forms, ⌘K palette)
│  ├─ dashboard/           # Finance Hub widgets
│  ├─ lending/             # Lending module UI
│  └─ shared/              # group/shared-expense UI
├─ server/
│  ├─ services/            # domain logic — one file per domain, Prisma lives here
│  ├─ auth.ts / session.ts # Better Auth config + session helpers
│  ├─ email.ts             # Resend integration
│  ├─ rate-limit.ts        # Upstash-backed rate limiting
│  └─ db.ts                # Prisma singleton
├─ lib/                    # pure, framework-agnostic logic — money, dates, settlement,
│  │                       #   search parser, the offline-sync client (lib/offline/),
│  │                       #   the import pipeline (lib/import/) — heavily unit-tested
└─ validators/              # zod schemas; money parsed to paise at this boundary
prisma/schema.prisma        # one schema, every phase — additive only, never rewritten
```

Full explanation of each layer's responsibilities, the server-action-vs-
service-layer boundary, and end-to-end data flow:
[`docs/architecture.md`](docs/architecture.md).

## Getting started

**Prerequisites:** Node.js 20+, and a PostgreSQL 16 database reachable
via a connection string (Docker, a native install, or Supabase all
work).

```bash
git clone https://github.com/DivyeshPatro/Expense_Tracker.git
cd Expense_Tracker
npm install
cp .env.example .env
```

Edit `.env` — see [Environment variables](#environment-variables) below
for the full list; at minimum for local development you need
`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, and
`CRON_SECRET`.

```bash
npx prisma migrate dev      # creates the schema + the split-sum DB trigger
npm run db:seed             # demo user with months of realistic seeded data
npm run dev                 # http://localhost:3000
```

Sign in with the seeded demo account —
**arjun@ledgerly.app / ledgerly-demo** (fictional, local-only) — or sign
up fresh; new users get default categories, a merchant→category
dictionary, and a starter Cash account automatically. If you're planning
to actually use the app, sign up with your own account rather than
building on top of the demo login — its sample history exists to
demonstrate the product, not to be extended.

## Environment variables

Full reference with setup instructions for the two optional integrations:
[`docs/deployment.md`](docs/deployment.md#environment-variables).

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `BETTER_AUTH_SECRET` | yes | Session signing secret (`openssl rand -hex 32`) |
| `BETTER_AUTH_URL` | yes | The app's own public URL |
| `CRON_SECRET` | yes | Authorizes the daily cron route |
| `CARD_ENCRYPTION_KEY` | for Credit Cards | AES-256-GCM key for stored card details (`openssl rand -hex 32`, exactly 64 hex chars). The Credit Cards pages error without it; the rest of the app is unaffected. **Back it up — it is not recoverable.** |
| `RESEND_API_KEY` / `RESEND_FROM` | no | Password-reset email; degrades to server-side logging if unset |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | no | Rate limiting; fails open (no limiting) if unset |

## Database setup & Prisma workflow

```bash
npx prisma migrate dev --name <description>   # create + apply a new migration, local dev
npx prisma migrate deploy                     # apply pending migrations, production — never generates new ones
npx prisma generate                           # regenerate the Prisma Client after a schema change
npm run db:seed                               # (re)seed the demo account
npm run db:reset                              # drop, recreate, migrate, and reseed — local dev only, destructive
```

The schema is one file (`prisma/schema.prisma`) spanning every product
phase — every migration to date has been additive (new tables/columns),
never destructive. A deferred Postgres constraint trigger enforces
`Σ ExpenseSplit.owedAmount = Transaction.amount` at the database level,
not just in application code.

## Running tests

```bash
npm test                    # unit tests (Vitest) — pure logic, no database
npm run e2e:all              # every E2E suite, in order, from a fresh seed
npm run e2e                  # or run a single suite — see package.json for the full list
```

`e2e:all` reseeds the demo account once, then runs every `e2e:*` script
in sequence — several suites depend on state left behind by earlier ones
(see the script comments), so don't cherry-pick out of order without
reseeding first. Run against a production build
(`npm run build && npm start`) rather than `next dev` when timing matters
— dev mode compiles routes on first hit, which skews anything
performance-sensitive.

## Running accessibility tests

```bash
npm run e2e:accessibility
```

Runs axe-core (`@axe-core/playwright`) against sign-in, dashboard,
transactions, lending, analytics, and an open modal. Gates on structural
violations (missing accessible names, broken landmarks, keyboard
reachability); color-contrast findings are reported but don't fail the
run — see the script's own header comment for why, and
[`docs/finance-hub.md`](docs/finance-hub.md) /
[`docs/architecture.md`](docs/architecture.md) for the shared-component
strategy (one modal system, one focus trap) this suite is guarding.

## Linting

```bash
npm run lint
```

ESLint 9, flat config (`eslint.config.mjs`), `next/core-web-vitals` +
`next/typescript`. `.next/`, `node_modules/`, `project/` (design-doc
tooling, not app source), and `prisma/migrations/` are excluded.

## Build process

```bash
npm ci
npx prisma generate
npm run build
```

`next build` needs no live database connection — every DB-backed route
is force-dynamic (session checks read cookies, which opts a route out of
static generation), so nothing queries Postgres at build time.
`DATABASE_URL` must still be a syntactically valid connection string
(Prisma validates its shape at client construction) even without a real
database behind it — this is how CI builds the app without provisioning
Postgres.

## Deployment

Reference target: **Vercel + Supabase**. Full guide, including the two
optional integrations' setup steps, migration/rollback procedure, and
monitoring recommendations: [`docs/deployment.md`](docs/deployment.md).

```bash
npx prisma migrate deploy
# set every variable from the table above in your host's environment config
```

`vercel.json` schedules the daily cron (`/api/cron/daily` — materializes
recurring transactions/bills, reconciles account balances) at 00:30 IST.

Before every release, work through
[`docs/release-checklist.md`](docs/release-checklist.md).

## CI pipeline

`.github/workflows/ci.yml` runs on every PR against `main` and every push
to `main`:

```
checkout → npm ci → prisma generate → typecheck → lint → unit tests → build
```

No database service container is needed (see [Build process](#build-process)
above). E2E and accessibility suites are **not** part of automated CI
today — they're run manually before a release; see
[`docs/deployment.md`](docs/deployment.md#ci-pipeline) for why and what
it would take to change that.

## Folder structure

```
Expense_Tracker/
├── .github/workflows/     # CI
├── docs/                  # architecture, subsystem deep-dives, ADRs, ops guides
│   └── adr/                  # Architecture Decision Records
├── project/                # original PRD/architecture/RFC specs — source of truth for intent
├── prisma/                 # schema, migrations, seed
├── scripts/                 # Playwright E2E drivers, one file per feature area
├── e2e/fixtures/            # sample import files used by import E2E tests
├── src/
│   ├── app/                    # routes, Server Actions, API route handlers
│   ├── components/             # shell (chrome + shared primitives), dashboard, lending, shared
│   ├── server/                  # auth, session, email, rate-limit, db, services/
│   ├── lib/                     # pure logic — money, dates, settlement, search, offline/, import/
│   └── validators/              # zod schemas
├── CONTRIBUTING.md
├── CHANGELOG.md
└── README.md                (this file)
```

Full breakdown of what each directory owns (and, just as importantly,
what it never does): [`docs/architecture.md`](docs/architecture.md#module-boundaries).

## Documentation

| Doc | Covers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | layers, module boundaries, data flow |
| [`docs/offline-sync.md`](docs/offline-sync.md) | Universal Outbox, Intent idempotency, conflict resolution |
| [`docs/lending.md`](docs/lending.md) | the GAVE/GOT ledger, FIFO settlement, card billing |
| [`docs/shared-expenses.md`](docs/shared-expenses.md) | groups, splits, authorization, collaboration |
| [`docs/finance-hub.md`](docs/finance-hub.md) | dashboard composition, activity timeline, search |
| [`docs/deployment.md`](docs/deployment.md) | env vars, Resend/Upstash setup, CI, rollback, monitoring |
| [`docs/backup.md`](docs/backup.md) | what backup/restore capability actually exists today |
| [`docs/release-checklist.md`](docs/release-checklist.md) | the pre-release gate |
| [`docs/adr/`](docs/adr/) | why, not how — the decisions that had a real alternative |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | conventions, testing, commit style, branch/review process |
| [`CHANGELOG.md`](CHANGELOG.md) | release history |

## Roadmap

Not yet built, tracked honestly rather than implied as done:

- Receipt upload/view/replace/delete (Supabase Storage).
- True per-period export (today's export is always the full ledger).
- Intent-table pruning cron (30-day retention is designed for, not yet
  scheduled — see [`docs/offline-sync.md`](docs/offline-sync.md)).
- Background Sync API / offline read snapshots (today's offline support
  is write-queue-only, foreground-triggered — see
  [`docs/offline-sync.md`](docs/offline-sync.md)).
- Discoverability for a non-owner to find another group member's
  transaction from a list view (currently reachable only via direct
  link/search once you know it exists).
- Group ownership transfer.
- Supabase Row-Level Security as defense-in-depth (service-layer
  authorization is enforced today; RLS would be a second layer).
- An automated backup job independent of the hosting provider's own
  backups, and a restore path for the full JSON export — see
  [`docs/backup.md`](docs/backup.md).
- E2E/accessibility suites wired into CI (currently manual, pre-release).

## License

No license is currently declared for this repository (no `LICENSE` file,
no `license` field in `package.json`) — under default copyright, that
means all rights are reserved by the author. If you intend to open-source
this project, choosing and adding a license (MIT, Apache-2.0, or similar)
is a deliberate decision for the repository owner to make explicitly,
not a default to assume.
