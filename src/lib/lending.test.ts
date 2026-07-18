import { describe, expect, it } from "vitest";
import { computeContactSummary, computeLoanBalances } from "./lending";

const p1 = "participant-1";
const p2 = "participant-2";

describe("lending balance math (Σ GAVE − Σ GOT, positive ⇒ they owe you)", () => {
  it("a single GAVE entry produces a positive balance for the full amount", () => {
    const balances = computeLoanBalances([{ participantId: p1, kind: "GAVE", amount: 200000, dueDate: null }]);
    expect(balances.get(p1)).toMatchObject({ net: 200000, overdueCount: 0 });
  });

  it("a GOT entry after a GAVE entry reduces the balance, not flips direction", () => {
    const balances = computeLoanBalances([
      { participantId: p1, kind: "GAVE", amount: 200000, dueDate: null },
      { participantId: p1, kind: "GOT", amount: 50000, dueDate: null },
    ]);
    expect(balances.get(p1)?.net).toBe(150000);
  });

  it("GOT exceeding prior GAVE flips the balance negative (you now owe them)", () => {
    const balances = computeLoanBalances([
      { participantId: p1, kind: "GAVE", amount: 10000, dueDate: null },
      { participantId: p1, kind: "GOT", amount: 30000, dueDate: null },
    ]);
    expect(balances.get(p1)?.net).toBe(-20000);
  });

  it("borrowing money (a GOT with no prior GAVE) also produces a negative balance", () => {
    const balances = computeLoanBalances([{ participantId: p1, kind: "GOT", amount: 100000, dueDate: null }]);
    expect(balances.get(p1)?.net).toBe(-100000);
  });

  it("fully repaying a loan nets exactly to zero", () => {
    const balances = computeLoanBalances([
      { participantId: p1, kind: "GAVE", amount: 50000, dueDate: null },
      { participantId: p1, kind: "GOT", amount: 50000, dueDate: null },
    ]);
    expect(balances.get(p1)?.net).toBe(0);
  });

  it("keeps separate contacts' balances independent", () => {
    const balances = computeLoanBalances([
      { participantId: p1, kind: "GAVE", amount: 100000, dueDate: null },
      { participantId: p2, kind: "GOT", amount: 40000, dueDate: null },
    ]);
    expect(balances.get(p1)?.net).toBe(100000);
    expect(balances.get(p2)?.net).toBe(-40000);
  });

  it("an empty entry list produces no balances at all", () => {
    expect(computeLoanBalances([]).size).toBe(0);
  });

  it("a past-due GAVE counts as overdue while the contact still owes money", () => {
    const now = new Date("2026-07-18T00:00:00Z");
    const balances = computeLoanBalances(
      [{ participantId: p1, kind: "GAVE", amount: 50000, dueDate: new Date("2026-07-01T00:00:00Z") }],
      now
    );
    expect(balances.get(p1)).toMatchObject({ net: 50000, overdueCount: 1 });
  });

  it("a GAVE with a future due date is never overdue", () => {
    const now = new Date("2026-07-18T00:00:00Z");
    const balances = computeLoanBalances(
      [{ participantId: p1, kind: "GAVE", amount: 50000, dueDate: new Date("2026-08-01T00:00:00Z") }],
      now
    );
    expect(balances.get(p1)?.overdueCount).toBe(0);
  });

  it("a past-due GAVE stops counting as overdue once fully repaid (net back to zero)", () => {
    const now = new Date("2026-07-18T00:00:00Z");
    const balances = computeLoanBalances(
      [
        { participantId: p1, kind: "GAVE", amount: 50000, dueDate: new Date("2026-07-01T00:00:00Z") },
        { participantId: p1, kind: "GOT", amount: 50000, dueDate: null },
      ],
      now
    );
    expect(balances.get(p1)).toMatchObject({ net: 0, overdueCount: 0 });
  });

  it("a GOT entry's own dueDate (always null in practice) never counts toward overdue", () => {
    const now = new Date("2026-07-18T00:00:00Z");
    const balances = computeLoanBalances([{ participantId: p1, kind: "GOT", amount: 10000, dueDate: new Date("2026-01-01T00:00:00Z") }], now);
    expect(balances.get(p1)?.overdueCount).toBe(0);
  });

  it("counts multiple independently-overdue GAVE entries for the same contact", () => {
    const now = new Date("2026-07-18T00:00:00Z");
    const balances = computeLoanBalances(
      [
        { participantId: p1, kind: "GAVE", amount: 10000, dueDate: new Date("2026-06-01T00:00:00Z") },
        { participantId: p1, kind: "GAVE", amount: 20000, dueDate: new Date("2026-06-15T00:00:00Z") },
      ],
      now
    );
    expect(balances.get(p1)).toMatchObject({ net: 30000, overdueCount: 2 });
  });

  it("tracks entry count and the most recent transaction date per contact", () => {
    const balances = computeLoanBalances([
      { participantId: p1, kind: "GAVE", amount: 10000, dueDate: null, ymd: "2026-06-01" },
      { participantId: p1, kind: "GOT", amount: 5000, dueDate: null, ymd: "2026-07-10" },
      { participantId: p1, kind: "GAVE", amount: 2000, dueDate: null, ymd: "2026-06-20" },
    ]);
    expect(balances.get(p1)?.entryCount).toBe(3);
    expect(balances.get(p1)?.lastTransactionYmd).toBe("2026-07-10");
  });

  it("lastTransactionYmd is null when no entry carries a ymd", () => {
    const balances = computeLoanBalances([{ participantId: p1, kind: "GAVE", amount: 10000, dueDate: null }]);
    expect(balances.get(p1)?.lastTransactionYmd).toBeNull();
    expect(balances.get(p1)?.entryCount).toBe(1);
  });
});

describe("contact summary math (Contact Summary Card, Phase 1.5)", () => {
  it("sums total lent/recovered and tracks the largest single loan", () => {
    const summary = computeContactSummary(
      [
        { kind: "GAVE", amount: 8000, ymd: "2026-07-01" },
        { kind: "GAVE", amount: 5000, ymd: "2026-07-05" },
        { kind: "GOT", amount: 5500, ymd: "2026-07-10" },
      ],
      7500
    );
    expect(summary.totalLent).toBe(13000);
    expect(summary.totalRecovered).toBe(5500);
    expect(summary.largestLoan).toBe(8000);
  });

  it("tracks first and last transaction dates across mixed entry order", () => {
    const summary = computeContactSummary(
      [
        { kind: "GAVE", amount: 1000, ymd: "2026-06-15" },
        { kind: "GOT", amount: 500, ymd: "2026-07-01" },
        { kind: "GAVE", amount: 2000, ymd: "2026-01-12" },
      ],
      2500
    );
    expect(summary.firstTransactionYmd).toBe("2026-01-12");
    expect(summary.lastTransactionYmd).toBe("2026-07-01");
  });

  it("counts outstanding loans (GAVE entries) only while the contact still owes something", () => {
    const entries: { kind: "GAVE" | "GOT"; amount: number; ymd: string }[] = [
      { kind: "GAVE", amount: 5000, ymd: "2026-07-01" },
      { kind: "GAVE", amount: 5000, ymd: "2026-07-05" },
    ];
    expect(computeContactSummary(entries, 10000).outstandingLoanCount).toBe(2);
    expect(computeContactSummary(entries, 0).outstandingLoanCount).toBe(0);
    expect(computeContactSummary(entries, -1000).outstandingLoanCount).toBe(0);
  });

  it("an empty entry list produces zeroed sums and null dates", () => {
    expect(computeContactSummary([], 0)).toEqual({
      outstandingLoanCount: 0,
      totalLent: 0,
      totalRecovered: 0,
      largestLoan: 0,
      averageLoan: 0,
      recoveryPercentage: 0,
      firstTransactionYmd: null,
      lastTransactionYmd: null,
    });
  });

  it("a contact with only GOT entries (pure borrowing) has zero outstanding loans and zero largest loan", () => {
    const summary = computeContactSummary([{ kind: "GOT", amount: 10000, ymd: "2026-07-01" }], -10000);
    expect(summary.outstandingLoanCount).toBe(0);
    expect(summary.largestLoan).toBe(0);
    expect(summary.totalRecovered).toBe(10000);
  });
});

describe("contact insights math (Phase 2: average loan, recovery percentage)", () => {
  it("averages total lent across the number of GAVE entries", () => {
    const summary = computeContactSummary(
      [
        { kind: "GAVE", amount: 10000, ymd: "2026-07-01" },
        { kind: "GAVE", amount: 20000, ymd: "2026-07-05" },
        { kind: "GAVE", amount: 30000, ymd: "2026-07-10" },
      ],
      60000
    );
    expect(summary.averageLoan).toBe(20000);
  });

  it("averageLoan is zero when there are no GAVE entries at all", () => {
    expect(computeContactSummary([{ kind: "GOT", amount: 5000, ymd: "2026-07-01" }], -5000).averageLoan).toBe(0);
  });

  it("recovery percentage is the share of total lent that's been recovered", () => {
    const summary = computeContactSummary(
      [
        { kind: "GAVE", amount: 10000, ymd: "2026-07-01" },
        { kind: "GOT", amount: 2500, ymd: "2026-07-05" },
      ],
      7500
    );
    expect(summary.recoveryPercentage).toBe(25);
  });

  it("recovery percentage is zero when nothing has ever been lent", () => {
    expect(computeContactSummary([], 0).recoveryPercentage).toBe(0);
  });

  it("recovery percentage can exceed 100 when recovered exceeds lent (also borrowed and repaid)", () => {
    const summary = computeContactSummary(
      [
        { kind: "GAVE", amount: 5000, ymd: "2026-07-01" },
        { kind: "GOT", amount: 5000, ymd: "2026-07-05" },
        { kind: "GOT", amount: 3000, ymd: "2026-07-10" },
      ],
      -3000
    );
    expect(summary.recoveryPercentage).toBe(160);
  });

  it("fully recovering everything lent produces exactly 100 percent", () => {
    const summary = computeContactSummary(
      [
        { kind: "GAVE", amount: 10000, ymd: "2026-07-01" },
        { kind: "GOT", amount: 10000, ymd: "2026-07-10" },
      ],
      0
    );
    expect(summary.recoveryPercentage).toBe(100);
  });
});
