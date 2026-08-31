// Monthly recurrence keeps the day it was set up on.
//
// The bug these cases pin down: a transaction dated the 31st, repeated monthly,
// permanently moved to the 30th. Not because `advance()` was wrong — it clamps
// an occurrence to the month's last day without ever touching the anchor — but
// because the anchor stored alongside the rule was read back off the FIRST RUN,
// which is exactly the date that had just been clamped. September has no 31st,
// so 31 became 30, and every run after that inherited it.
//
// The fix is to carry the day the schedule is really pinned to rather than
// re-derive it, so these test the two halves that have to agree: what
// `anchorDayFor` says the anchor is, and what a schedule built on it produces
// month after month. `firstFutureRun` and `advance` are the production helpers
// the form and the cron actually call — nothing here reimplements a schedule.

import { describe, expect, it } from "vitest";
import { advance } from "@/lib/dates";
import { anchorDayFor, firstFutureRun, type RepeatState } from "./repeat-block";

/** A RepeatState with only the fields the schedule helpers read. */
function repeat(over: Partial<RepeatState> = {}): RepeatState {
  return {
    on: true,
    setOn: () => {},
    cadence: "MONTHLY",
    setCadence: () => {},
    interval: "1",
    setInterval: () => {},
    endDate: "",
    setEndDate: () => {},
    ...over,
  };
}

/**
 * The dates a rule actually produces, the way the cron produces them: each run
 * rolls forward from the PREVIOUS run, carrying the stored anchor. That is the
 * shape that made the old bug permanent — one clamped step poisoned every step
 * after it — so it is the shape worth walking.
 */
function schedule(transactionYmd: string, months: number, state = repeat()): string[] {
  const anchor = anchorDayFor(state.cadence, transactionYmd);
  const out = [firstFutureRun(state, transactionYmd)];
  for (let i = 1; i < months; i++) {
    out.push(advance(out[out.length - 1], state.cadence, Math.max(1, Number(state.interval) || 1), anchor));
  }
  return out;
}

describe("anchorDayFor", () => {
  it("is the transaction's own day for month-based cadences", () => {
    expect(anchorDayFor("MONTHLY", "2026-08-31")).toBe(31);
    expect(anchorDayFor("MONTHLY", "2026-02-01")).toBe(1);
    expect(anchorDayFor("QUARTERLY", "2026-08-31")).toBe(31);
    expect(anchorDayFor("YEARLY", "2028-02-29")).toBe(29);
  });

  it("is nothing at all for day-based cadences", () => {
    // Daily and weekly step by days; a day-of-month would be meaningless and,
    // stored, would make `advance` treat them as month-based.
    expect(anchorDayFor("DAILY", "2026-08-31")).toBeNull();
    expect(anchorDayFor("WEEKLY", "2026-08-31")).toBeNull();
  });

  it("reads the day the transaction happened, not the day the first run lands", () => {
    // The distinction the whole fix rests on: these differ precisely when the
    // next month is too short, which is the case that used to lose the anchor.
    const state = repeat();
    expect(firstFutureRun(state, "2026-08-31")).toBe("2026-09-30");
    expect(anchorDayFor(state.cadence, "2026-08-31")).toBe(31);
    expect(anchorDayFor(state.cadence, firstFutureRun(state, "2026-08-31"))).toBe(30);
  });
});

describe("a monthly schedule anchored on the 31st", () => {
  it("uses the last day of a short month and returns to the 31st after it", () => {
    // The sequence from the report, walked end to end.
    expect(schedule("2026-08-31", 7)).toEqual([
      "2026-09-30",
      "2026-10-31",
      "2026-11-30",
      "2026-12-31",
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
    ]);
  });

  it("survives February in a leap year without adopting the 29th", () => {
    expect(schedule("2028-01-31", 3)).toEqual(["2028-02-29", "2028-03-31", "2028-04-30"]);
  });

  it("survives February in a non-leap year without adopting the 28th", () => {
    expect(schedule("2027-01-31", 3)).toEqual(["2027-02-28", "2027-03-31", "2027-04-30"]);
  });

  it("does not drift, however many short months it crosses", () => {
    // A year and a half from a 31st: every 31-day month must still be the 31st.
    const runs = schedule("2026-01-31", 18);
    const longMonths = runs.filter((ymd) => {
      const m = Number(ymd.slice(5, 7));
      return [1, 3, 5, 7, 8, 10, 12].includes(m);
    });
    expect(longMonths.length).toBeGreaterThan(6);
    expect(longMonths.every((ymd) => ymd.endsWith("-31"))).toBe(true);
  });
});

describe("a monthly schedule anchored on the 30th", () => {
  it("uses February's last day and returns to the 30th", () => {
    expect(schedule("2027-01-30", 4)).toEqual(["2027-02-28", "2027-03-30", "2027-04-30", "2027-05-30"]);
  });

  it("uses the 29th in a leap February and still returns to the 30th", () => {
    expect(schedule("2028-01-30", 3)).toEqual(["2028-02-29", "2028-03-30", "2028-04-30"]);
  });

  it("never reaches the 31st — a 30th anchor is not a month-end anchor", () => {
    // Worth stating: "last day of the month" and "the 30th" are different
    // intentions, and clamping must not quietly promote one into the other.
    expect(schedule("2027-01-30", 6).some((ymd) => ymd.endsWith("-31"))).toBe(false);
  });
});

describe("a monthly schedule anchored on the 29th", () => {
  it("uses the 29th in a leap February", () => {
    expect(schedule("2028-01-29", 3)).toEqual(["2028-02-29", "2028-03-29", "2028-04-29"]);
  });

  it("falls back to the 28th in a non-leap February and returns to the 29th", () => {
    expect(schedule("2027-01-29", 3)).toEqual(["2027-02-28", "2027-03-29", "2027-04-29"]);
  });
});

describe("a monthly schedule anchored on the 28th", () => {
  it("is never clamped, because every month has a 28th", () => {
    expect(schedule("2027-01-28", 4)).toEqual(["2027-02-28", "2027-03-28", "2027-04-28", "2027-05-28"]);
  });
});

describe("cadences that were already right stay right", () => {
  it("daily steps by days and ignores the day of the month", () => {
    const state = repeat({ cadence: "DAILY" });
    expect(firstFutureRun(state, "2026-08-31")).toBe("2026-09-01");
    expect(schedule("2026-08-31", 3, state)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
  });

  it("weekly steps by seven days across a month-end", () => {
    const state = repeat({ cadence: "WEEKLY" });
    expect(schedule("2026-08-31", 3, state)).toEqual(["2026-09-07", "2026-09-14", "2026-09-21"]);
  });

  it("an interval greater than one still lands on the anchor", () => {
    const state = repeat({ interval: "2" });
    expect(schedule("2026-08-31", 3, state)).toEqual(["2026-10-31", "2026-12-31", "2027-02-28"]);
  });

  it("quarterly keeps its day across a short quarter-end", () => {
    const state = repeat({ cadence: "QUARTERLY" });
    expect(schedule("2026-08-31", 3, state)).toEqual(["2026-11-30", "2027-02-28", "2027-05-31"]);
  });

  it("yearly keeps 29 February rather than settling on the 28th", () => {
    const state = repeat({ cadence: "YEARLY" });
    expect(schedule("2028-02-29", 5, state)).toEqual([
      "2029-02-28",
      "2030-02-28",
      "2031-02-28",
      "2032-02-29",
      "2033-02-28",
    ]);
  });

  it("a mid-month day is unaffected either way", () => {
    // The overwhelmingly common case: the carried anchor and the derived one
    // are the same number, so nothing about these schedules changes.
    expect(schedule("2026-08-15", 4)).toEqual(["2026-09-15", "2026-10-15", "2026-11-15", "2026-12-15"]);
    expect(anchorDayFor("MONTHLY", "2026-08-15")).toBe(15);
    expect(anchorDayFor("MONTHLY", firstFutureRun(repeat(), "2026-08-15"))).toBe(15);
  });
});
