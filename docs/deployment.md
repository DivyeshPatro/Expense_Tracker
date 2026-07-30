# Deployment

Ledgerly deploys as a standard Next.js app (Vercel + Supabase Postgres is
the reference target; any Node host + any Postgres 16 works). This
document covers environment variables, migrations, the two optional
third-party integrations, the build/deploy/rollback flow, and monitoring.

For the pre-release verification checklist, see
[`release-checklist.md`](release-checklist.md). For restoring from a
backup, see [`backup.md`](backup.md).

## Environment variables

All seven live in `.env.example` — copy it to `.env` for local
development. In production, set them in your host's environment
configuration (Vercel Project Settings → Environment Variables).

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | **yes** | Postgres connection string. On Supabase, use the **pooled** (PgBouncer) connection string, not the direct one — serverless functions open many short-lived connections. |
| `BETTER_AUTH_SECRET` | **yes** | Session signing secret. Generate with `openssl rand -hex 32`. Rotating this invalidates every existing session. |
| `BETTER_AUTH_URL` | **yes** | The app's own public URL (`https://your-domain.com` in production). Must match exactly — better-auth's CSRF/origin check rejects requests whose origin doesn't match this. |
| `CRON_SECRET` | **yes** | Shared secret authorizing `GET /api/cron/daily`. Compared with `crypto.timingSafeEqual`, not `===`. |
| `RESEND_API_KEY` | optional | Enables password-reset emails. Without it, the reset flow still works end-to-end but logs the reset link server-side instead of emailing it — safe to leave unset while getting everything else running, but real users need it set before launch. |
| `RESEND_FROM` | optional | Sender address; must be on a domain verified in Resend, or omit to use their shared `onboarding@resend.dev` testing sender. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | optional | Enables rate limiting on sign-in/sign-up/password-reset-request. Without them, rate limiting **fails open** (no limiting, not a hard failure) — same tradeoff as Resend: safe to defer, but a real gap before launch. |
| `ALLOW_SIGNUP` | optional | Registration is **closed** unless this is exactly `"true"`. Ledgerly is single-tenant — one deployment holds one person's finances and their saved card details — so an open sign-up page on a public URL lets a stranger create an account inside it. Set it to `true`, create your account, then remove it. |
| `CARD_ENCRYPTION_KEY` | required **for the Credit Cards module** | AES-256-GCM key encrypting stored card details. Exactly 64 hex characters: `openssl rand -hex 32`. Without it the Credit Cards pages error rather than storing anything in plain text; the rest of the app is unaffected. **Back it up** — see below. |

## Backing up `CARD_ENCRYPTION_KEY`

This key is the only thing that can decrypt saved card details, and it is
**not derivable and not recoverable**. Losing it means every stored card
becomes permanently unreadable — a full database backup will not help,
because the ciphertext is useless without it.

Treat it exactly like the database password: generate it once, store it in
your password manager, and set it as an environment variable. Never commit
it.

What it protects, and what it doesn't:

- **Protects** database dumps, Supabase snapshots, a leaked SQL export, or
  an injection that reads rows — the realistic exposures for a self-hosted
  deployment. This is what "never store card data in plain text" means.
- **Does not protect** against an attacker who can read your server
  environment, since the key lives there. Server compromise is game over
  by design; that is the accepted tradeoff of server-side encryption, and
  it is why registration is closed by default.

Cards are stamped with a short, non-secret fingerprint of the key that
encrypted them. If you rotate the key or restore a backup onto an instance
with a different one, affected cards report **"encrypted with a different
key"** instead of failing with an opaque decryption error.

## Creating the first account

Registration is closed by default, so a fresh deployment has no way to
register until you open it deliberately:

1. Set `ALLOW_SIGNUP=true` in the environment and redeploy (or restart
   locally).
2. Visit `/sign-up` and create your account.
3. **Remove `ALLOW_SIGNUP`** and redeploy.

`/sign-up` then renders a "Registration is closed" page, and better-auth
rejects sign-up requests at the API level too — so this holds against
direct calls, not just the form the app renders.

## Setting up Resend (optional, recommended before launch)

1. Create an account at resend.com (free tier: 100 emails/day).
2. Verify a sending domain, or use the shared `onboarding@resend.dev`
   sender for testing (no domain verification needed, but not suitable
   for real users).
3. Create an API key, set `RESEND_API_KEY`.
4. Set `RESEND_FROM` to an address on your verified domain (e.g.
   `Ledgerly <noreply@yourdomain.com>`), or leave unset to use the shared
   testing sender.

`src/server/email.ts` degrades gracefully without a key: it logs the
reset URL via `console.error` instead of throwing, so local development
and CI never need real credentials.

## Setting up Upstash (optional, recommended before launch)

1. Create a free account at upstash.com.
2. Create a Redis database (any region — this app makes small, latency-
   tolerant requests, not a hot path).
3. Copy the REST URL and REST token from its dashboard into
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.

`src/server/rate-limit.ts` imports `@upstash/redis/cloudflare` (not the
package's default export) specifically because `src/middleware.ts` runs
in the Edge Runtime, where the package's default Node.js build isn't
usable — this is a real, previously-hit build-time gotcha, not a
stylistic choice; if you ever touch this import, verify with `next
build` that no Edge Runtime warning reappears.

## Database migrations

```bash
npx prisma migrate deploy   # production: applies pending migrations, never generates new ones
```

Never run `prisma migrate dev` against a production database — it can
prompt for destructive resets. `migrate deploy` only applies migrations
already committed to `prisma/migrations/`.

Migrations run **before** the new application code that depends on them
goes live — for a schema-additive change (the vast majority: every model
added across every product phase has been additive) this is safe to do
without downtime. If a migration is ever genuinely destructive (dropping
a column a running instance still reads), it needs its own two-deploy
rollout plan; nothing in the current migration history has required one.

## Build

```bash
npm ci
npx prisma generate
npm run build
```

`next build` does **not** need a live database connection — every
DB-backed route in this app is force-dynamic (session checks read
cookies, which opts a route out of static generation automatically), so
nothing queries Postgres at build time. `DATABASE_URL` still needs to be
a *syntactically* valid connection string (Prisma Client validates shape
at construction), even if it doesn't need to resolve to anything real —
this is exactly how CI builds the app without provisioning a database
(see below).

## Deploy (Vercel + Supabase reference path)

1. Create a Supabase project; put its **pooled** connection string in
   `DATABASE_URL`.
2. `npx prisma migrate deploy` against production (from CI, or locally
   with the production `DATABASE_URL`).
3. Set every environment variable from the table above in Vercel Project
   Settings.
4. Deploy. `vercel.json` schedules the daily cron
   (`/api/cron/daily`, materializes recurring transactions/bills and
   reconciles account balances) at 00:30 IST.
5. Smoke-test: sign in, add an expense, confirm it appears — see
   [`release-checklist.md`](release-checklist.md) for the full manual
   pass.

## Rollback

Application code: redeploy the previous Vercel deployment (Vercel keeps
prior deployments addressable — this is a platform-level instant
rollback, no rebuild needed).

Database: because every migration to date has been additive (new
tables/columns, never a destructive drop-and-recreate), rolling back
application code to a previous version is safe even if a newer migration
has already been applied — old code simply doesn't read the new
columns. If a future migration is ever destructive, it must ship as a
two-step rollout (deploy the migration first, deploy the code that
depends on it separately) specifically so this rollback property holds.
There is currently no automated "undo migration" tooling — a genuinely
bad migration requires a hand-written down-migration or a restore from
backup (see [`backup.md`](backup.md)).

## CI pipeline

`.github/workflows/ci.yml` runs on every PR against `main` and every push
to `main`:

```
checkout → npm ci → prisma generate → typecheck → lint → unit tests → build
```

No Postgres service container is provisioned — the unit suite is pure
logic (verified: no test file touches Prisma or the database), and
`next build` needs no live database (see above). Build uses placeholder
env values in the correct shape, not real secrets.

E2E and accessibility suites (`npm run e2e:*`, `npm run e2e:accessibility`)
are **not** part of automated CI — they need a running dev/production
server and a seeded Postgres database, and are currently run manually
before a release (see [`release-checklist.md`](release-checklist.md)).
Wiring them into CI (a Postgres service container + a built app running
in the background) is a reasonable future improvement, not yet done.

## Monitoring recommendations

Nothing beyond the daily cron's own `console.error` logging (balance
drift detection — see `src/server/services/accounts.ts`'s `reconcileAll`)
and Vercel's built-in request/function logs exists today. Recommended,
not yet built:

- An error-tracking service (Sentry or equivalent) for unhandled
  exceptions in Server Actions and API routes — today these are only
  visible in platform logs.
- Alerting on the daily cron's drift-detection output — currently a log
  line, not a page.
- Basic uptime monitoring on `/api/cron/daily` itself, since a silently
  failing cron degrades recurring-transaction materialization and
  balance reconciliation without any user-visible symptom until much
  later.
