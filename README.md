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
- [x] Transactions — expense / income / transfer, quick-add, soft delete + undo
- [x] Categories — 28 seeded defaults + custom categories (Settings, and inline during import) + rule-based auto-categorization
- [x] Budgets — monthly, 80%/100% thresholds, exactly-once alerts
- [x] Bills — due-date urgency, "mark paid" rolls the due date
- [x] Recurring transactions — idempotent daily cron
- [x] Dashboard — attention strip, cash flow, accounts, category donut, budgets
- [x] Search — deterministic ⌘K parser ("swiggy in march", "upi expenses")
- [x] Analytics — trends, balance history, top categories/merchants
- [ ] Receipts (upload/view/replace/delete via Supabase Storage)
- [ ] Reports export by period (day/week/month/quarter/year/custom range, PDF/XLSX) — full-ledger CSV export exists (see Data & polish below); per-period report generation does not yet

### Phase 2 — Shared expenses

- [x] Friends (ghost participants, no signup required) & groups
- [x] Splits — equal / exact, remainder paise to the payer, DB-enforced sum
- [x] Settlement engine — net balances, greedy minimum-transaction suggestions
- [x] Settle up (UPI / cash / bank) + history
- [ ] Email invitations linking a ghost participant to a real account
- [ ] Percentage & ratio split modes (equal/exact are live; schema supports both)
- [ ] In-app notification center UI (budget/bill/settlement alerts are generated, not yet surfaced as a feed)

### Phase 3 — Data & polish

- [x] Generic import wizard — upload CSV/XLSX → real header row auto-detected anywhere in the sheet (tolerates banner rows, "Created on …" stamps, and repeated month-section labels — verified against an actual Monito export) → column mapping (header heuristics + value-shape scoring) → category/account resolution (with inline "+ create category" for values that don't match anything yet, e.g. "Clothing") → preview with duplicate detection (date+amount+merchant, ±1 day) and per-row validation → commit → one-click undo. Handles sources with no dedicated merchant column at all (falls back to note → category → type as the transaction name) and Indian bank-statement conventions (separate Debit/Credit columns, DD/MM/YYYY dates, Dr/Cr suffixes). The mapping step *is* the generic adapter — new sources need no code changes. Remembers mappings per named source for next time.
- [ ] PWA / offline logging

### Cross-cutting

- [x] Auth (Better Auth, email/password, per-user data scoping)
- [x] Dark mode (persisted), responsive layout (sidebar ↔ bottom nav + FAB)
- [x] Settings — full data export (CSV/JSON), clear-all-transactions (reset the ledger without losing account/category/budget setup), self-serve account deletion — all behind a type-to-confirm modal
- [x] 59 unit tests (money math, split rounding, settlement engine, search parser incl. explicit-year queries, import parsing/column-detection/dedupe/sheet-scanning)
- [x] End-to-end Playwright walkthroughs (18 prototype-parity checks + 12 import/export/data-management checks + 11 checks reproducing a real Monito export end-to-end, all against a seeded DB)
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
automatically.

```bash
npm test                    # unit tests: split rounding, settlement engine, parser, money
node scripts/e2e.mjs        # browser walkthrough (needs `npm run build && npm start` + Chromium)
```

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

## Deployment (Vercel + Supabase)

1. Create a Supabase project; put the **pooled** connection string in `DATABASE_URL`.
2. `npx prisma migrate deploy`
3. Set `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (your domain) and `CRON_SECRET`
   in Vercel env; `vercel.json` schedules the daily job at 00:30 IST.
