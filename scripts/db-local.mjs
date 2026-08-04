// Runs a database command against the LOCAL Docker Postgres ONLY, and refuses to
// run against anything that isn't local.
//
// Why this exists: the Prisma datasource's `directUrl` defaults to the .env
// (production Supabase) session pooler, so a bare `prisma migrate reset --force`
// or `prisma migrate dev` would target PROD — and `reset --force` drops every
// table and re-seeds with no prompt. That is an irreversible wipe of real data.
// Routing db:migrate / db:reset / db:seed through here forces both connection
// vars to the local URL before spawning, so they physically cannot reach
// Supabase. A deliberate prod migration still uses `npx prisma migrate deploy`
// directly (deploy never resets), which is the explicit, intended path.

import { spawnSync } from "node:child_process";

// The canonical local Docker DB (ledgerly-pg). Overridable for a differently
// configured local box, but still required to be local by the guard below.
const LOCAL = process.env.LEDGERLY_LOCAL_DB || "postgresql://postgres:postgres@127.0.0.1:5432/ledgerly";

const isLocal = (url) => /@(127\.0\.0\.1|localhost|host\.docker\.internal|\[::1\])[:/]/.test(url);

if (!isLocal(LOCAL)) {
  console.error(`✗ Refusing to run: "${LOCAL}" is not a local database. This command only targets local.`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node scripts/db-local.mjs <command> [args...]   e.g. prisma migrate dev");
  process.exit(1);
}

// Force BOTH vars local. Prisma/dotenv won't override already-set process.env
// vars, so these win over the Supabase values in .env — the same precedence the
// rest of the local workflow relies on.
const env = { ...process.env, DATABASE_URL: LOCAL, DIRECT_URL: LOCAL };

console.log(`→ running \`${args.join(" ")}\` against LOCAL (127.0.0.1:5432/ledgerly)`);
const res = spawnSync("npx", args, { stdio: "inherit", env, shell: true });
process.exit(res.status ?? 1);
