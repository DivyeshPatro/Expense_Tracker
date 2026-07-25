import { describe, expect, it } from "vitest";
import { advance } from "./dates";

describe("advance", () => {
  it("steps daily and weekly cadences by whole days", () => {
    expect(advance("2026-07-01", "DAILY")).toBe("2026-07-02");
    expect(advance("2026-07-01", "DAILY", 5)).toBe("2026-07-06");
    expect(advance("2026-07-01", "WEEKLY")).toBe("2026-07-08");
    expect(advance("2026-07-01", "WEEKLY", 2)).toBe("2026-07-15");
  });

  it("steps month-based cadences by the right number of months", () => {
    expect(advance("2026-07-15", "MONTHLY")).toBe("2026-08-15");
    expect(advance("2026-07-15", "MONTHLY", 2)).toBe("2026-09-15");
    expect(advance("2026-07-15", "QUARTERLY")).toBe("2026-10-15");
    expect(advance("2026-07-15", "YEARLY")).toBe("2027-07-15");
  });

  it("rolls across year boundaries", () => {
    expect(advance("2026-12-10", "MONTHLY")).toBe("2027-01-10");
    expect(advance("2026-11-30", "QUARTERLY")).toBe("2027-02-28");
    expect(advance("2026-12-31", "DAILY")).toBe("2027-01-01");
  });

  it("clamps to the last day of a shorter target month", () => {
    expect(advance("2026-01-31", "MONTHLY")).toBe("2026-02-28");
    expect(advance("2026-03-31", "MONTHLY")).toBe("2026-04-30");
  });

  it("handles February in a leap year", () => {
    // 2028 is a leap year; 2026 is not.
    expect(advance("2028-01-31", "MONTHLY")).toBe("2028-02-29");
    expect(advance("2028-02-29", "YEARLY")).toBe("2029-02-28");
  });

  // Without an anchor, each step is computed from the previously clamped date,
  // so a month-end schedule silently loses its day and never gets it back.
  it("drifts down permanently without an anchor (documented legacy behaviour)", () => {
    const feb = advance("2026-01-31", "MONTHLY");
    const mar = advance(feb, "MONTHLY");
    expect(feb).toBe("2026-02-28");
    expect(mar).toBe("2026-03-28"); // not the 31st — the schedule has moved
  });

  it("keeps the original day when given an anchor", () => {
    const feb = advance("2026-01-31", "MONTHLY", 1, 31);
    const mar = advance(feb, "MONTHLY", 1, 31);
    const apr = advance(mar, "MONTHLY", 1, 31);
    expect(feb).toBe("2026-02-28"); // still clamped for February itself…
    expect(mar).toBe("2026-03-31"); // …but March gets the 31st back
    expect(apr).toBe("2026-04-30"); // and April clamps on its own terms
  });

  it("anchors quarterly and yearly schedules too", () => {
    expect(advance("2026-11-30", "QUARTERLY", 1, 31)).toBe("2027-02-28");
    expect(advance("2027-02-28", "QUARTERLY", 1, 31)).toBe("2027-05-31");
    expect(advance("2028-02-29", "YEARLY", 1, 29)).toBe("2029-02-28");
  });

  it("ignores the anchor for day-based cadences", () => {
    expect(advance("2026-07-01", "DAILY", 1, 31)).toBe("2026-07-02");
    expect(advance("2026-07-01", "WEEKLY", 1, 31)).toBe("2026-07-08");
  });

  it("ignores an out-of-range or absent anchor and falls back to the date's own day", () => {
    expect(advance("2026-01-15", "MONTHLY", 1, 0)).toBe("2026-02-15");
    expect(advance("2026-01-15", "MONTHLY", 1, 99)).toBe("2026-02-15");
    expect(advance("2026-01-15", "MONTHLY", 1, null)).toBe("2026-02-15");
    expect(advance("2026-01-15", "MONTHLY", 1, undefined)).toBe("2026-02-15");
  });
});
