import { describe, expect, it } from "vitest";
import { definePref, readPref, UNMIGRATED_PREFS } from "./preferences";
import { basisPref, periodPref } from "./prefs-registry";
import { hasExplicitPeriod, periodParamsFromPref, resolvePeriod } from "./period";

const NOW = new Date("2026-08-11T12:00:00+05:30");
const get = (store: Record<string, string>) => (k: string) => store[k];

describe("definePref — a stored value is never trusted", () => {
  const strict = definePref<number>({
    key: "x",
    storage: "cookie",
    fallback: 0,
    parse: (raw) => {
      if (raw === "boom") throw new Error("bad");
      return Number(raw);
    },
    serialize: String,
  });

  it("returns the fallback for missing and empty values", () => {
    expect(strict.parse(undefined)).toBe(0);
    expect(strict.parse(null)).toBe(0);
    expect(strict.parse("")).toBe(0);
  });

  it("swallows a throwing parser rather than breaking the page", () => {
    expect(strict.parse("boom")).toBe(0);
  });
});

describe("basis preference", () => {
  it("reads a stored value", () => {
    expect(readPref(basisPref, get({ "ledgerly-basis": "personal" }))).toBe("personal");
  });
  it("falls back to cash for junk", () => {
    expect(readPref(basisPref, get({ "ledgerly-basis": "'; DROP TABLE" }))).toBe("cash");
    expect(readPref(basisPref, get({}))).toBe("cash");
  });
});

describe("period preference round-trip", () => {
  it("stores and restores every period shape", () => {
    for (const raw of ["", "p=all", "p=2026-07", "from=2026-07-01&to=2026-07-15"]) {
      expect(periodPref.parse(raw)).toBe(raw);
    }
  });

  it("discards an absurdly long cookie value", () => {
    expect(periodPref.parse("p=" + "a".repeat(200))).toBe("");
  });

  it("turns a stored string back into parsePeriod's params", () => {
    expect(periodParamsFromPref("p=all")).toEqual({ p: "all", from: undefined, to: undefined });
    expect(periodParamsFromPref("from=2026-07-01&to=2026-07-15")).toEqual({
      p: undefined,
      from: "2026-07-01",
      to: "2026-07-15",
    });
    expect(periodParamsFromPref("")).toEqual({});
  });
});

describe("resolvePeriod — URL beats the stored preference", () => {
  it("uses the stored period when the URL says nothing", () => {
    expect(resolvePeriod({}, "p=all", NOW).mode).toBe("all");
    expect(resolvePeriod({}, "p=2026-07", NOW).periodKey).toBe("2026-07");
  });

  it("ignores the stored period when the URL carries one", () => {
    // A shared link must show the sender's window, not the recipient's habit.
    expect(resolvePeriod({ p: "2026-06" }, "p=all", NOW).periodKey).toBe("2026-06");
    expect(resolvePeriod({ from: "2026-07-01", to: "2026-07-05" }, "p=all", NOW).mode).toBe("custom");
  });

  it("falls back to the rolling default for a first-time user", () => {
    expect(resolvePeriod({}, undefined, NOW).mode).toBe("recent");
    expect(resolvePeriod({}, "", NOW).mode).toBe("recent");
  });

  it("falls back to the default when the stored value no longer validates", () => {
    // A month that has since become the future, and an inverted custom range.
    expect(resolvePeriod({}, "p=2027-01", NOW).mode).toBe("recent");
    expect(resolvePeriod({}, "from=2026-08-10&to=2026-08-01", NOW).mode).toBe("recent");
    expect(resolvePeriod({}, "p=garbage", NOW).mode).toBe("recent");
  });

  it("detects an explicit period in the URL", () => {
    expect(hasExplicitPeriod({ p: "all" })).toBe(true);
    expect(hasExplicitPeriod({ from: "2026-07-01", to: "2026-07-02" })).toBe(true);
    // a half-specified range isn't explicit — parsePeriod would reject it anyway
    expect(hasExplicitPeriod({ from: "2026-07-01" })).toBe(false);
    expect(hasExplicitPeriod({})).toBe(false);
  });
});

describe("registry completeness", () => {
  it("documents the preferences that still own their own storage", () => {
    // Guards against a fifth ad-hoc mechanism appearing without being listed.
    expect(UNMIGRATED_PREFS.map((p) => p.key)).toEqual([
      "ledgerly-theme",
      "ledgerly-skin",
      "ledgerly-nav-prefs",
      "ledgerly-dash-hidden",
    ]);
  });
});
