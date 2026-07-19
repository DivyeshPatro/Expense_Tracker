# Finance Hub

The Finance Hub is Ledgerly's dashboard — a synthesized view across every
module (accounts, transactions, budgets, bills, lending, shared expenses,
activity, search) assembled entirely from each module's own existing
service functions. See [ADR 0007](adr/0007-finance-hub-aggregation.md)
for why it's built this way instead of as its own dedicated
query/aggregation layer: the short version is that reusing each domain's
own service function is what guarantees the dashboard's numbers can never
silently diverge from that domain's own page.

## Navigation philosophy

The dashboard is the one page a user should never need to leave to
understand their overall position, but it's also never a dead end — every
card and stat deep-links somewhere real (a filtered transaction list, the
Lending page, the Accounts page), and even the "recent transactions" rows
open the same detail view the Transactions page itself uses, in place,
rather than requiring navigation away.

Mobile and desktop deliberately diverge in *density*, not in *data*:
mobile keeps a lean stack (balance hero, spend, one attention item,
recent transactions) plus one addition — a horizontally-scrollable
**Mobile Hub Strip** — that makes every module reachable from home
without rebuilding the full desktop scroll. Desktop shows everything at
once. This is a deliberate, stated product decision (see the dashboard
page's own header comment), not an oversight in either direction.

## Dashboard composition

`src/app/(app)/dashboard/page.tsx` fires roughly a dozen data calls in
one `Promise.all` (accounts, budgets, bills, shared summary, lending
summary + reminders, groups, recent transactions, ledger aggregates, cash
totals, activity feed) and composes:

- **Attention strip** — the single most urgent item on mobile (overdue
  bill → worst-over budget → soon-due bill, in priority order), every
  applicable chip on desktop. Built inline from data already fetched, not
  its own service.
- **Balance hero** (`LiveBalance`) — total balance, "live" only when
  viewing the current period; for a historical period it's walked
  backward via the same cash-total helper used for the live case, so
  imported history without account info still counts correctly.
- **Period stat cards** — carry-forward, income, expense — each
  deep-linking to Accounts/Transactions with the current period
  preserved in the URL.
- **Mobile Hub Strip** — compact deep-link cards to Lending, Bills,
  Shared, and Net Position, each a re-presentation of numbers already
  computed for other sections, not new data logic.
- **Cash flow + Accounts** (desktop) — a 6-month/8-week/14-day chart
  built from the same ledger aggregate rows `listBudgets` already needed,
  fetched once and shared.
- **Financial Health, Notification Center, Recent Activity** (desktop) —
  see below.
- **Category donut, Lending summary, Upcoming bills, Settlements** — each
  a thin presentational wrapper around one module's own data.
- **Recent transactions + Budgets.**

## Financial Health

`HealthWidget` is explicitly informational — not a score, not a model,
just four numbers juxtaposed with a spending trend line, entirely
recomputed from data the dashboard already fetched (no query of its own):

- **Net Position** — total account balance plus lending net.
- **Outstanding Loans** — total owed to you across all contacts.
- **Upcoming Bills** — count due within 7 days, with the nearest one
  named.
- **Credit Exposure** — total credit-card debt (sum of negative balances
  across `CREDIT_CARD` accounts).

## Notification Center

Not the header bell (that's a separate, simpler unread-count dropdown) —
this is a dashboard panel showing one urgency-sorted feed merging four
sources, built by `buildFeed()` (`src/lib/notification-feed.ts`):

| Source | Urgency |
|---|---|
| Offline sync issues (stuck outbox items) | always most urgent — "a stuck local change is a data-integrity problem, not a calendar item" |
| Lending reminders | overdue → due today/tomorrow → due this week → card-recovery guidance, mapped from [`lending.md`](lending.md)'s reminder categories |
| Bills | overdue/urgent → soon; purely informational "later" bills are excluded |
| Pending settlements | informational tier, skipped below a ₹1 dust threshold |

Sync issues are merged in **client-side**, not server-rendered — they
live only in this browser's IndexedDB outbox
([`offline-sync.md`](offline-sync.md)) and can't be known at server-render
time.

## Recent activity vs. recent transactions

Two different panels answer two different questions:

- **Recent Activity** (`RecentActivityPanel`) — the most recent financial
  *events* across every module (loans, bills, transactions, anything the
  Activity Timeline covers — see below), reusing the Timeline's own
  presented shape rather than re-deriving anything. Clicking a row
  navigates to `/activity`.
- **Recent Transactions** (`RecentTxList`) — transactions only, and
  clicking a row opens the same detail modal the Transactions page uses,
  in place, so the dashboard stays the page you return to.

## Unified search

`unifiedSearch()` (`src/server/services/search.ts`) is the ⌘K palette's
backing query — direct, capped (`take: 4` per category) Postgres
`ILIKE`-style queries across contacts, accounts, bills, and groups, run
in parallel, not a separate search index. It's deliberately bounded and
indexed rather than a full-table scan, matching the same "push filtering
into the DB" principle the Transactions list already follows.

**Ask Ledgerly** (`askLedgerly()`) is a *deterministic* natural-language
query answerer — no LLM, by explicit product constraint (see the root
`project/CLAUDE.md`). `parseQuery()` recognizes a bounded grammar
("swiggy in march", "upi expenses", explicit years) and returns a
structured filter; unmatched queries return `null` so the palette falls
back to plain text search rather than erroring.

## Activity Timeline

The `/activity` page and the dashboard's Recent Activity panel are two
consumers of one presenter (`src/lib/activity.ts` +
`src/server/services/activity.ts`), which is a **pure projection** over
the existing `AuditLog` table — no new event store, no duplicated
history. Every mutation already writes an audit row (before/after JSON
snapshot); the presenter reads that table, parses each snapshot once, and
maps it through a per-event-kind registry (icon, verb, summary template,
diff field manifest) into a `TimelineEvent`.

Two design decisions worth knowing if you're extending this:

- **Adding a new trackable event kind means adding a registry entry, not
  touching the presenter.** If implementing a new kind requires editing
  the query/presenter logic itself, something has drifted from the
  intended shape.
- **Consecutive edits to the same entity collapse** into one story when
  each edit lands within 10 minutes of the previous one (a chain rule,
  not a flat window — a continuous 25-minute fixing session still
  collapses to one entry). Any other event on that entity (delete,
  settle) breaks the chain. This exists specifically to keep "fixed a
  typo, fixed it again" bursts from cluttering the timeline while keeping
  a morning edit and an evening edit to the same transaction as two
  distinct, real stories.

A version-history / "restore to a prior state" UI was deliberately
**not** built — see `project/activity-timeline-spec.md` §8 for the full
reasoning; in short, the audit trail already preserves everything
losslessly for forensic purposes, and a "restore" action would be a new
financial mutation with real correctness risk, purchased for a feature
whose read-only half is already served by the diff view.

## Where this shows up in the product

| Surface | Source |
|---|---|
| `/dashboard` | `src/app/(app)/dashboard/page.tsx` |
| `/activity` | `src/app/(app)/activity/page.tsx`, `activity-list.tsx` |
| ⌘K command palette | `src/components/shell/palette.tsx` |
| Header notification bell | `src/components/shell/notifications.tsx` |
