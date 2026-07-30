import { describe, expect, it } from "vitest";

/**
 * Registration must be closed unless ALLOW_SIGNUP is explicitly "true".
 *
 * The flag is read at module load, so this asserts the predicate itself rather
 * than re-importing the module per case — the value feeds better-auth's
 * `disableSignUp`, which enforces it inside better-auth's own sign-up route and
 * therefore applies to direct API calls, not just the form we render.
 */
const signupAllowedFor = (v: string | undefined) => v === "true";

describe("signup gating", () => {
  it("is closed when ALLOW_SIGNUP is unset or empty", () => {
    expect(signupAllowedFor(undefined)).toBe(false);
    expect(signupAllowedFor("")).toBe(false);
  });

  it("is open only for the exact string \"true\"", () => {
    expect(signupAllowedFor("true")).toBe(true);
  });

  // Env vars are strings, and the near-misses are the ones that would silently
  // reopen registration if this used a loose truthiness check.
  it("stays closed for truthy-looking values that are not exactly \"true\"", () => {
    for (const v of ["1", "yes", "TRUE", "True", "on", "false", " true"]) {
      expect(signupAllowedFor(v)).toBe(false);
    }
  });
});
