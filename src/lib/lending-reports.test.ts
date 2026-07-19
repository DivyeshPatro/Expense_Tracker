import { describe, expect, it } from "vitest";
import {
  cardExposure,
  computeCardRecovery,
  monthlyLending,
  monthlyRecoveries,
  outstandingTrend,
  overdueLoans,
  receivableVsPayable,
  recoveryRate,
  topBorrowers,
  type CardAccountInfo,
  type CardLoanForRecovery,
  type LoanEntryForTrend,
} from "./lending-reports";

const card = (over: Partial<CardAccountInfo> = {}): CardAccountInfo => ({
  id: "card-1",
  name: "HDFC Card",
  icon: "💳",
  cardNetwork: "Visa",
  cardLast4: "4242",
  statementDay: 25,
  dueDay: 10,
  ...over,
});

const loan = (over: Partial<CardLoanForRecovery> = {}): CardLoanForRecovery => ({
  accountId: "card-1",
  loanEntryId: "l1",
  participantId: "p1",
  participantName: "Rohan",
  amount: 100000,
  remainingAmount: 100000,
  occurredAt: "2026-08-05",
  ...over,
});

describe("computeCardRecovery", () => {
  const now = new Date("2026-08-11T00:00:00+05:30"); // within the cycle ending 2026-08-25

  it("a card with no card-funded loans at all is omitted entirely", () => {
    expect(computeCardRecovery([card()], [], now)).toEqual([]);
  });

  it("a fully-recovered loan from a past cycle produces no pastDue and is dropped from the current summary", () => {
    const loans = [loan({ occurredAt: "2026-06-01", remainingAmount: 0 })];
    // this loan isn't in the current cycle (cutting Aug 25) and has nothing
    // outstanding, so the card has nothing to show at all
    expect(computeCardRecovery([card()], loans, now)).toEqual([]);
  });

  it("sums lent/recovered/outstanding for loans within the current cycle", () => {
    const loans = [
      loan({ loanEntryId: "l1", amount: 100000, remainingAmount: 100000, occurredAt: "2026-08-05" }),
      loan({ loanEntryId: "l2", amount: 50000, remainingAmount: 20000, occurredAt: "2026-08-08" }),
    ];
    const [summary] = computeCardRecovery([card()], loans, now);
    expect(summary.lentThisCycle).toBe(150000);
    expect(summary.recoveredThisCycle).toBe(30000);
    expect(summary.outstandingThisCycle).toBe(120000);
    expect(summary.pastDue).toBe(0);
  });

  it("a loan from a prior cycle whose due date has passed counts as pastDue, not current-cycle", () => {
    // prior cycle: statement Jun 25, due Jul 10 — long since passed by "now" (Aug 11)
    const loans = [loan({ occurredAt: "2026-06-05", amount: 40000, remainingAmount: 40000 })];
    const [summary] = computeCardRecovery([card()], loans, now);
    expect(summary.pastDue).toBe(40000);
    expect(summary.lentThisCycle).toBe(0);
  });

  it("reports the current cycle's own due date and days-until-due", () => {
    const loans = [loan({ occurredAt: "2026-08-05" })];
    const [summary] = computeCardRecovery([card()], loans, now);
    expect(summary.dueDate).toBe("2026-09-10");
    expect(summary.daysUntilDue).toBe(30);
  });

  it("affectedLoans includes only loans still outstanding, not fully-settled ones", () => {
    const loans = [
      loan({ loanEntryId: "l1", remainingAmount: 0 }),
      loan({ loanEntryId: "l2", remainingAmount: 30000 }),
    ];
    const [summary] = computeCardRecovery([card()], loans, now);
    expect(summary.affectedLoans.map((l) => l.loanEntryId)).toEqual(["l2"]);
  });

  it("keeps separate cards' totals independent", () => {
    const cards = [card({ id: "card-1" }), card({ id: "card-2", name: "ICICI Card" })];
    const loans = [loan({ accountId: "card-1", amount: 10000, remainingAmount: 10000 }), loan({ accountId: "card-2", amount: 20000, remainingAmount: 20000 })];
    const result = computeCardRecovery(cards, loans, now);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.accountId === "card-1")?.lentThisCycle).toBe(10000);
    expect(result.find((r) => r.accountId === "card-2")?.lentThisCycle).toBe(20000);
  });

  it("sorts cards with any past-due amount ahead of cards that only have current-cycle activity", () => {
    const cards = [card({ id: "card-1" }), card({ id: "card-2" })];
    const loans = [
      loan({ accountId: "card-1", occurredAt: "2026-08-05", remainingAmount: 10000 }), // current cycle only
      loan({ accountId: "card-2", occurredAt: "2026-06-05", remainingAmount: 10000 }), // past due
    ];
    const result = computeCardRecovery(cards, loans, now);
    expect(result[0].accountId).toBe("card-2");
  });

  it("among non-past-due cards, sorts by soonest due date first", () => {
    const cards = [card({ id: "card-1", statementDay: 25, dueDay: 10 }), card({ id: "card-2", statementDay: 1, dueDay: 5 })];
    const loans = [
      loan({ accountId: "card-1", occurredAt: "2026-08-05" }),
      loan({ accountId: "card-2", occurredAt: "2026-08-02" }),
    ];
    const result = computeCardRecovery(cards, loans, now);
    // card-2's cycle (statement 1st, due 5th) resolves sooner than card-1's (statement 25th, due 10th next month)
    expect(result[0].accountId).toBe("card-2");
  });
});

const entry = (over: Partial<LoanEntryForTrend> = {}): LoanEntryForTrend => ({ kind: "GAVE", amount: 10000, ymd: "2026-07-01", ...over });

describe("monthlyLending / monthlyRecoveries", () => {
  it("buckets GAVE and GOT amounts into their respective months, ignoring the other kind", () => {
    const entries = [
      entry({ kind: "GAVE", amount: 10000, ymd: "2026-06-05" }),
      entry({ kind: "GAVE", amount: 5000, ymd: "2026-06-20" }),
      entry({ kind: "GOT", amount: 3000, ymd: "2026-06-10" }),
      entry({ kind: "GAVE", amount: 2000, ymd: "2026-07-01" }),
    ];
    const months = ["2026-06", "2026-07"];
    expect(monthlyLending(entries, months)).toEqual([15000, 2000]);
    expect(monthlyRecoveries(entries, months)).toEqual([3000, 0]);
  });

  it("a month with no activity produces zero, not an error", () => {
    expect(monthlyLending([], ["2026-06"])).toEqual([0]);
  });
});

describe("outstandingTrend", () => {
  it("accumulates cumulative net (GAVE minus GOT) up to the end of each month", () => {
    const entries = [
      entry({ kind: "GAVE", amount: 10000, ymd: "2026-06-05" }),
      entry({ kind: "GOT", amount: 4000, ymd: "2026-06-20" }),
      entry({ kind: "GAVE", amount: 5000, ymd: "2026-07-10" }),
    ];
    expect(outstandingTrend(entries, ["2026-06", "2026-07", "2026-08"])).toEqual([6000, 11000, 11000]);
  });

  it("an empty entry list produces a flat zero trend", () => {
    expect(outstandingTrend([], ["2026-06", "2026-07"])).toEqual([0, 0]);
  });

  it("entries out of chronological order are still accumulated correctly", () => {
    const entries = [
      entry({ kind: "GAVE", amount: 5000, ymd: "2026-07-10" }),
      entry({ kind: "GAVE", amount: 10000, ymd: "2026-06-05" }),
    ];
    expect(outstandingTrend(entries, ["2026-06", "2026-07"])).toEqual([10000, 15000]);
  });

  it("carryIn seeds the running total, letting the caller pass only entries inside the window", () => {
    const entries = [entry({ kind: "GAVE", amount: 5000, ymd: "2026-06-05" })];
    // equivalent to passing the pre-window entries too and starting from 0
    expect(outstandingTrend(entries, ["2026-06", "2026-07"], 7000)).toEqual([12000, 12000]);
  });

  it("carryIn defaults to 0, matching the old whole-ledger-in-entries behavior", () => {
    const entries = [entry({ kind: "GAVE", amount: 5000, ymd: "2026-06-05" })];
    expect(outstandingTrend(entries, ["2026-06", "2026-07"])).toEqual([5000, 5000]);
  });
});

describe("recoveryRate", () => {
  it("computes the all-time percentage of lent money that's been recovered", () => {
    const entries = [entry({ kind: "GAVE", amount: 10000 }), entry({ kind: "GOT", amount: 4000 })];
    expect(recoveryRate(entries)).toBe(40);
  });

  it("is zero when nothing has ever been lent", () => {
    expect(recoveryRate([])).toBe(0);
  });
});

describe("receivableVsPayable", () => {
  it("splits positive nets into receivable and negative nets into payable", () => {
    const result = receivableVsPayable([
      { participantId: "p1", net: 5000 },
      { participantId: "p2", net: -2000 },
      { participantId: "p3", net: 3000 },
    ]);
    expect(result).toEqual({ receivable: 8000, payable: 2000 });
  });

  it("an empty contact list produces zero on both sides", () => {
    expect(receivableVsPayable([])).toEqual({ receivable: 0, payable: 0 });
  });
});

describe("cardExposure", () => {
  it("sums outstanding remaining balances per card, sorted descending", () => {
    const accounts = [
      { id: "c1", name: "HDFC", icon: "💳" },
      { id: "c2", name: "ICICI", icon: "💳" },
    ];
    const loans = [
      { accountId: "c1", remainingAmount: 10000 },
      { accountId: "c1", remainingAmount: 5000 },
      { accountId: "c2", remainingAmount: 30000 },
    ];
    expect(cardExposure(accounts, loans)).toEqual([
      { accountId: "c2", accountName: "ICICI", icon: "💳", outstanding: 30000 },
      { accountId: "c1", accountName: "HDFC", icon: "💳", outstanding: 15000 },
    ]);
  });

  it("a card with nothing outstanding is omitted", () => {
    const accounts = [{ id: "c1", name: "HDFC", icon: "💳" }];
    expect(cardExposure(accounts, [{ accountId: "c1", remainingAmount: 0 }])).toEqual([]);
  });
});

describe("overdueLoans", () => {
  const now = new Date("2026-08-11T00:00:00+05:30");

  it("includes only loans with a remaining balance and a due date already passed", () => {
    const loans = [
      { loanEntryId: "l1", participantId: "p1", participantName: "Rohan", remainingAmount: 5000, dueDate: "2026-08-01" },
      { loanEntryId: "l2", participantId: "p2", participantName: "Karan", remainingAmount: 0, dueDate: "2026-07-01" }, // settled
      { loanEntryId: "l3", participantId: "p3", participantName: "Priya", remainingAmount: 5000, dueDate: "2026-08-20" }, // not due yet
    ];
    const result = overdueLoans(loans, now);
    expect(result.map((r) => r.loanEntryId)).toEqual(["l1"]);
  });

  it("sorts most-overdue first", () => {
    const loans = [
      { loanEntryId: "recent", participantId: "p1", participantName: "Rohan", remainingAmount: 1000, dueDate: "2026-08-05" },
      { loanEntryId: "oldest", participantId: "p2", participantName: "Karan", remainingAmount: 1000, dueDate: "2026-06-01" },
    ];
    const result = overdueLoans(loans, now);
    expect(result[0].loanEntryId).toBe("oldest");
    expect(result[0].daysOverdue).toBeGreaterThan(result[1].daysOverdue);
  });
});

describe("topBorrowers", () => {
  it("ranks contacts with a positive outstanding balance, descending", () => {
    const contacts = [
      { participantId: "p1", participantName: "Rohan", net: 5000 },
      { participantId: "p2", participantName: "Karan", net: 20000 },
      { participantId: "p3", participantName: "Priya", net: -3000 },
    ];
    expect(topBorrowers(contacts).map((r) => r.participantId)).toEqual(["p2", "p1"]);
  });

  it("respects the limit parameter", () => {
    const contacts = Array.from({ length: 10 }, (_, i) => ({ participantId: `p${i}`, participantName: `P${i}`, net: (i + 1) * 1000 }));
    expect(topBorrowers(contacts, 3)).toHaveLength(3);
  });

  it("contacts who are owed nothing or who owe money are excluded entirely", () => {
    expect(topBorrowers([{ participantId: "p1", participantName: "Rohan", net: 0 }, { participantId: "p2", participantName: "Karan", net: -500 }])).toEqual([]);
  });
});
