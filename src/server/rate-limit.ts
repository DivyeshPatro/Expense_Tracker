// Explicit rate limiting for the auth endpoints that matter most for abuse
// (credential stuffing on sign-in, spam account creation, email-bombing via
// password-reset requests).
//
// Two tiers, in order of preference:
//
//   1. Upstash Redis — REST-based, so it works from Edge middleware and is
//      correct across Vercel's many serverless instances.
//   2. An in-process sliding window — used whenever Upstash isn't configured.
//
// Tier 2 exists because tier 1 used to be the only one, and its absence meant
// NO protection at all: a QA pass put twelve consecutive failed sign-ins
// through a stock local install and got twelve 401s, no 429, no backoff. The
// original "fails open" reasoning was written for multi-instance serverless,
// where per-instance counters really are close to useless. But Ledgerly is
// marketed as self-hosted, and a self-hoster following the README sets no
// Upstash variables at all — so the deployment shape that got zero protection
// is also the single-process shape where an in-memory counter is entirely
// adequate.
//
// A per-instance counter is a weaker guarantee than Redis, not a worse one
// than nothing. Where it is weaker (many instances), the startup warning below
// says so out loud rather than leaving the gap silent.

import { Ratelimit } from "@upstash/ratelimit";
// This runs inside middleware.ts, which Next.js executes in the Edge
// Runtime — the package's default "." export always resolves to its Node.js
// build (uses process.version, unavailable there). "/cloudflare" is
// Upstash's documented edge-safe entry, and works on Vercel Edge Middleware
// too (same V8-isolate model), not just literal Cloudflare Workers.
import { Redis } from "@upstash/redis/cloudflare";

export type RateLimitBucket = "auth" | "sensitive";

const CONFIGS: Record<RateLimitBucket, { limit: number; window: `${number} ${"s" | "m" | "h"}` }> = {
  // sign-in / sign-up: enough headroom for a real user mistyping a password
  // a few times, tight enough to blunt credential-stuffing at the network layer.
  auth: { limit: 10, window: "60 s" },
  // password-reset requests, invitation accept: legitimate use is rare per
  // person, so this can be much tighter without bothering anyone real.
  sensitive: { limit: 5, window: "15 m" },
};

const limiters = new Map<RateLimitBucket, Ratelimit | null>();

function getLimiter(bucket: RateLimitBucket): Ratelimit | null {
  if (limiters.has(bucket)) return limiters.get(bucket)!;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    limiters.set(bucket, null);
    return null;
  }
  const { limit, window } = CONFIGS[bucket];
  const rl = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(limit, window),
    prefix: `ledgerly-rl-${bucket}`,
    analytics: false,
  });
  limiters.set(bucket, rl);
  return rl;
}

// ── Tier 2: in-process sliding window ──────────────────────────────────────

function windowMs(window: `${number} ${"s" | "m" | "h"}`): number {
  const [value, unit] = window.split(" ") as [string, "s" | "m" | "h"];
  const scale = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
  return Number(value) * scale;
}

/** identifier → hit timestamps inside the current window. */
const hits = new Map<string, number[]>();

// Without this the map grows one entry per distinct IP, forever. Pruning on
// write (rather than on a timer) keeps this free of background work in the
// Edge runtime, where timers aren't reliable across invocations.
const PRUNE_AT = 5_000;

function pruneExpired(now: number) {
  const widest = Math.max(...Object.values(CONFIGS).map((c) => windowMs(c.window)));
  for (const [key, times] of hits) {
    if (times.length === 0 || times[times.length - 1] <= now - widest) hits.delete(key);
  }
}

function inProcessLimit(
  bucket: RateLimitBucket,
  identifier: string,
  now: number
): { allowed: boolean; retryAfterSeconds: number } {
  const { limit, window } = CONFIGS[bucket];
  const ms = windowMs(window);
  const key = `${bucket}:${identifier}`;
  const recent = (hits.get(key) ?? []).filter((t) => t > now - ms);

  if (recent.length >= limit) {
    hits.set(key, recent);
    // The window frees up when the OLDEST hit in it expires.
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + ms - now) / 1000)) };
  }

  recent.push(now);
  hits.set(key, recent);
  if (hits.size > PRUNE_AT) pruneExpired(now);
  return { allowed: true, retryAfterSeconds: 0 };
}

let warned = false;

/** Announce the weaker guarantee once per process, so it is never silent. */
function warnUnconfiguredOnce() {
  if (warned) return;
  warned = true;
  console.warn(
    "[ledgerly] UPSTASH_REDIS_REST_URL/TOKEN are not set. Auth rate limiting is " +
      "running per-process instead of shared. That is fine for a single-instance " +
      "self-hosted deployment, but on multi-instance/serverless hosting each " +
      "instance counts separately — set the Upstash variables there. See .env.example."
  );
}

/** Test seam: clears in-process state so cases can't leak into each other. */
export function __resetRateLimitState() {
  hits.clear();
  warned = false;
}

export async function checkRateLimit(
  bucket: RateLimitBucket,
  identifier: string,
  now: number = Date.now()
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const rl = getLimiter(bucket);
  if (!rl) {
    warnUnconfiguredOnce();
    return inProcessLimit(bucket, identifier, now);
  }
  const { success, reset } = await rl.limit(identifier);
  return { allowed: success, retryAfterSeconds: Math.max(1, Math.ceil((reset - now) / 1000)) };
}
