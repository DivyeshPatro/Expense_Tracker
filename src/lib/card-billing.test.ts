import { describe, expect, it } from "vitest";
import { cardCycleForDate, formatCardGuidance } from "./card-billing";

describe("cardCycleForDate", () => {
  it("a spend well before the statement day falls in the current month's cycle", () => {
    const c = cardCycleForDate("2026-07-10", 25, 10);
    expect(c.statementDate).toBe("2026-07-25");
  });

  it("a spend after the statement day rolls into next month's cycle", () => {
    const c = cardCycleForDate("2026-07-28", 25, 10);
    expect(c.statementDate).toBe("2026-08-25");
  });

  it("a spend exactly ON the statement day is included in that day's cut, not rolled forward", () => {
    const c = cardCycleForDate("2026-07-25", 25, 10);
    expect(c.statementDate).toBe("2026-07-25");
  });

  it("statement day after due day (numerically): due date rolls into the month after the statement", () => {
    // statement cuts the 28th, due the 15th — the 15th of the SAME month is
    // before the 28th, so it must be the 15th of the NEXT month
    const c = cardCycleForDate("2026-01-10", 28, 15);
    expect(c.statementDate).toBe("2026-01-28");
    expect(c.dueDate).toBe("2026-02-15");
  });

  it("statement day before due day (numerically): due date stays in the statement's own month", () => {
    const c = cardCycleForDate("2026-07-10", 3, 18);
    expect(c.statementDate).toBe("2026-08-03");
    expect(c.dueDate).toBe("2026-08-18");
  });

  it("December statement rolls the due date into January", () => {
    const c = cardCycleForDate("2026-12-28", 25, 10);
    expect(c.statementDate).toBe("2027-01-25");
    expect(c.dueDate).toBe("2027-02-10");
  });

  it("a spend in December before the statement day cuts within December, due date rolls into January", () => {
    const c = cardCycleForDate("2026-12-05", 25, 10);
    expect(c.statementDate).toBe("2026-12-25");
    expect(c.dueDate).toBe("2027-01-10");
  });

  it("leap year: statement day 31 clamps to Feb 29 in a leap year", () => {
    const c = cardCycleForDate("2028-02-15", 31, 15);
    expect(c.statementDate).toBe("2028-02-29");
  });

  it("non-leap year: statement day 31 clamps to Feb 28", () => {
    const c = cardCycleForDate("2026-02-15", 31, 15);
    expect(c.statementDate).toBe("2026-02-28");
  });

  it("30-day month: statement day 31 clamps to the 30th (April)", () => {
    const c = cardCycleForDate("2026-04-15", 31, 5);
    expect(c.statementDate).toBe("2026-04-30");
  });

  it("30-day month: statement day 31 clamps to the 30th (June, September, November)", () => {
    expect(cardCycleForDate("2026-06-15", 31, 5).statementDate).toBe("2026-06-30");
    expect(cardCycleForDate("2026-09-15", 31, 5).statementDate).toBe("2026-09-30");
    expect(cardCycleForDate("2026-11-15", 31, 5).statementDate).toBe("2026-11-30");
  });

  it("31-day month: statement day 31 is used exactly", () => {
    const c = cardCycleForDate("2026-07-15", 31, 5);
    expect(c.statementDate).toBe("2026-07-31");
  });

  it("due day 31 clamps to the shorter month it lands in", () => {
    // statement cuts the 1st — a mid-January spend rolls into the cycle
    // ending Feb 1, whose due day 31 clamps to Feb 28 (2026, non-leap)
    const c = cardCycleForDate("2026-01-15", 1, 31);
    expect(c.statementDate).toBe("2026-02-01");
    expect(c.dueDate).toBe("2026-02-28");
  });

  it("cycleStart is the day after the previous statement date", () => {
    const c = cardCycleForDate("2026-07-10", 25, 10);
    expect(c.cycleStart).toBe("2026-06-26");
  });

  it("cycleStart correctly rolls back across a year boundary", () => {
    const c = cardCycleForDate("2027-01-10", 25, 10);
    expect(c.cycleStart).toBe("2026-12-26");
  });

  it("same statement/due day produces a due date exactly one month after the statement", () => {
    const c = cardCycleForDate("2026-07-10", 15, 15);
    expect(c.statementDate).toBe("2026-07-15");
    expect(c.dueDate).toBe("2026-08-15");
  });
});

describe("formatCardGuidance", () => {
  const now = new Date("2026-08-11T00:00:00+05:30");

  it("more than a week out: plain 'Recover before' phrasing", () => {
    expect(formatCardGuidance("2026-08-25", now)).toBe("Recover before 25 Aug to avoid interest");
  });

  it("within a week: shows the day count", () => {
    expect(formatCardGuidance("2026-08-15", now)).toBe("Recover before 15 Aug — 4 days left");
  });

  it("exactly one day left uses singular phrasing", () => {
    expect(formatCardGuidance("2026-08-12", now)).toBe("Recover before 12 Aug — 1 day left");
  });

  it("due today gets its own phrasing", () => {
    expect(formatCardGuidance("2026-08-11", now)).toBe("Due today (11 Aug) — recover now to avoid interest");
  });

  it("a date already past is phrased as overdue", () => {
    expect(formatCardGuidance("2026-08-01", now)).toBe("Overdue since 1 Aug");
  });
});
