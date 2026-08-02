# Changelog

All notable changes to Ledgerly are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); versioning
follows [Semantic Versioning](https://semver.org/).

## [1.3.0] — 2026-08-02

Native **Khatabook → Lending migration**. The Import Center used to read a
Khatabook file as plain income/expense transactions — which was wrong:
Khatabook is a lending ledger, not an expense tracker. It now migrates
directly into Lending, so every customer, balance and entry lands where it
belongs. After importing, it should feel as though you'd always been using
Ledgerly: chronological history, running balances, settlement status,
reports, dashboard totals and search all work immediately, with no manual
cleanup.

**No breaking changes and no database migration** — the feature maps
entirely onto the existing Lending stack (`Participant` contacts,
`LoanEntry`, the FIFO settlement engine, `ImportBatch` undo). It is not a
new lending engine; it reuses the one that already exists.

### Added

- **Khatabook → Lending import.** Upload a CSV/XLSX in the Import Center;
  a lending ledger is detected and opens a **migration flow** instead of
  the column-mapping steps. Rows become `LoanEntry` records against
  `Participant` contacts — never transactions, categories or merchants.
  Descriptions are kept as the entry note; funding source defaults to
  cash and is never prompted for during import.
- **Auto-detection.** Recognises Khatabook exports by their headers
  (Name/Customer/Party + You Gave/You Got, or Debit/Credit, or a single
  amount + type), tolerant of wording variations through aliases. Low
  confidence falls back to the normal importer with a one-tap switch;
  detection is generic over a registry of adapters so future ledgers
  (OkCredit, Vyapar, …) are new adapters, not new pipelines.
- **Smart contact merge.** Every unique person becomes one contact; a name
  seen 67 times creates 1 contact and 67 entries, never duplicates. Merge
  keys fold case and whitespace ("Rahul", "rahul", " Rahul " are one
  contact) but never fuzzy-match, so "Rahul" and "Rahul Kumar" stay
  distinct people. Existing contacts offer **Merge / Create new / Skip**
  with apply-to-all and an import-level "always create new" toggle for
  hands-free large imports.
- **Migration preview.** Before importing: contacts to create/merge, total
  and valid/duplicate/invalid/skipped row counts, total You Gave / You Got,
  net outstanding, date range, the top contacts, and a row-by-row preview
  with running balance. Invalid rows (empty contact, bad date/amount,
  unknown type) are listed with reasons and skipped; the rest still import.
- **Atomic, balance-verified import.** The whole import runs in one
  transaction; after writing, each contact's net is recomputed by the
  lending engine and checked against the preview to the paise. Any
  mismatch rolls the entire import back — there is never a partial import.
- **Repayment settlement.** GOT repayments are settled against prior GAVE
  loans by the same `allocateFifo` engine manual entry uses — driven in
  bulk per contact so the result is identical to entering each row by
  hand. Over-repayment is allowed to go net-negative; excess is left
  unallocated, exactly as manual entry leaves it.
- **Undo.** Reuses `ImportBatch`, reversing the entries, allocations and
  the contacts the import created — never contacts that existed before —
  the same behaviour as backup restore.
- **Activity Timeline.** One import event, "Imported N lending entries
  from Khatabook", linking to Import History.
- **Migration UX polish.** A "Next steps" section on the success report
  (review contacts, assign funding, add phones/photos) and a subtle
  **"From Khatabook"** badge on freshly imported contacts that clears once
  you add a detail — so a migration is visibly confirmed without permanent
  clutter.

### Performance

- **Bulk, no N+1.** One contact lookup, one existing-ledger read, then
  `createMany` for contacts, entries and allocations, with FIFO settlement
  computed in memory. A ~1,560-row import completes in **≈0.8 s**;
  designed to handle 10,000+ rows in a fixed handful of statements.
- The shared date/amount parser gained **Unix-epoch date** support
  (magnitude-guarded, additive) alongside the existing DD/MM/YYYY,
  DD-MM-YY and ISO formats.

### Testing

- **Unit: 385** (up from 350) — detection/confidence, column resolution,
  row mapping, smart-merge key, validation, epoch dates, the preview/plan
  assembler, and the activity event presenter.
- **Integration: 127** (up from 110) — import, dedupe, FIFO settlement,
  merge-into-existing, re-import dedupe, over-repayment, undo, **atomic
  rollback**, a **large-file + downstream-surfaces** suite (perf, Global
  Search, Activity), and the imported-contact badge source.
- **E2E: a new Khatabook → Lending suite** (18 checks against a built
  instance) — upload, detection, preview, import, DB reconciliation,
  Lending page, the migration badge, Activity Timeline, Import History and
  undo.

### Migrations

**None.** No schema change, no new columns or tables. `ImportBatch.created
Entities` (already JSON) now also carries `participants`/`loanEntries`/
`loanAllocations` for lending undo — same column, no migration.

### Known limitations

- **The "From Khatabook" badge clears on first *detail* edit** (photo,
  phone or note), not on a bare rename — `Participant` has no timestamp
  and a cosmetic badge didn't warrant a schema column. Deliberate.
- **Contact-merge decisions re-preview from the full row set.** Only
  matters when a large file collides with many pre-existing contacts (a
  fresh migration has none); a candidate optimisation, not a defect.
- **Smart merge is exact (case + whitespace), never fuzzy** — by design,
  to avoid ever fusing two different people.

## [1.2.0] — 2026-08-02

The Secure Credit Cards module (Phase 3.1). Ledgerly can now hold your own
cards so you never have to fetch the physical one to pay online — the
signing goal being *"I should never need to take my credit card out of my
wallet while shopping."* It is deliberately **not** a password manager, a
document vault, or a card-spend tracker: the schema is card-specific and
nothing generic (`Vault`, `SecureItem`) was introduced.

One new migration, purely additive — a `CreditCard` table and a
`CardNetwork` enum. Safe to apply to an existing database, which simply
gains an empty table. **New required-for-cards environment variable:**
`CARD_ENCRYPTION_KEY` (see Environment / Upgrade below). No breaking
changes; the existing `Account.cardNetwork/cardLast4/statementDay/dueDay`
fields used by Lending and Card Recovery are untouched.

### Added

- **Credit Cards, a first-class section** at `/cards` — its own sidebar
  entry, mobile More-sheet item and command-palette destination, separate
  from Accounts and the Finance Hub. A visual gallery renders each card as
  its network-coloured plastic showing only the last four digits.
- **Add & edit cards** with live network detection from the number
  (Visa/Mastercard/RuPay/Amex/Diners via IIN), a Luhn checksum hint, and
  CVV-length validation as you type. An explicit network choice overrides
  detection for co-badged cards. CVV is required.
- **Password-gated reveal.** Seeing a card's number, expiry, CVV or notes
  requires re-entering your Ledgerly account password — a live session is
  not sufficient, which is the point: a borrowed unlocked laptop is the
  case this guards. Wrong attempts are rate-limited (five per 15 minutes,
  counted from the audit trail) and recorded.
- **30-second auto-hide.** A revealed card clears itself on an absolute
  deadline — computed from a timestamp, not a decrementing counter, so a
  backgrounded tab whose timers are throttled still hides on time. A
  progress bar counts it down; "Hide now" clears it immediately.
- **Per-field copy**, so a checkout form can be filled one field at a time
  without ever displaying the whole number longer than needed. Copy works
  over plain HTTP on a LAN (falls back from the Clipboard API to a
  select-and-copy path when the page isn't a secure context).
- **Mobile Checkout Helper** — the signature feature. "Copy card details"
  hands off to a 60-second helper that keeps Number / Expiry / CVV / Name
  one tap away while you switch to the shopping app. On Chromium desktop
  it rides in a Document Picture-in-Picture window that floats above other
  windows; elsewhere it's a bottom sheet that survives tab switches.
- **Search and network filters** in the gallery, appearing only once you
  have enough cards for them to help. Filtering happens in the browser and
  never touches an encrypted field — nothing secret is searchable, by
  design, so the search can't become an oracle — and the query stays out
  of the URL, history and referrer headers.
- **Encrypted cards in backup & restore** (backup format → v2). Cards
  travel as sealed bytes: neither export nor restore decrypts one, so a
  backup file never contains a card number and taking one doesn't require
  `CARD_ENCRYPTION_KEY`. Restore dedupes on nickname + last four, is
  undoable as one `ImportBatch`, and won't let a restored card steal an
  existing default. Each card carries a fingerprint of the key that sealed
  it, so restoring onto an instance with a different key surfaces
  "encrypted with a different key" rather than an opaque failure.

### Security

- **Server-side AES-256-GCM** via Node's built-in `crypto`, per the
  self-hosted deployment model. Encrypted at rest: card number, cardholder
  name, expiry, CVV and notes. In the clear (for display and search):
  nickname, bank, network, last four, colour, default flag. No custom
  cryptography — a standard authenticated cipher, a random 96-bit IV per
  field stored beside its ciphertext, and the GCM tag appended so a
  tampered value fails to decrypt rather than rendering as a card number.
- **`CARD_ENCRYPTION_KEY` is validated at startup** and the module refuses
  to run without a valid 64-hex-character key — it never falls back to a
  derived or default key, because a silent fallback is indistinguishable
  from data loss the first time the process restarts.
- **Stated threat model:** this defends database dumps, snapshots, a
  leaked SQL export or an injection that reads rows — the realistic
  exposures for a self-hosted app. It does **not** defend against an
  attacker who can read the server environment and thus the key; server
  compromise is game over by design, which is also why registration stays
  closed by default.
- No secret ever enters an RSC payload or the audit log; decrypted values
  exist only in memory for the panel or form showing them and are dropped
  when it closes.

### Testing

- **Unit: 350 tests across 28 files** (up from 282/23) — card identity and
  Luhn, network detection, the search matcher, the backup card shape, and
  the crypto core. The suite still needs no database.
- **Integration: 110 tests across 6 files** (up from 79/5), including a
  24-test credit-cards suite covering password re-auth, the reveal denial
  trail, lockout and its expiry, and cross-user isolation; plus six new
  backup-restore tests proving an export carries no plaintext, a restore
  reads back byte-for-byte, and undo removes only what it created.
- **E2E: a new credit-card lifecycle suite** (19 checks through the real
  UI against a live server) — add, encryption-at-rest, a refused
  wrong-password reveal, a successful reveal, edit through a fresh prompt,
  moving the default between cards, and delete.

### Fixed

- **The first card added through the UI wasn't becoming the default.** The
  add form always sends an explicit `isDefault` (false when unticked), so
  the service's `?? isFirst` fallback never fired and a user's very first
  card came in with no default at all. It now becomes the default
  regardless; an explicit choice still wins.

### CI

- Actions bumped to `checkout@v5` / `setup-node@v5` (Node 24), clearing
  the Node 20 deprecation warning; the integration job runs with a
  throwaway `CARD_ENCRYPTION_KEY`.

### Migrations

One, additive and backward-compatible:

- `20260730114432_credit_cards` — adds the `CardNetwork` enum and the
  `CreditCard` table (with a `userId` index and an `ON DELETE CASCADE`
  foreign key to `User`). No existing table is altered.

### Known limitations

- **Rotating `CARD_ENCRYPTION_KEY` is not an in-app re-encryption flow.**
  Cards sealed under the old key report "encrypted with a different key"
  and must be re-entered; there is no bulk re-encrypt.
- **A true floating overlay over other apps is not possible from the
  web.** The Checkout Helper is Document Picture-in-Picture on Chromium
  desktop and a persistent bottom sheet elsewhere — it cannot hover over a
  separate native shopping app on mobile, which the platform reserves.
- **Reveal re-auth uses the account password, not a second factor.** It
  raises the bar above session-only access; it is not MFA.

## [1.1.0] — 2026-07-27

The first release after v1.0.0. It closes the gaps that stopped Ledgerly
being usable as a daily finance app: things you could create but never
correct or remove, a scheduling engine with no way to reach it, and the
rough edges — a bare framework 404, no way to change your password — that
made a finished product feel unfinished.

No breaking changes. All four migrations add nullable or defaulted
columns and are safe to apply to an existing database.

### Added

- **Recurring transactions** — subscriptions, rent, salary. Tick "Repeat
  this" when adding an expense or income and the schedule is created with
  it; manage everything from Settings → Recurring transactions (edit,
  pause, resume, delete). The engine had existed since v1.0.0, but
  nothing could create a rule, so no rule ever ran.
- **Backup restore** — a Ledgerly Backup `.json` export can be restored
  from the Import Center. Additive only: accounts are matched by (name,
  type) and categories by (name, kind); only missing ones are created and
  nothing existing is overwritten. Every restore is one `ImportBatch`,
  undoable in a click, and the preview names each backup section it does
  not restore. See [`docs/backup.md`](docs/backup.md).
- **Account archive, restore and delete** — an account nothing references
  is deleted outright; one with history is archived instead, keeping its
  transactions, balance and card details, and restorable at any time.
  Archived accounts leave the pickers but stay reachable under Accounts →
  Archived, with a link to their transactions.
- **Bills: edit and delete** — including a Settled bills section for
  one-off bills already paid, which previously disappeared from the app
  entirely. Deleting a bill removes the reminder only; the payment it
  recorded stays in your transactions.
- **Budgets: edit and delete** — changing a limit keeps the month's
  spending and re-evaluates alerts against the new figure; deleting
  removes the budgeting layer and nothing else.
- **Profile settings** — change your display name and your password from
  inside the app, independently of the forgotten-password email flow.
  Email is intentionally read-only for now, with the reason shown.
- **Error and not-found screens** — a failed page keeps the navigation
  and offers Try again / Go to Dashboard; an unknown URL gets a branded
  page instead of the framework default. No stack traces or internal
  messages are ever shown.
- **Transaction filtering by account** — `?account=` on the ledger,
  matching both sides of a transfer.
- **Import Center in the navigation** — desktop sidebar and mobile More
  sheet, alongside the existing Settings entry.

### Improved

- **Account pickers** are grouped by funding type (Cash, Bank, Wallet,
  Credit card, Investment), and credit cards show their Card Vault
  identity at the point of choice.
- **Accessibility** — labels added wherever repeated controls shared one
  visible label: per-budget Edit/Delete buttons, per-account rename
  fields, amount inputs, and the bill name field.
- **Mobile** — verified free of horizontal overflow at 390px across
  Accounts, Bills, Budgets, Settings and the import wizard.
- **Wording** — destructive confirmations now say what *survives* ("3
  past transactions stay", "the payment you already recorded stays in
  your transactions"), because the fear when deleting a bill or a budget
  is that it takes the money with it.
- **Performance** — profiled against a production build: 15–22 ms time to
  first byte and 52–102 ms full server render across every route, on a
  lean 102 kB shared JS bundle.

### Fixed

- **Restored account balances were silently wrong.** A newly created
  account was seeded with the backup's exported *closing* balance and
  then had every transaction in that backup replayed onto it, counting
  each one twice. Accounts now start at their opening position, restoring
  the documented invariant `balance = openingBalance + the ledger sum`.
- **One bad recurring rule could stop the nightly job entirely.** A
  template referencing a deleted account raised an error that escaped the
  loop, skipping every remaining rule for every user — and the balance
  reconciliation that follows it — silently, every night. Failures are
  now isolated per rule and reported.
- **Month-end schedules drifted downward permanently**, in both recurring
  rules and bills: the 31st became Feb 28 and then stayed on the 28th
  forever. Schedules now carry an anchor day, so 31 becomes Feb 28 and
  then Mar 31 again. Existing rules and bills keep their current dates
  rather than being silently rescheduled.
- **Undo of a restore could delete an account still in use.** Its
  reference check excluded rows where `importBatchId` is NULL — under SQL
  three-valued logic that means every hand-entered transaction.
- **Budget alerts outlived the budgets they described.** Threshold
  notifications link to a budget only by a key string, so nothing
  cascaded: deleting a budget left its alerts in the notification centre,
  and a stale alert also suppressed the correct one. Alerts are now
  cleared on delete and re-evaluated when a limit changes.
- **A card-funded loan could silently lose its funding source.**
  `LoanEntry.accountId` is `onDelete: SetNull`, so hard-deleting an
  account would not have failed — it would have blanked the loan's
  funding source, and with it the card billing history.
- **A restore preview could promise more rows than the commit delivered**,
  because preview and commit resolved backup ids independently. Both now
  derive from one shared plan, so the two cannot disagree.
- **One malformed date aborted an entire restore** instead of rejecting
  that single row.
- **Credit cards restored with a debt were zeroed out**, because a
  positive-only amount helper was applied to balances, where zero and
  negative are both meaningful.
- **Missed recurring occurrences recovered at one per day**, so a
  five-day outage took five more days to catch up. Catch-up now completes
  in a single run, bounded to 60 occurrences.

### Testing

- **Unit: 282 tests across 23 files** (up from 265), and the suite no
  longer requires a database — verified by running it against an
  unreachable `DATABASE_URL`.
- **Integration: 79 tests across 5 files** — a new suite covering the
  backup restore engine, recurring rules, accounts, bills and budgets
  against real Postgres.
- **E2E: 25 suites**, four of them new — account, bill, budget and
  recurring-rule lifecycles.
- **CI runs again.** Its triggers had been narrowed to a branch that does
  not exist on this repository, leaving the workflow configured but
  unreachable since 2026-07-19. It now also runs the integration suite in
  a job with a Postgres service and migrations applied.

### Migrations

Four, all additive and backward-compatible:

- `20260725120247_import_batch_created_entities` — records what a restore
  created, so undo can reverse it.
- `20260725194241_recurring_rule_anchor_day` — day-of-month anchor for
  recurring schedules.
- `20260725194832_recurring_rule_is_paused` — pause and resume for
  recurring rules.
- `20260725231628_bill_anchor_day` — day-of-month anchor for bill due
  dates.

### Known limitations

Deliberate deferrals, not defects:

- **Backup restore covers the ledger only** — accounts, categories and
  transactions. Budgets, bills, lending entries, groups, settlements,
  recurring rules and tags are exported for completeness but not
  restored; the preview names them.
- **Khatabook import lands as transactions, not lending entries.** The
  wizard says so. Routing it into the lending module is the first
  enhancement after this release.
- **Offline sync and shared expenses/collaboration have not had a
  real-world validation pass** — they need genuine multi-device and
  multi-user scenarios, scheduled as Phase 3.
- **Email address changes** are not supported in-app; doing it safely
  needs a verification step that does not exist yet.
- **Some E2E suites need a retry against a cold dev server.** Eight still
  submit the sign-in form before React hydrates; the rest were fixed.

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
