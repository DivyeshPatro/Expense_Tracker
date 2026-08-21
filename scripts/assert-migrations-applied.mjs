// Defence in depth: a production build refuses to complete when the database
// is missing a migration the code needs.
//
// The authoritative ordering lives in .github/workflows/deploy.yml, which
// migrates before it deploys. This is the second, independent lock — it catches
// the paths that bypass the workflow entirely: a dashboard redeploy, a manual
// `vercel deploy`, someone re-enabling Git auto-deploy. It reads; it never
// writes, never migrates, and never prints a connection string.
//
// Usage (from vercel.json buildCommand):
//     node scripts/assert-migrations-applied.mjs && next build
//     node scripts/assert-migrations-applied.mjs --connection-only

// NOT a static import of @prisma/client. Importing it loads .env, and a .env
// whose DIRECT_URL points at production would silently satisfy a check that is
// supposed to fail when nothing was configured — the identical mechanism that
// sent the integration suite at production in the first place. The environment
// is captured here, BEFORE anything can populate it, and the client is pulled
// in later with a dynamic import.
import { assertDirectUrl, migrationState, redact, repoMigrations } from "./prod-db.mjs";

const CONFIGURED_URL = process.env.DIRECT_URL;
const connectionOnly = process.argv.includes("--connection-only");

// ONLY AN EXPLICIT NON-PRODUCTION ENVIRONMENT MAY SKIP.
//
// VERCEL_ENV is set by Vercel to production | preview | development. A preview
// build must never reach the production database — there is one database, so a
// preview that "just checked" would be a preview holding a connection to real
// data. Those two values, and only those two, skip.
//
// Anything else — unset, or a value this script does not recognise — FAILS.
// The earlier version skipped on unset, which inverted the whole point: the one
// scenario where nobody can say what environment this is became the scenario
// where nothing was checked. A guard that goes quiet exactly when it is unsure
// is not a guard. deploy.yml therefore sets VERCEL_ENV explicitly rather than
// trusting the platform to have done it.
//
// This file only ever runs from vercel.json's buildCommand — a Vercel platform
// build or `vercel build` — so failing on unset breaks no local or CI build:
// `next build` does not read buildCommand.
const SKIPPABLE = new Set(["preview", "development"]);
const env = process.env.VERCEL_ENV;
if (!connectionOnly) {
  if (SKIPPABLE.has(env)) {
    console.log(`✓ migration assertion skipped — explicitly non-production (VERCEL_ENV=${env}). No database connection opened.`);
    process.exit(0);
  }
  if (env !== "production") {
    console.error(
      `✗ Refusing to build: VERCEL_ENV is ${env === undefined ? "not set" : `an unrecognised value (${env})`}.
` +
        `  This build cannot be shown to be non-production, so the schema check cannot be skipped.
` +
        `  Set VERCEL_ENV to production, preview, or development.`
    );
    process.exit(1);
  }
}

let prisma;
try {
  const url = CONFIGURED_URL;
  assertDirectUrl(url, "the production build");
  console.log(`→ checking migration state on ${redact(url)}`);
  if (connectionOnly) {
    console.log("✓ DIRECT_URL is a direct 5432 connection");
    process.exit(0);
  }

  // Imported only now, once the URL has been captured and validated. The
  // explicit datasource override means this can never follow the pooled runtime
  // URL the app itself uses, nor anything .env introduces on import.
  const { PrismaClient } = await import("@prisma/client");
  prisma = new PrismaClient({ datasources: { db: { url } }, log: [] });

  const { applied, broken } = await migrationState(prisma);
  const repo = repoMigrations();

  if (broken.length) {
    throw new Error(
      `✗ Blocking the build: ${broken.length} migration(s) are recorded as failed or rolled back.\n` +
        broken.map((m) => `      ${m}`).join("\n") +
        `\n  The schema is in an unknown state. Resolve it with \`prisma migrate resolve\` before deploying.`
    );
  }

  const appliedSet = new Set(applied);
  const pending = repo.filter((m) => !appliedSet.has(m));
  if (pending.length) {
    throw new Error(
      `✗ Blocking the build: ${pending.length} migration(s) in the repository are not applied to this database.\n` +
        pending.map((m) => `      ${m}`).join("\n") +
        `\n  This deployment's code expects a schema that does not exist yet — exactly the mismatch that\n` +
        `  took /shared down. Apply them first (the deploy workflow does this automatically):\n` +
        `      npx prisma migrate deploy`
    );
  }

  // The database knowing MORE than the repository is the rollback case: older
  // code being redeployed onto a newer schema. Safe under the expand-only
  // discipline every migration here has followed (no DROP COLUMN or DROP TABLE
  // in the history), so it is reported rather than blocked — blocking it would
  // make rolling back impossible, which is the opposite of what this is for.
  const repoSet = new Set(repo);
  const ahead = applied.filter((m) => !repoSet.has(m));
  if (ahead.length) {
    console.log(`⚠ database has ${ahead.length} migration(s) not in this checkout — deploying older code onto a newer schema:`);
    for (const m of ahead) console.log(`      ${m}`);
  }

  console.log(`✓ schema is up to date — ${applied.length} migration(s) applied, none pending`);
} catch (e) {
  // Fail closed. Any failure to establish the schema state — unreachable host,
  // missing _prisma_migrations, bad credentials — blocks the build, because
  // "we could not check" and "it is fine" are not the same answer.
  console.error(e instanceof Error ? e.message : String(e));
  console.error("\n✗ Build stopped: could not establish that the database schema matches this code.");
  process.exitCode = 1;
} finally {
  await prisma?.$disconnect();
}
