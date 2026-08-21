// The production build assertion, exercised end to end against a throwaway
// local database.
//
// The property under test is asymmetric, and the asymmetry is the point: a
// build may be waved through ONLY when something explicitly says it is not
// production. Silence — an unset or unrecognised VERCEL_ENV — must stop the
// build, because "we could not tell" and "it is fine" are different answers and
// conflating them is what put a stale schema in front of production code.
//
// Local Docker only. A scratch database is created, migrated, mutated to
// reproduce the outage state, and dropped. Production is never contacted: the
// environment handed to each child process is built from a copy with both
// database URLs REMOVED, so nothing can inherit .env's production values.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Captured before anything can import @prisma/client and load .env.
const BASE_ENV = { ...process.env };
delete BASE_ENV.DATABASE_URL;
delete BASE_ENV.DIRECT_URL;
delete BASE_ENV.VERCEL_ENV;

const LOCAL = process.env.LEDGERLY_LOCAL_DB || "postgresql://postgres:postgres@127.0.0.1:5432/ledgerly";
const SCRATCH_DB = "ledgerly_assertion_test";
const SCRATCH = LOCAL.replace(/\/[^/]*$/, `/${SCRATCH_DB}`);
const ASSERTION = fileURLToPath(new URL("./assert-migrations-applied.mjs", import.meta.url));
// The migration whose absence caused the /shared outage — the case this whole
// mechanism exists to catch, so it is the one the tests remove.
const INCIDENT_MIGRATION = "20260821093757_member_to_member_settlements";

/** Run the assertion with a precisely controlled environment. */
function runAssertion({ vercelEnv, directUrl }) {
  const env = { ...BASE_ENV };
  if (vercelEnv !== undefined) env.VERCEL_ENV = vercelEnv;
  if (directUrl !== undefined) env.DIRECT_URL = directUrl;
  const r = spawnSync(process.execPath, [ASSERTION], { env, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() };
}

let admin;
const failures = [];

function check(name, { vercelEnv, directUrl }, expected) {
  const { code, out } = runAssertion({ vercelEnv, directUrl });
  const actual = code === 0 ? (out.includes("skipped") ? "SKIP" : "PASS") : "FAIL";
  const ok = actual === expected;
  if (!ok) failures.push(`${name}: expected ${expected}, got ${actual}\n      ${out.split("\n")[0]}`);
  const label = `VERCEL_ENV=${vercelEnv ?? "(unset)"}`.padEnd(26);
  console.log(`  ${ok ? "✓" : "✗"} ${label} ${name.padEnd(34)} → ${actual}`);
}

async function main() {
  const { PrismaClient } = await import("@prisma/client");
  admin = new PrismaClient({ datasources: { db: { url: LOCAL } } });

  // CREATE DATABASE cannot run inside a transaction, so it goes out unwrapped.
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${SCRATCH_DB}"`);

  // One command string rather than argv + shell:true, which Node deprecates
  // because the arguments would be concatenated unescaped.
  const migrated = spawnSync("npx prisma migrate deploy", {
    env: { ...BASE_ENV, DATABASE_URL: SCRATCH, DIRECT_URL: SCRATCH },
    encoding: "utf8",
    shell: true,
  });
  if (migrated.status !== 0) throw new Error(`could not prepare the scratch database:\n${migrated.stdout}${migrated.stderr}`);

  const scratch = new PrismaClient({ datasources: { db: { url: SCRATCH } } });
  try {
    console.log("\n── schema up to date ──");
    check("up-to-date + production", { vercelEnv: "production", directUrl: SCRATCH }, "PASS"); // 7
    check("up-to-date, no DIRECT_URL", { vercelEnv: undefined, directUrl: undefined }, "FAIL"); // 6

    // Reproduce the outage: the code carries a migration the database lacks.
    await scratch.$executeRawUnsafe(`DELETE FROM "_prisma_migrations" WHERE migration_name = '${INCIDENT_MIGRATION}'`);

    console.log("\n── migration pending (the /shared outage state) ──");
    check("pending + production", { vercelEnv: "production", directUrl: SCRATCH }, "FAIL"); // 1
    check("pending, VERCEL_ENV unset", { vercelEnv: undefined, directUrl: SCRATCH }, "FAIL"); // 2
    check("pending + preview", { vercelEnv: "preview", directUrl: SCRATCH }, "SKIP"); // 3
    check("pending + development", { vercelEnv: "development", directUrl: SCRATCH }, "SKIP"); // 4
    check("pending + unknown env", { vercelEnv: "staging", directUrl: SCRATCH }, "FAIL"); // 5
  } finally {
    await scratch.$disconnect();
  }
}

try {
  await main();
} catch (e) {
  failures.push(`harness error: ${e.message}`);
} finally {
  if (admin) {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`).catch(() => {});
    await admin.$disconnect();
  }
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} case(s) behaved wrongly:`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log("\n✓ all 7 cases behaved as required — only an explicit non-production environment skips");
