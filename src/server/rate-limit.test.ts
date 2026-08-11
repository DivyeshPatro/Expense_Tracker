import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit, __resetRateLimitState } from "./rate-limit";

// UPSTASH_REDIS_REST_URL/TOKEN are intentionally unset in the test env, which
// is the state a self-hosted install runs in by default.
//
// This file previously asserted the opposite of what it asserts now: that an
// unconfigured limiter allows all 20 of 20 attempts. That was the documented
// intent at the time ("fails open"), but it meant a stock deployment had no
// brute-force protection on sign-in whatsoever — twelve wrong passwords in a
// row all returned 401 with no backoff. The in-process fallback closes that,
// so the expectation is inverted deliberately rather than by accident.

const AUTH_LIMIT = 10; // CONFIGS.auth.limit — 10 per 60s
const SENSITIVE_LIMIT = 5; // CONFIGS.sensitive.limit — 5 per 15m

beforeEach(() => {
  __resetRateLimitState();
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("checkRateLimit — in-process fallback when Upstash isn't configured", () => {
  it("allows up to the auth limit, then blocks", async () => {
    const now = 1_000_000;
    for (let i = 0; i < AUTH_LIMIT; i++) {
      expect((await checkRateLimit("auth", "1.2.3.4", now)).allowed).toBe(true);
    }
    const blocked = await checkRateLimit("auth", "1.2.3.4", now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("blocks the twelve-failed-sign-ins case that prompted this", async () => {
    const now = 1_000_000;
    const results = [];
    for (let i = 0; i < 12; i++) results.push((await checkRateLimit("auth", "9.9.9.9", now)).allowed);
    expect(results.filter(Boolean)).toHaveLength(AUTH_LIMIT);
    expect(results.slice(-2)).toEqual([false, false]);
  });

  it("recovers once the window has passed", async () => {
    const now = 1_000_000;
    for (let i = 0; i < AUTH_LIMIT; i++) await checkRateLimit("auth", "5.5.5.5", now);
    expect((await checkRateLimit("auth", "5.5.5.5", now)).allowed).toBe(false);
    // 60s window + 1ms
    expect((await checkRateLimit("auth", "5.5.5.5", now + 60_001)).allowed).toBe(true);
  });

  it("slides rather than resetting in fixed blocks", async () => {
    const start = 2_000_000;
    // Spend the budget across the first half of the window.
    for (let i = 0; i < AUTH_LIMIT; i++) await checkRateLimit("auth", "6.6.6.6", start + i * 100);
    // 30s in, nothing has expired yet, so still blocked.
    expect((await checkRateLimit("auth", "6.6.6.6", start + 30_000)).allowed).toBe(false);
    // Just past the oldest hit's expiry, exactly one slot frees up.
    const freed = await checkRateLimit("auth", "6.6.6.6", start + 60_001);
    expect(freed.allowed).toBe(true);
    expect((await checkRateLimit("auth", "6.6.6.6", start + 60_002)).allowed).toBe(false);
  });

  it("keeps identifiers independent — one attacker can't lock everyone out", async () => {
    const now = 3_000_000;
    for (let i = 0; i < AUTH_LIMIT; i++) await checkRateLimit("auth", "attacker", now);
    expect((await checkRateLimit("auth", "attacker", now)).allowed).toBe(false);
    expect((await checkRateLimit("auth", "innocent-user", now)).allowed).toBe(true);
  });

  it("keeps buckets independent, with the tighter sensitive limit", async () => {
    const now = 4_000_000;
    for (let i = 0; i < SENSITIVE_LIMIT; i++) {
      expect((await checkRateLimit("sensitive", "a@b.com", now)).allowed).toBe(true);
    }
    expect((await checkRateLimit("sensitive", "a@b.com", now)).allowed).toBe(false);
    // same identifier, different bucket — untouched
    expect((await checkRateLimit("auth", "a@b.com", now)).allowed).toBe(true);
  });

  it("reports a retry-after that actually clears the block", async () => {
    const now = 5_000_000;
    for (let i = 0; i < AUTH_LIMIT; i++) await checkRateLimit("auth", "7.7.7.7", now);
    const { retryAfterSeconds } = await checkRateLimit("auth", "7.7.7.7", now);
    expect((await checkRateLimit("auth", "7.7.7.7", now + retryAfterSeconds * 1000)).allowed).toBe(true);
  });

  it("warns once, not on every request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = 6_000_000;
    await checkRateLimit("auth", "8.8.8.8", now);
    await checkRateLimit("auth", "8.8.8.8", now);
    await checkRateLimit("sensitive", "8.8.8.8", now);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("UPSTASH_REDIS_REST_URL");
  });
});
