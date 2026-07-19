# Backup & Restore

This document is deliberately honest about the gap between "data is
recoverable in principle" and "there is a tested, automated backup
procedure." Ledgerly has no bespoke backup tooling of its own today —
recovery relies on your Postgres host's own backup capability plus one
real, user-facing export feature. Read this before you assume more
exists than does.

## What actually exists today

### 1. Database-level: your Postgres host's backups

Ledgerly stores no data outside Postgres (no S3 bucket, no separate file
store for receipts as of this writing — see the README's roadmap). The
entire disaster-recovery story is therefore "however your Postgres host
backs up your database":

- **Supabase** (the reference deployment target — see
  [`deployment.md`](deployment.md)) provides automatic daily backups on
  paid tiers, with point-in-time recovery available on higher tiers.
  **Verify your specific project's plan and retention window** — this
  varies by tier and is not something the application controls or can
  verify for you.
- **Self-hosted Postgres**: nothing in this repository schedules
  `pg_dump` or any other backup job. If you're self-hosting, you are
  responsible for setting one up — there is no cron, script, or CI job
  in this codebase that does it for you.

### 2. Application-level: user-initiated data export

Settings → Export data gives each user two independent exports of their
own data (`src/server/services/export.ts`):

- **CSV** — the transaction ledger only (date, type, amount, account,
  category, merchant, notes) — the data people actually want to take
  elsewhere.
- **JSON** — a complete structural dump of everything the user owns:
  accounts, categories, transactions (with splits and tags), budgets,
  bills, participants, groups, settlements, recurring rules.
- **XLSX** — the same transaction ledger as the CSV, as a spreadsheet.

This is real, working, and exercised by the e2e suite — but it is a
**personal export for the user's own use**, not an admin backup
mechanism, and critically:

**There is no restore path for the JSON export.** The Import wizard
(`/import`) accepts CSV/XLSX transaction data through the same generic
adapter used for bank statements and other trackers — it does not accept
Ledgerly's own JSON export format, and there is no "restore my full
account from this JSON file" feature. If you export your data as JSON
today, you can read it, archive it, or process it externally, but you
cannot currently re-import it to reconstruct an account.

## Restore procedure (database-level)

Restoring from a Postgres backup is standard `pg_restore`/point-in-time-
recovery, performed through your host's tooling (Supabase's dashboard, or
`pg_restore` against a self-managed `pg_dump` file). Nothing about
Ledgerly's schema requires special handling during a restore — it's a
normal Postgres database with normal foreign keys and one deferred
constraint trigger (the split-sum trigger — see
[`architecture.md`](architecture.md)), which restores correctly as part
of the schema itself.

After restoring the database to a point in time, two things are worth
verifying before considering the app fully recovered:

1. **Run the daily cron's reconciliation manually** (or wait for its next
   scheduled run) — `reconcileAll()` compares every account's stored
   balance against what its ledger implies and logs drift. A restore to
   a point mid-transaction (rare, but possible depending on your
   provider's consistency guarantees) is exactly the kind of thing this
   check exists to catch.
2. **Check for orphaned `Intent` rows referencing entities that no longer
   exist** if the restore point predates some now-missing data — this is
   a rare edge case, not a routine restore step, but worth knowing about
   given the offline-sync layer's Intent-table dependency (see
   [`offline-sync.md`](offline-sync.md)).

## Disaster recovery expectations

Be realistic about what this means in practice:

- **Recovery Point Objective (RPO)** is entirely a function of your
  Postgres host's backup frequency — this application does nothing to
  improve on it. If your host backs up daily, your RPO is up to 24 hours
  of data loss in a worst-case failure.
- **Recovery Time Objective (RTO)** is your host's restore time plus
  redeploying the application (fast — see
  [`deployment.md`](deployment.md)'s rollback section) plus the
  verification steps above.
- **There is no application-level replication or multi-region failover**
  — this is a single-primary-database application, and its availability
  is bounded by its Postgres host's own availability.

## Recommendations (not yet built)

These are honest gaps, listed so they're not mistaken for solved
problems:

- A scheduled, automated `pg_dump` (or equivalent) independent of the
  hosting provider's own backup system, for defense-in-depth against a
  provider-level failure or account issue.
- A restore path for the JSON export, so "export my data" and "restore my
  data" are actually symmetric operations.
- Off-site storage of exports/backups, separate from the primary
  database's own hosting account.

If you're deploying Ledgerly for real users, treat your Postgres host's
backup tier and retention window as a decision you're explicitly making,
not a default you can assume is adequate.
