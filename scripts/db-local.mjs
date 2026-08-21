// Runs a database command against the LOCAL Docker Postgres ONLY, and refuses to
// run against anything that isn't local.
//
// Why this exists: the Prisma datasource's `directUrl` defaults to the .env
// (production Supabase) session pooler, so a bare `prisma migrate reset --force`
// or `prisma migrate dev` would target PROD — and `reset --force` drops every
// table and re-seeds with no prompt. That is an irreversible wipe of real data.
// Routing db:migrate / db:reset / db:seed / test:integration through here forces
// both connection vars to the local URL before spawning, so they physically
// cannot reach Supabase. A deliberate prod migration still uses `npx prisma
// migrate deploy` directly (deploy never resets), which is the explicit,
// intended path.
//
// test:integration was added to that list after the integration suite was found
// to resolve to production: @prisma/client loads .env on import, .env's active
// DATABASE_URL is the Supabase pooler, and the suite's fixtures delete and
// re-create rows. Forcing the vars here is the first lock; the suite's own
// globalSetup (scripts/vitest-local-db-guard.mjs) is the second, and refuses to
// start when it was not run through this script.

import { spawnSync } from "node:child_process";
// One definition of "local", shared with the integration suite's own guard so
// the two can never disagree about what they are protecting.
import { assertLocalDb, isLocal, LOCAL, redact } from "./local-db.mjs";

if (!isLocal(LOCAL)) {
  console.error(`✗ Refusing to run: "${LOCAL}" is not a local database. This command only targets local.`);
  process.exit(1);
}

let args = process.argv.slice(2);
// `--shell "cmd && cmd"` runs the rest as one shell command line instead of
// prefixing npx. The e2e entries need it: several are chains, and `node x.mjs`
// has no business going through npx.
const shellMode = args[0] === "--shell";
if (shellMode) args = args.slice(1);
if (args.length === 0) {
  console.error("Usage: node scripts/db-local.mjs [--shell] <command> [args...]   e.g. prisma migrate dev");
  process.exit(1);
}

// A deliberate remote URL is REFUSED, not quietly replaced. Overriding it would
// mean a developer who set DATABASE_URL on purpose got something else without
// being told — and the whole failure this guard exists to prevent was a
// database silently not being the one anybody expected.
for (const name of ["DATABASE_URL", "DIRECT_URL"]) {
  const inherited = process.env[name];
  if (inherited && !isLocal(inherited)) {
    console.error(
      `✗ Refusing to run: ${name} is set to a non-local database.
` +
        `      ${redact(inherited)}
` +
        `  This command only ever targets local. Unset it, or point it at ${redact(LOCAL)}.`
    );
    process.exit(1);
  }
}

// Force BOTH vars local. Prisma/dotenv won't override already-set process.env
// vars, so these win over the Supabase values in .env — the same precedence the
// rest of the local workflow relies on.
const env = { ...process.env, DATABASE_URL: LOCAL, DIRECT_URL: LOCAL };

// Check what we are about to hand the child rather than trusting the two lines
// above — same assertion the integration suite runs on itself.
try {
  assertLocalDb("this command", env);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const command = shellMode ? args.join(" ") : ["npx", ...args].join(" ");
console.log(`→ running \`${args.join(" ")}\` against LOCAL (${redact(LOCAL)})`);
const res = spawnSync(command, { stdio: "inherit", env, shell: true });
process.exit(res.status ?? 1);
