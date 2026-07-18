import { describe, expect, it } from "vitest";
import { checkRateLimit } from "./rate-limit";

// UPSTASH_REDIS_REST_URL/TOKEN are intentionally unset in the test env — this
// is the exact "not configured yet" state the app runs in until a real
// Upstash database is wired up, and it must never block real requests.
describe("checkRateLimit — fails open when Upstash isn't configured", () => {
  it("allows every request when no Redis credentials are set", async () => {
    for (let i = 0; i < 20; i++) {
      const result = await checkRateLimit("auth", "1.2.3.4");
      expect(result.allowed).toBe(true);
    }
  });

  it("allows the sensitive bucket too", async () => {
    const result = await checkRateLimit("sensitive", "test@example.com");
    expect(result.allowed).toBe(true);
    expect(result.retryAfterSeconds).toBe(0);
  });
});
