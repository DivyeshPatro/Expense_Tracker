# Release Checklist

Run through this before every release, in order — earlier steps are
cheaper to fail on than later ones. See
[`CONTRIBUTING.md`](../CONTRIBUTING.md) for day-to-day PR expectations;
this is the fuller gate specifically for shipping a release.

## 1. Typecheck

```bash
npx tsc --noEmit
```

Must be clean. Zero tolerance — a type error means something is provably
wrong, not stylistically off.

## 2. ESLint

```bash
npm run lint
```

Must be clean. If you're intentionally suppressing a rule, the
suppression needs a comment explaining why, not a silent `eslint-disable`.

## 3. Unit tests

```bash
npm test
```

All green. The unit suite is pure logic (`src/lib/`, `src/validators/`)
— no database, no browser. A failure here means a real regression in
money math, date handling, the settlement algorithm, the search parser,
or similar — never a flaky test.

## 4. E2E tests

```bash
npm run build && npm start &   # or: npm run dev, in a separate terminal
npm run db:seed
npm run e2e:all
```

Run against a **built** instance when possible, not `next dev` — dev
mode's on-demand route compilation can mask a build-only failure and
skews timing-sensitive checks. `e2e:all` reseeds the demo account once
and runs every suite in sequence; see `package.json`'s script list for
the individual suites if you only need to re-run one after a targeted
fix. Note several suites depend on state left behind by earlier ones in
the sequence (see the script comments) — don't cherry-pick suites out of
order without reseeding first.

## 5. Accessibility tests

```bash
npm run e2e:accessibility
```

Gates on structural violations (missing accessible names, broken
landmarks, keyboard-reachability issues, focus-trap regressions).
Color-contrast findings are reported but don't fail the run by design —
review them manually; a new finding here that wasn't there before is
still worth investigating even though it won't block the release.

## 6. Production build

```bash
npm run build
```

Must complete with **no warnings**, not just no errors — in particular,
watch for Edge Runtime compatibility warnings from `src/middleware.ts`'s
dependencies (this has broken before — see
[`docs/deployment.md`](deployment.md#setting-up-upstash-optional-recommended-before-launch)).
A clean exit code with a warning buried in the output is not a pass.

## 7. Database migrations

- Confirm every migration in `prisma/migrations/` since the last release
  is additive (new tables/columns) unless a destructive one was
  deliberately planned with its own two-step rollout (see
  [`docs/deployment.md`](deployment.md#rollback)).
- Dry-run `npx prisma migrate deploy` against a staging database (or a
  fresh local database restored from a recent production backup) before
  running it against production.

## 8. Environment variables

- Every variable in `.env.example` is set in the production environment.
- If this release adds a new environment variable, confirm it's in
  **both** `.env.example` and [`docs/deployment.md`](deployment.md)'s
  table — not just one.
- Confirm `BETTER_AUTH_URL` matches the actual production domain exactly
  (mismatches cause silent auth failures, not obvious errors).

## 9. Backup verification

- Confirm your Postgres host's backup ran successfully within its
  expected window (see [`docs/backup.md`](backup.md) — this is
  host-dependent, not something the application verifies for you).
- If a migration in this release is anything other than purely additive,
  take a manual backup/snapshot immediately before deploying it,
  regardless of what your host's automatic schedule would otherwise
  cover.

## 10. CI green

Confirm the GitHub Actions run for the release commit is fully green
(typecheck, lint, unit tests, build — see
[`docs/deployment.md`](deployment.md#ci-pipeline)). CI does not run the
E2E/accessibility suites — steps 4 and 5 above are additional, not
redundant with CI.

## 11. Manual smoke test

Against the built instance from step 6, by hand:

- [ ] Sign up a fresh account; confirm default categories/accounts seed.
- [ ] Sign in as the demo account.
- [ ] Add an expense, an income, and a transfer; confirm balances update.
- [ ] Edit and delete a transaction; confirm the undo toast works.
- [ ] Create a group, add a member, split an expense; settle up.
- [ ] Record a loan (GAVE) and a repayment (GOT); confirm the balance and
      status update.
- [ ] Go offline (DevTools → Network → Offline), record an expense,
      go back online, confirm it syncs.
- [ ] Check the dashboard renders every section without an error.
- [ ] Trigger a password reset (if `RESEND_API_KEY` is set, confirm a
      real email arrives; if not, confirm the flow completes via the
      logged fallback).

If any of the above is broken, do not ship — a broken build that passes
every automated check but fails obviously by hand is exactly the gap
this step exists to close.
