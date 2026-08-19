// The day a settlement is filed under must be the IST day, not the server's.
//
// The cash leg is stamped istNoon(todayYMD()) — the same canonical per-day
// instant every other transaction write uses, so same-day rows tie on
// occurredAt and fall back to entry order. Getting the DAY wrong would file a
// late-evening settlement under yesterday.

import { describe, expect, it } from "vitest";
import { istNoon, todayYMD, toYMD } from "./dates";

describe("settlement date is IST, whatever the server clock says", () => {
  it("rolls to the next day after 18:30 UTC, when IST midnight passes", () => {
    const lateUtc = new Date("2026-08-19T19:00:00Z"); // 00:30 IST on the 20th
    expect(toYMD(lateUtc)).toBe("2026-08-20");
    expect(lateUtc.toISOString().slice(0, 10)).toBe("2026-08-19"); // the naive answer, for contrast
  });

  it("todayYMD is the IST day", () => {
    const lateUtc = new Date("2026-08-19T19:00:00Z");
    expect(todayYMD(lateUtc)).toBe(toYMD(lateUtc));
  });

  it("istNoon of that day is 06:30 UTC — noon in IST", () => {
    expect(istNoon("2026-08-20").toISOString()).toBe("2026-08-20T06:30:00.000Z");
  });

  it("every instant within one IST day maps to the same stamp", () => {
    // 18:31 UTC on the 19th and 18:29 UTC on the 20th are different IST days;
    // everything between two IST midnights collapses to one instant.
    const sameDay = ["2026-08-19T18:31:00Z", "2026-08-20T00:00:00Z", "2026-08-20T18:29:00Z"];
    const stamps = new Set(sameDay.map((s) => istNoon(todayYMD(new Date(s))).getTime()));
    expect(stamps.size).toBe(1);
    expect(new Date([...stamps][0]).toISOString()).toBe("2026-08-20T06:30:00.000Z");
  });
});
