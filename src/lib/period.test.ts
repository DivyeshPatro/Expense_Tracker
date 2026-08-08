import { describe, expect, it } from "vitest";
import { parsePeriod, periodQueryParams, RECENT_DAYS } from "./period";

// Fixed "now" so the rolling window is deterministic: 8 Aug 2026, IST-safe midday.
const NOW = new Date("2026-08-08T06:30:00.000Z");

describe("parsePeriod — the default window (#186)", () => {
  it("defaults to a rolling last-30-days window, not the calendar month", () => {
    const p = parsePeriod({}, NOW);
    expect(p.mode).toBe("recent");
    expect(p.to).toBe("2026-08-08");
    expect(p.from).toBe("2026-07-10"); // inclusive of today ⇒ 30 days back is the 10th
    expect(p.label).toBe(`LAST ${RECENT_DAYS} DAYS`);
  });

  it("covers a window that spans the month boundary", () => {
    // the whole point: on the 8th, a calendar month shows 8 days, this shows 30
    const p = parsePeriod({}, NOW);
    expect(p.from < "2026-08-01").toBe(true);
  });

  it("round-trips to an empty query string", () => {
    expect(periodQueryParams(parsePeriod({}, NOW))).toBe("");
  });
});

describe("parsePeriod — explicit selections still work", () => {
  it("?p=all is all time", () => {
    const p = parsePeriod({ p: "all" }, NOW);
    expect(p.mode).toBe("all");
    expect(p.range.start).toBeUndefined();
    expect(periodQueryParams(p)).toBe("p=all");
  });

  it("the current month is now an explicit choice, not the default", () => {
    const p = parsePeriod({ p: "2026-08" }, NOW);
    expect(p.mode).toBe("month");
    expect(p.periodKey).toBe("2026-08");
    expect(p.from).toBe("2026-08-01");
    // must emit p= even for the current month — "" now means "recent"
    expect(periodQueryParams(p)).toBe("p=2026-08");
  });

  it("a past month resolves to that month", () => {
    const p = parsePeriod({ p: "2026-07" }, NOW);
    expect(p.mode).toBe("month");
    expect(p.label).toBe("JUL 2026");
    expect(periodQueryParams(p)).toBe("p=2026-07");
  });

  it("a custom range is preserved", () => {
    const p = parsePeriod({ from: "2026-01-01", to: "2026-03-31" }, NOW);
    expect(p.mode).toBe("custom");
    expect(periodQueryParams(p)).toBe("from=2026-01-01&to=2026-03-31");
  });

  it("a future month is ignored and falls back to the default", () => {
    expect(parsePeriod({ p: "2027-01" }, NOW).mode).toBe("recent");
  });

  it("a malformed range is ignored and falls back to the default", () => {
    expect(parsePeriod({ from: "nope", to: "2026-01-01" }, NOW).mode).toBe("recent");
    expect(parsePeriod({ from: "2026-05-01", to: "2026-01-01" }, NOW).mode).toBe("recent");
  });
});
