# Ledgerly — Personal Finance & Shared Expense Tracker

## The goal

Track every rupee I earn, hold, spend, or am owed — in one place, in under
3 taps to log — starting as a single-user finance app and growing into a
Splitwise-style shared-expense platform for roommates, **without ever
rewriting the schema**. Think Splitwise + Google Finance + Apple Wallet +
Money Manager + Walnut + Notion, but as one system instead of five apps.

Concretely, that means:

- **A personal ledger first.** Every account (bank, cash, UPI wallet, credit
  card), every expense/income/transfer, budgets, bills, recurring
  transactions, analytics — fully usable solo, day one.
- **A shared-expense platform second, on the same data.** When roommates
  join later, a shared expense is just a personal transaction with a split
  attached — not a different system bolted on.
- **Deterministic, not AI.** Search, auto-categorization, settlement
  suggestions, and future data import are all rule-based. No LLM calls
  anywhere in the product — a standing constraint, not a phase-1 shortcut.
- **A real migration path.** Historical expenses currently tracked in
  another app (Monito) get imported losslessly once this is stable, via a
  generic import engine designed to take other sources later (bank
  statements, Splitwise, Google Sheets) without a rewrite.

Full detail lives in `project/Ledgerly PRD.dc.html` (requirements +
acceptance criteria) and `project/Ledgerly Architecture.dc.html` (schema +
design decisions) — these were authored in Claude Design and are the source
of truth this build implements. `HANDOFF.md` explains that bundle;
`chats/chat1.md` is the design conversation that shaped it.

## Where we are

### Phase 1 — Personal finance

- [x] Accounts & transfers (5 types, running balances, credit-card payment as transfer)
- [x] Transactions — expense / income / transfer, quick-add, delete requires an explicit confirm step (then a 5s undo), category filter chip (from Analytics drill-down or ⌘K search)
- [x] Categories — 28 seeded defaults + custom categories, in separate Expense/Income tabs; rename, switch Expense ↔ Income (fixes a category created under the wrong kind without touching the transactions that already reference it), and guarded delete (Settings, and inline during import) + rule-based auto-categorization
- [x] Budgets — monthly, 80%/100% thresholds, exactly-once alerts
- [x] Bills — due-date urgency, "mark paid" rolls the due date
- [x] Recurring transactions — idempotent daily cron
- [x] Dashboard — attention strip, cash flow, accounts, category donut, budgets. Header cards show Current Balance / Carry forward / Income / Expense for a selectable period — this month by default, with a month picker, custom date range, and "To date" (first transaction → today). Balance math is transaction-derived (carry forward + income − expense), so imported history without account info still counts; all sums run as DB aggregates, not loaded rows.
- [x] The period picker lives in the top header, not just the Dashboard: it's shared across Dashboard/Transactions/Accounts/Analytics via URL params (`?p=`/`?from`/`?to`), so picking "June 2026" and switching sections (sidebar, bottom nav, or a card's "All →" link) keeps that same period instead of each page resetting to its own default.
- [x] Search — deterministic ⌘K parser ("swiggy in march", "upi expenses", explicit years like "food in march 2023") — filters pushed to the DB query, not loaded-then-filtered in JS
- [x] Analytics — trend charts (fixed 6-month view) plus period-scoped stats (avg daily spend, biggest expense, savings rate) and a full category breakdown (not just top 5) with an Expense/Income toggle — click any category to jump to Transactions pre-filtered to that category and period
- [ ] Receipts (upload/view/replace/delete via Supabase Storage)
- [~] Reports export — full-ledger CSV and XLSX export both exist (Settings), and Analytics (period-scoped via the shared header picker) has a Print/Save-as-PDF view. True per-period XLSX/CSV export — i.e. an export limited to just the selected period/range rather than the whole ledger — is not yet wired.

### Phase 2 — Shared expenses

- [x] Friends (ghost participants, no signup required) & groups — create/rename/delete a group, add/remove members, from the Shared page
- [x] Splits — equal / exact, remainder paise to the payer, DB-enforced sum
- [x] Settlement engine — net balances, greedy minimum-transaction suggestions
- [x] Settle up (UPI / cash / bank) + history
- [x] Invitations linking a ghost participant to a real account — shareable-link only (`/invite/[token]`, 7-day expiry); no email delivery is wired up, by design (no email provider in scope)
- [x] Percentage & ratio split modes — equal/exact/percent/ratio are all live end-to-end (UI + `splitByWeights`); `CUSTOM` (the fifth schema value) remains unhandled — nothing in the product sets it
- [x] In-app notification center UI — bell dropdown in the top bar (unread badge, mark-all-read), reads the same `Notification` rows budgets/recurring already wrote

### Phase 3 — Data & polish

- [x] Generic import wizard — upload CSV/XLSX → real header row auto-detected anywhere in the sheet (tolerates banner rows, "Created on …" stamps, and repeated month-section labels — verified against an actual Monito export) → column mapping (header heuristics + value-shape scoring) → category/account resolution → preview with duplicate detection (date+amount+merchant, ±1 day) and per-row validation → commit → one-click undo. Every distinct category value in the file must be explicitly resolved before you can continue: values spelled exactly like one of your categories auto-match, everything else is flagged and must be mapped to an existing category, created on the spot (e.g. "Clothing"), or explicitly marked "leave uncategorized" — nothing is silently skipped. Rows with no per-row account (common for category-only trackers like Monito) default to unassigned rather than being dumped onto whichever account happens to be first in your list. The preview table's new/duplicate/invalid counts are clickable filters, so reviewing e.g. 84 invalid rows out of 2,400 doesn't mean scrolling past everything else. Handles sources with no dedicated merchant column at all (falls back to note → category → type as the transaction name) and Indian bank-statement conventions (separate Debit/Credit columns, DD/MM/YYYY dates, Dr/Cr suffixes — dates are parsed by our own day-first-aware logic, not SheetJS's own US-month-first guess for ambiguous CSV date strings). The mapping step *is* the generic adapter — new sources need no code changes. Remembers mappings per named source for next time.
- [ ] PWA / offline logging

### Cross-cutting

- [x] Auth (Better Auth, email/password, per-user data scoping)
- [x] Dark mode (persisted), responsive layout (sidebar ↔ bottom nav + FAB)
- [x] Settings — full data export (CSV/JSON), clear-all-transactions (resets every account back to its actual opening balance, not a stale computed number — see demo-seed fix below), self-serve account deletion — all behind a type-to-confirm modal
- [x] Performance: the transaction list and search push filtering + pagination to Postgres (50/page) instead of loading full history into memory; the ⌘K palette's merchant suggestions are fetched on demand instead of a full-table scan on every navigation; the dashboard and analytics load a lean aggregation-only query (no account/toAccount/paidBy/receipt joins) instead of the full display shape, and cash-flow bars bucket in one pass instead of re-scanning the window per bar; the transaction list no longer fires a redundant client-side refetch (and a "Load more" race) immediately after every page load. Matters once you've imported years of history — dev mode (`next dev`) is still noticeably slower than a production build (`next build && next start`) regardless, since routes compile on first hit.
- [x] 61 unit tests (money math, split rounding, settlement engine, search parser incl. explicit-year queries, import parsing/column-detection/dedupe/sheet-scanning/day-first-date-ambiguity)
- [x] End-to-end Playwright walkthroughs (18 prototype-parity checks + 12 import/export/data-management checks + 11 checks reproducing a real Monito export end-to-end + 3 large-import/transaction-timeout checks + 11 dashboard-period/category-edit/kind-switch/pagination checks, all against a seeded DB)
- [ ] Supabase Row-Level Security policies (service-layer scoping is in place; RLS as defense-in-depth is not yet added)
- [ ] Rate limiting on auth/import routes

## Stack

- **Next.js 15** (App Router) · React 19 · TypeScript · Tailwind CSS 4
- **PostgreSQL** (Supabase in production) · **Prisma 6**
- **Better Auth** (email + password, sessions in your own DB)
- All money is **integer paise** (`BigInt` columns); `Intl.NumberFormat('en-IN')`
  formatting at the edge only (₹1,23,456). Timezone: Asia/Kolkata.

## Setup

**Prerequisites:** Node.js 20+, and a PostgreSQL 16 database reachable via a
connection string (Docker, a native install, or Supabase all work).

```bash
git clone https://github.com/DivyeshPatro/Expense_Tracker.git
cd Expense_Tracker
npm install
cp .env.example .env
```

Edit `.env`:

```bash
DATABASE_URL="postgresql://postgres:<password>@127.0.0.1:5432/ledgerly"
BETTER_AUTH_SECRET="<generate with: openssl rand -hex 32>"
BETTER_AUTH_URL="http://localhost:3000"
CRON_SECRET="<any string>"
```

Then:

```bash
npx prisma migrate dev      # creates schema + split-sum DB trigger
npm run db:seed             # demo user with 6 months of realistic data
npm run dev                 # http://localhost:3000
```

Sign in with the seeded demo account — **arjun@ledgerly.app / ledgerly-demo**
(fictional, local-only) — or sign up fresh; new users get the 28 default
categories, the merchant→category dictionary, and a starter Cash account
automatically. If you're planning to keep using the app for real, sign up
with your own account rather than continuing to use the demo login — the
demo's 6 months of sample history exists to show the product off, not to be
built on top of. (Each demo account's real opening balance is 0, materialized
as a real "Opening balance" transaction dated just before the seeded window,
so "Clear all transactions" in Settings correctly resets it to 0 rather than
some balance-minus-seed-history number.)

```bash
npm test                    # unit tests: split rounding, settlement engine, parser, money
npm run e2e:all             # all 5 browser suites, in order, from a fresh seed (needs `npm run build && npm start` + Chromium)
```

`e2e:all` reseeds the demo account once, then runs `e2e` → `e2e:import` → `e2e:monito` → `e2e:large-import` → `e2e:perf` in that
order — each suite after the first depends on state left behind by the ones before it (e.g. `e2e:import` clears the seeded
transactions before running its own import). Each suite is otherwise self-contained: `e2e:large-import` undoes its own
~1500-2900-row import at the end so `e2e:perf`'s own import of the same fixture doesn't see every row as a duplicate. Run
any single suite on its own with `npm run e2e`, `npm run e2e:import`, `npm run e2e:monito`, `npm run e2e:large-import`, or
`npm run e2e:perf` — but note it'll see whatever state the DB is already in, so `npm run db:seed` first if in doubt.

## Architecture

Three strict layers (UI never touches Prisma; services never touch HTTP):

```
src/
├─ app/                   # routes; (app)/ = authed shell, (auth)/ = sign-in/up
│  ├─ actions.ts          # server actions: zod-validate → service → revalidate
│  └─ api/                # Better Auth handler + cron route
├─ components/shell/      # app chrome: sidebar, modals, ⌘K palette, FAB, toasts
├─ server/
│  ├─ services/           # domain logic (transactions, budgets, bills, shared, …)
│  ├─ auth.ts             # Better Auth config (+ per-user seeding on signup)
│  └─ db.ts               # Prisma singleton
├─ lib/                   # pure logic: money (paise), dates (IST), settlement,
│  │                      #   search-parser, tx-display — all unit-testable
└─ validators/            # zod schemas, money parsed to paise at the boundary
prisma/schema.prisma      # full schema, all 3 phases — migrate once
```

Key invariants, enforced in code **and** the database:

- Every mutation runs in one DB transaction that updates account balances and
  appends an `AuditLog` row.
- `Σ ExpenseSplit.owedAmount = Transaction.amount` via a deferred Postgres
  constraint trigger (`prisma/migrations/*_split_sum_constraint`).
- Budget notifications are exactly-once per period via a unique dedupe key.
- The recurring cron is idempotent: `nextRunAt` advances atomically with the
  materialized row.
- The daily cron also reconciles every user's account balances against their
  ledger (`reconcileAll`) and logs any drift — a pre-existing check that
  previously existed in code but was never actually invoked.

## Deployment (Vercel + Supabase)

1. Create a Supabase project; put the **pooled** connection string in `DATABASE_URL`.
2. `npx prisma migrate deploy`
3. Set `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (your domain) and `CRON_SECRET`
   in Vercel env; `vercel.json` schedules the daily job at 00:30 IST.
