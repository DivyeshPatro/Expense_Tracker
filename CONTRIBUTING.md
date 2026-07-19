# Contributing to Ledgerly

This guide is for anyone (including future-you) working on the codebase.
For what the system does and why, start with [`README.md`](README.md) and
[`docs/architecture.md`](docs/architecture.md).

## Project structure

See [`docs/architecture.md`](docs/architecture.md#module-boundaries) for
the full breakdown. The one rule that matters most day to day: **UI never
touches Prisma directly; services never touch HTTP.** If you're writing
a Prisma query inside a Client Component, or reading `headers()`/cookies
inside `src/server/services/`, something's in the wrong layer.

## Coding conventions

These aren't arbitrary style preferences — each one reflects a real
lesson visible in the codebase's own history:

- **Money is always integer paise** (`BigInt` columns, `number` paise in
  application code), parsed from a rupee string exactly once, at the
  validator boundary (`src/lib/money.ts`'s `toPaise`, called from
  `src/validators/index.ts`). Never reimplement currency parsing at a
  new call site — see [ADR-adjacent history]: this exact duplication was
  found and consolidated during the Phase B refactor pass.
- **Dates are IST-aware.** Use `src/lib/dates.ts`'s `toYMD`/`istNoon`/
  `monthRange` rather than `new Date().toISOString().slice(0, 10)` — the
  latter reads the UTC calendar date, which disagrees with the IST
  calendar date for roughly 5.5 hours around midnight IST. This has
  bitten the codebase before; don't reintroduce it.
- **Derive, don't cache, financial state that depends on other rows.**
  See [ADR 0006](docs/adr/0006-derived-financial-metrics.md) — a stored
  "settled" flag or balance that isn't the single source of truth is a
  standing invalidation bug waiting to happen. If you're tempted to add a
  cached column, check whether it can be computed from what's already
  stored instead.
- **Authorization is always re-derived live, server-side**, never cached,
  never trusted from a client payload. See
  [`docs/shared-expenses.md`](docs/shared-expenses.md).
- **Small, focused files with a comment explaining *why*, not *what*.**
  Well-named code already says what it does; a comment earns its place
  by recording a non-obvious constraint, a rejected alternative, or a
  past bug. Don't restate the code in prose.
- **No AI/LLM calls anywhere in the product** — search, categorization,
  and Ask Ledgerly's natural-language parsing are all deterministic and
  rule-based. This is a standing product constraint (see the root
  `project/CLAUDE.md`), not a phase-1 shortcut to revisit later.
- **New mutating features route through the service layer**, callable
  from both a Server Action and `/api/sync` (see
  [`docs/architecture.md`](docs/architecture.md#server-actions-vs-the-service-layer))
  — never put a business rule only in `actions.ts`, or it silently won't
  apply to offline-queued writes.

## Testing requirements

- **Unit tests** (`npm test`, Vitest) — required for anything in
  `src/lib/` and `src/validators/` (pure logic — no excuse not to test
  it) and strongly expected for service-layer functions with real
  business rules. Co-locate as `*.test.ts` beside the file under test.
- **E2E tests** (`npm run e2e:*`, Playwright, against a seeded DB) —
  required for any change to a user-facing flow spanning multiple pages
  or the offline-sync/collaboration machinery, where a unit test can't
  exercise the real interaction. See `scripts/` for the existing suite —
  one script per feature area is the established pattern.
- **Accessibility** (`npm run e2e:accessibility`, axe-core) — run this if
  you touch shared UI primitives (`src/components/shell/`) or add a new
  modal/form pattern. It gates on structural violations (missing labels,
  broken landmarks, focus issues); color-contrast findings are reported
  but don't fail the run — see the script's own header comment for why.
- **Before opening a PR**, run the full local gate:
  ```bash
  npx tsc --noEmit && npm run lint && npm test && npm run build
  ```
  This is exactly what CI runs (see
  [`docs/deployment.md`](docs/deployment.md#ci-pipeline)) — catching it
  locally is faster than waiting on a CI failure.
- **When you find and fix a real bug while doing something else**, keep
  it as its own commit with its own explanation, separate from the
  change that led you to it. Don't bury a correctness fix inside an
  unrelated refactor's diff.

## Commit style

This repo uses conventional-commits-style prefixes, consistently, across
its whole history:

```
feat:     a new feature or capability
fix:      a bug fix
perf:     a performance improvement with no behavior change
security: a security-motivated fix or hardening change
refactor: a code-shape change with no behavior change (verified, not assumed)
chore:    tooling, config, dependency, or non-product-code changes
docs:     documentation only
ci:       CI/CD workflow changes
a11y:     accessibility-specific fixes
```

Subject line: short, present tense, no trailing period. The body is
where this codebase's commits differ from a minimal conventional-commit —
**explain the *why*, and state how you verified the change**, not just
what changed:

```
fix: malformed notification payloads produced a garbage timeline event

asSnap's defensive {}-for-any-non-object fallback is correct everywhere
else it's used — the bug was presentNotificationRow proceeding past that
fallback instead of treating "not an object at all" as reason to skip.
Added an explicit guard before asSnap runs, scoped to this one function.

Verified: added a test for the exact malformed-payload case; full suite
green.
```

A commit that changes behavior without saying how you confirmed it still
does what's intended is treated as incomplete, not just terse.

## Branch strategy

- `main` is the stable branch — PRs target it.
- Feature work happens on a descriptively-named branch
  (`ledgerly-app` is the long-lived branch this project's major phases
  have been developed on; smaller changes may use their own short-lived
  branch).
- No direct pushes to `main` — every change lands via PR, gated on CI
  (typecheck, lint, unit tests, build — see
  [`docs/deployment.md`](docs/deployment.md#ci-pipeline)).

## Review checklist

Before requesting review (or before merging your own PR on a solo
project), confirm:

- [ ] `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build` all
      pass locally.
- [ ] New business logic in `src/lib/` or `src/validators/` has unit
      tests; a new user-facing flow has an E2E script or an addition to
      an existing one.
- [ ] Money is paise, dates go through `lib/dates.ts`, authorization is
      re-derived server-side — not reimplemented ad hoc.
- [ ] If a mutation is reachable offline, it's routed through the
      service layer (callable from both `actions.ts` and
      `/api/sync`), not living only in `actions.ts`.
- [ ] Comments explain *why*, not *what*; none are stale relative to the
      code they sit next to.
- [ ] Any new environment variable is documented in `.env.example` *and*
      [`docs/deployment.md`](docs/deployment.md).
- [ ] If you touched a shared primitive (`src/components/shell/`), run
      the accessibility suite.
- [ ] The commit message explains why the change was made and how it was
      verified — not just what changed.

## Release process

See [`docs/release-checklist.md`](docs/release-checklist.md) for the
full pre-release gate. In short: every check in the review checklist
above, plus the full E2E + accessibility suites (not just unit tests), a
production build, a migration dry-run, and a manual smoke test against a
built (not dev-mode) instance — dev mode's on-demand route compilation
hides real first-load performance and can mask build-only failures.

Versioning follows [Semantic Versioning](https://semver.org/); see
[`CHANGELOG.md`](CHANGELOG.md) for the release history.
