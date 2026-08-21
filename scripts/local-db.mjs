// What counts as "the local database", in one place.
//
// Both guards read from here: db-local.mjs, which FORCES the local URL before
// spawning a command, and the integration suite's global setup, which REFUSES
// to run if it was not forced. Two mechanisms, one definition of local — so
// there is no way for them to disagree about what they are protecting.

/** The canonical local Docker DB (ledgerly-pg). Overridable for a differently
 *  configured local box, but still required to be local by isLocal(). */
export const LOCAL = process.env.LEDGERLY_LOCAL_DB || "postgresql://postgres:postgres@127.0.0.1:5432/ledgerly";

/**
 * True only when the URL's HOST is a loopback address.
 *
 * The host is the whole proof: a connection to 127.0.0.1 cannot reach Supabase,
 * whatever the credentials or database name say. Matching on the host rather
 * than blacklisting known-remote hostnames is deliberate — a blacklist fails
 * open on the next hostname nobody thought of, and this must fail closed.
 */
export function isLocal(url) {
  return typeof url === "string" && /@(127\.0\.0\.1|localhost|host\.docker\.internal|\[::1\])[:/]/.test(url);
}

/** The URL with its credentials removed, for printing in an error. */
export function redact(url) {
  return typeof url === "string" ? url.replace(/:\/\/[^@/]+@/, "://***@") : String(url);
}

/**
 * Throw unless every database URL in the environment is local.
 *
 * `env` defaults to the current process but can be any environment — db-local
 * passes the one it is about to hand a child, so the forcing it just did is
 * checked rather than assumed.
 *
 * Called before anything imports @prisma/client. That ordering is the point:
 * importing the client loads .env, whose active DATABASE_URL is the production
 * Supabase pooler, and from then on any query — including a fixture's
 * `user.delete` — lands on real data. An unset DATABASE_URL is a failure too,
 * not a default: unset is exactly the state in which .env would win.
 */
export function assertLocalDb(what, env = process.env) {
  for (const name of ["DATABASE_URL", "DIRECT_URL"]) {
    const url = env[name];
    if (name === "DATABASE_URL" && !url) {
      throw new Error(
        `✗ Refusing to run ${what}: ${name} is not set.\n` +
          `  Unset does NOT mean local — importing @prisma/client loads .env, whose active\n` +
          `  DATABASE_URL is the PRODUCTION database. Run this through the local guard:\n` +
          `      npm run test:integration\n` +
          `  (which is \`node scripts/db-local.mjs vitest run --config vitest.integration.config.ts\`)`
      );
    }
    if (url && !isLocal(url)) {
      throw new Error(
        `✗ Refusing to run ${what}: ${name} is not a local database.\n` +
          `      ${redact(url)}\n` +
          `  Integration tests create, delete and settle real rows. Run them through:\n` +
          `      npm run test:integration`
      );
    }
  }
}
