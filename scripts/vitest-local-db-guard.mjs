// The integration suite's second lock.
//
// `npm run test:integration` routes through db-local.mjs, which forces both
// database URLs local before vitest starts. This runs inside vitest and checks
// that it happened — so running the suite the obvious other way,
//
//     npx vitest run --config vitest.integration.config.ts
//
// fails loudly instead of quietly connecting to production. Vitest runs a
// globalSetup in the main process before any test file is loaded, which is
// before @prisma/client is imported and therefore before .env can be read.

import { assertLocalDb, redact } from "./local-db.mjs";

export function setup() {
  assertLocalDb("the integration suite");
  console.log(`✓ integration DB is local: ${redact(process.env.DATABASE_URL)}`);
}
