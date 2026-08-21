// Read-only facts about the production database's migration state.
//
// Nothing here writes, migrates, or mutates. It exists so a deployment can be
// stopped *before* it goes live when the schema it needs is not there yet —
// the failure that took /shared down: 4f0819f shipped code selecting
// Settlement.fromParticipantId while the column did not exist, because nothing
// in the pipeline ever ran `prisma migrate deploy`.
//
// The counterpart of scripts/local-db.mjs: that one proves a database is local
// before tests touch it, this one proves production's schema matches the code
// before that code is served.

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The URL with its credentials removed. Nothing here ever logs a raw URL. */
export function redact(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}:${u.port || "(default)"}${u.pathname}`;
  } catch {
    return "(unparseable URL)";
  }
}

/**
 * Throw unless `url` is a DIRECT Postgres connection.
 *
 * Supabase's 6543 endpoint is pgBouncer in transaction mode: it hangs on DDL
 * and on the advisory lock Prisma Migrate takes, so a migration sent there does
 * not fail — it stalls, holding the deploy open. The schema's own datasource
 * comment records this. Migrations and this check both go over 5432.
 *
 * Anything unrecognised is rejected rather than assumed fine: a guard that
 * cannot tell what it is looking at must stop, not shrug.
 */
export function assertDirectUrl(url, what = "this command") {
  if (!url) {
    throw new Error(
      `✗ Refusing to run ${what}: DIRECT_URL is not set.\n` +
        `  Unset is not "probably fine" — it is the one state in which nothing can be verified.`
    );
  }
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`✗ Refusing to run ${what}: DIRECT_URL is not a parseable connection string.`);
  }
  if (u.port === "6543" || u.searchParams.get("pgbouncer") === "true") {
    throw new Error(
      `✗ Refusing to run ${what}: DIRECT_URL points at the transaction pooler.\n` +
        `      ${redact(url)}\n` +
        `  DDL and Prisma's migration advisory lock hang on pgBouncer. Use the direct 5432 connection.`
    );
  }
  if (u.port !== "5432") {
    throw new Error(
      `✗ Refusing to run ${what}: DIRECT_URL is not on port 5432.\n` +
        `      ${redact(url)}\n` +
        `  Only the direct Postgres port is accepted, so a pooled endpoint cannot slip in unnoticed.`
    );
  }
  return u;
}

/** Migration names committed to the repository, in lexical (chronological) order. */
export function repoMigrations() {
  const dir = fileURLToPath(new URL("../prisma/migrations", import.meta.url));
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * What the database says about its own migrations.
 *
 * Returns applied names plus anything half-finished. A row with no finished_at,
 * or one marked rolled back, means an earlier deploy died mid-migration — the
 * schema is in an unknown state and no code should be promoted onto it.
 */
export async function migrationState(prisma) {
  const rows = await prisma.$queryRaw`
    select migration_name, finished_at, rolled_back_at
    from "_prisma_migrations"`;
  const applied = [];
  const broken = [];
  for (const r of rows) {
    if (r.rolled_back_at !== null || r.finished_at === null) broken.push(r.migration_name);
    else applied.push(r.migration_name);
  }
  return { applied, broken };
}
