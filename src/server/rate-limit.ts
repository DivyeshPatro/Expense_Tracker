// Explicit rate limiting for the auth endpoints that matter most for abuse
// (credential stuffing on sign-in, spam account creation, email-bombing via
// password-reset requests). Backed by Upstash Redis — REST-based, so it
// works from Edge middleware and is safe across Vercel's many serverless
// instances (in-memory counters aren't: each instance has its own).
//
// Fails OPEN (never configured => never blocks) rather than closed: without
// UPSTASH_REDIS_REST_URL/TOKEN set, this must not take the whole app down —
// same reasoning as email.ts's Resend fallback.

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

export async function checkRateLimit(bucket: RateLimitBucket, identifier: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const rl = getLimiter(bucket);
  if (!rl) return { allowed: true, retryAfterSeconds: 0 };
  const { success, reset } = await rl.limit(identifier);
  return { allowed: success, retryAfterSeconds: Math.max(1, Math.ceil((reset - Date.now()) / 1000)) };
}
