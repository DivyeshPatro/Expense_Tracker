# Changelog

All notable changes to Ledgerly are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); versioning
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Backup restore (JSON)** — a Ledgerly Backup `.json` export can be
  restored from the Import Center. Additive only: every restored row is a
  new row, accounts are matched to existing ones by (name, type) and
  categories by (name, kind), and only the missing ones are created.
  Restores the ledger — accounts, categories, transactions; the preview
  names every backup section it does *not* restore (budgets, bills,
  lending entries, settlements, recurring rules, tags) rather than
  silently dropping them. See [`docs/backup.md`](docs/backup.md).
- **Undo a restore in one step** from Settings → Import history. Reverses
  every restored transaction *and* removes the accounts and categories the
  restore created (`ImportBatch.createdEntities`). A created entity is
  deliberately kept when data outside the batch already depends on it —
  your own transactions, a budget, bill, merchant rule, or lending
  entry — and the undo reports what it kept, rather than cascading away
  data it was never asked to touch.
- **Account pickers grouped by funding type** — Cash / Bank / Wallet /
  Credit card / Investment, across expense, income, transfer and lending
  funding-source fields. Credit cards show their Card Vault identity
  (`Visa •••• 4242`) inline, so a card is recognisable at the point of
  choice.

### Fixed

- **Restored account balances were silently corrupted.** A newly created
  account was seeded with the backup's exported *closing* balance and then
  had every transaction in that backup replayed onto it, counting each one
  twice. Accounts now start at their opening position, restoring the
  documented invariant `balance = openingBalance + Σ ledger`.
- **A restore preview could promise more rows than the commit delivered.**
  Preview and commit resolved backup ids independently and disagreed on
  entities missing a name or type. Both now derive from one shared
  `planRestore()`, so the resolvable set is identical by construction.
  Incomplete backup entries are reported in the preview instead of being
  invisible.
- **One malformed date aborted an entire restore.** `toYMD` throws on an
  Invalid Date rather than returning a falsy value, so a single unreadable
  `occurredAt` failed the whole file instead of rejecting that one row.
- **Undo could delete an account still in use.** Its reference check used
  `importBatchId <> batch`, which excludes NULL rows under SQL
  three-valued logic — that is, every hand-entered transaction.
- **Credit cards restored with a debt were zeroed out**, because a
  positive-paise-only amount helper was being applied to balances, where
  zero and negative are both legitimate.

### Changed

- Unit and integration tests are now separate suites (`npm run test` /
  `npm run test:integration`). The unit suite touches no database and is
  verified to pass without one; CI runs the DB-backed suite in its own job
  against a Postgres service with migrations applied via
  `prisma migrate deploy`.
- CI runs again. Its triggers had been narrowed to pushes to `main` and
  pull requests against it — neither of which can fire on a repository
  whose only branch is `ledgerly-app` — leaving the workflow configured
  but unreachable since 2026-07-19.

### Migrations

- `20260725120247_import_batch_created_entities` — adds nullable
  `ImportBatch.createdEntities Json?`, recording what a restore created so
  undo can reverse it. Additive and backward-compatible: null for every
  existing row, and for every CSV import batch (that path only maps onto
  entities that already exist).

---

## [1.0.0] — 2026-07-19

First production-ready release. Everything below shipped across the
project's full development history and is summarized here by milestone,
not by individual commit — see `git log` for the complete record.

### Added

**Core personal finance**
- Accounts (bank/cash/wallet/credit-card/investment) with running
  balances; credit-card payments modeled as transfers.
- Transactions — expense/income/transfer, quick-add, soft-delete with
  undo, category filtering.
- Categories — seeded defaults plus custom categories, rename, kind
  switching (expense ↔ income), guarded delete, rule-based
  auto-categorization (`MerchantRule`).
- Budgets — monthly limits with 80%/100% threshold alerts, exactly-once
  per period.
- Bills — due-date urgency tracking, "mark paid" rolls the due date
  forward.
- Recurring transactions — idempotent daily materialization.
- Analytics — trend charts, category breakdown with drill-down, mobile
  tabbed layout.
- Generic CSV/XLSX import wizard — header auto-detection tolerant of
  banner rows and repeated section labels, column mapping, duplicate
  detection, forced category resolution, one-click undo. The mapping step
  is the adapter — new sources need no code changes.
- Full data export (CSV/JSON/XLSX) and self-serve account deletion.

**Shared expenses**
- Friends (no-signup-required participants) and collaborative Groups with
  OWNER/ADMIN/MEMBER roles.
- Splits — equal/exact/percent/ratio, DB-trigger-enforced sum invariant.
- Settlement suggestions — greedy debtor/creditor netting, at most n−1
  transfers.
- Shareable-link invitations, optionally granting group membership on
  acceptance.
- Group-based collaboration: any authorized member can read/edit a
  group's transactions (with `accountId` locked to the original owner),
  live-re-derived authorization on every request — see
  [`docs/shared-expenses.md`](docs/shared-expenses.md).

**Offline-first sync**
- Universal Outbox — every mutating action queues in IndexedDB and drains
  automatically (on reconnect, on tab focus, on a 30s poll).
- Server-side exactly-once semantics via an Intent idempotency table.
- Actor-aware conflict resolution: silent last-write-wins for the same
  person's own devices, a real conflict card when two different
  authorized people's edits collide.
- Poison-pill parking (24h / 20 attempts) so one permanently-failing
  intent can't block a user's whole queue.
- Sync Center (`/settings/sync`) — full queue visibility, device
  identity, sync log export.
- See [`docs/offline-sync.md`](docs/offline-sync.md) for the full
  mechanism, including honestly-scoped gaps (no Background Sync API, no
  Intent-table pruning cron yet).

**Lending**
- Personal GAVE/GOT ledger per contact, independent of the group model.
- FIFO automatic settlement with manual-allocation override.
- Derived (never stored) settlement status — see
  [ADR 0006](docs/adr/0006-derived-financial-metrics.md).
- Card Billing Intelligence — statement/due-date cycle math for
  card-funded loans, Card Recovery dashboard.
- Reminder engine (loan due dates + card billing due dates, data-only —
  no delivery mechanism yet).
- Lending Reports — monthly trend, all-time recovery rate, top borrowers,
  overdue loans, card exposure.

**Finance Hub**
- Dashboard composed entirely from each module's own existing service
  functions ([ADR 0007](docs/adr/0007-finance-hub-aggregation.md)) —
  Financial Health widget, unified Notification Center, Mobile Hub Strip,
  Recent Activity, Recent Transactions.
- Activity Timeline — a pure, registry-based projection over the existing
  audit log, with 10-minute edit-chain collapsing; no new event store.
- Unified ⌘K search across contacts/accounts/bills/groups/merchants, plus
  a deterministic (no-LLM, by product constraint) natural-language query
  parser, "Ask Ledgerly."

**Production hardening**
- Security headers (CSP with per-request nonce, HSTS, and the rest) via
  Edge Middleware.
- Password reset via Resend (degrades gracefully without a configured
  key).
- Rate limiting on sign-in/sign-up/password-reset-request via Upstash
  Redis (fails open without configured credentials).
- Invitation tokens bound to the invited email address.
- `timingSafeEqual` for the cron secret comparison.
- Sanitized error responses — internal exceptions no longer reach the
  client verbatim.
- Migrated off the unpatched `xlsx` package (known CVEs) onto `exceljs`.
- Missing database indexes added; the Lending Reports query rewritten
  from a whole-ledger scan to bounded DB-side aggregates.
- WCAG AA contrast fixes, skip-to-content link, semantic landmarks,
  `aria-live` toast announcements, focus-trapped modals, and an automated
  axe-core suite (`npm run e2e:accessibility`).
- ESLint installed and configured; CI pipeline (typecheck, lint, unit
  tests, build) on every PR.

### Changed

- Duplicated rupee-parsing logic across the codebase consolidated onto
  `src/lib/money.ts`'s `toPaise`.
- Duplicated urgency→color mapping (dashboard, Bills page) consolidated
  into `src/lib/urgency.ts`.
- Local UTC date-slicing (`.toISOString().slice(0,10)`) replaced with the
  IST-aware `toYMD` at every site where it mattered.
- `npm run lint` switched from the deprecated `next lint` wrapper to the
  ESLint CLI directly.

### Fixed

- Account deletion no longer orphans `Intent`/`Invitation` rows that had
  no declared database relation.
- Malformed notification payloads no longer produce a garbage timeline
  event — they're now correctly skipped.
- A TOCTOU race in the offline-sync version-check pattern (concurrent
  writes could silently overwrite each other with no conflict signal).

### Security

See "Production hardening" above — CSP/security headers, rate limiting,
password reset, invitation-token binding, sanitized errors, and the
`xlsx` → `exceljs` migration are all security-motivated changes, listed
there rather than duplicated here.

---

## Versioning policy going forward

- **MAJOR** — a breaking change to the data model requiring a
  migration users must run deliberately, or a breaking change to any
  documented API surface.
- **MINOR** — a new feature or module, additive and backward-compatible.
- **PATCH** — a bug fix, performance improvement, or security fix with no
  behavior change to existing features.
