import { describe, expect, it } from "vitest";
import { generateReminders, type LoanForReminder } from "./lending-reminders";

const now = new Date("2026-08-11T00:00:00+05:30");

const loan = (over: Partial<LoanForReminder> = {}): LoanForReminder => ({
  loanEntryId: "l1",
  participantId: "p1",
  participantName: "Rohan",
  remainingAmount: 50000,
  dueDate: null,
  cardStatementDay: null,
  cardDueDay: null,
  occurredAt: "2026-08-01",
  ...over,
});

describe("generateReminders — loan due-date family", () => {
  it("a fully-settled loan (nothing remaining) produces no reminders at all, even past its due date", () => {
    expect(generateReminders([loan({ remainingAmount: 0, dueDate: "2026-08-01" })], now)).toEqual([]);
  });

  it("a loan with no due date set produces no loan-level reminder", () => {
    expect(generateReminders([loan({ dueDate: null })], now)).toEqual([]);
  });

  it("due today", () => {
    const [r] = generateReminders([loan({ dueDate: "2026-08-11" })], now);
    expect(r).toMatchObject({ category: "due_today", daysUntilDue: 0 });
  });

  it("due tomorrow", () => {
    const [r] = generateReminders([loan({ dueDate: "2026-08-12" })], now);
    expect(r).toMatchObject({ category: "due_tomorrow", daysUntilDue: 1 });
  });

  it("due this week (2-7 days out)", () => {
    const [r] = generateReminders([loan({ dueDate: "2026-08-16" })], now);
    expect(r).toMatchObject({ category: "due_this_week", daysUntilDue: 5 });
  });

  it("due exactly 7 days out is still 'this week'", () => {
    const [r] = generateReminders([loan({ dueDate: "2026-08-18" })], now);
    expect(r.category).toBe("due_this_week");
  });

  it("due 8+ days out produces no reminder yet", () => {
    expect(generateReminders([loan({ dueDate: "2026-08-19" })], now)).toEqual([]);
  });

  it("overdue — mutually exclusive with the due-soon buckets, never both", () => {
    const results = generateReminders([loan({ dueDate: "2026-08-01" })], now);
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe("overdue");
    expect(results[0].daysUntilDue).toBeLessThan(0);
  });
});

describe("generateReminders — card billing family", () => {
  it("a loan not funded by a configured card produces no card-level reminder", () => {
    expect(generateReminders([loan({ cardStatementDay: null, cardDueDay: null })], now)).toEqual([]);
  });

  it("recover before card due date — far out (>7 days)", () => {
    // statement 25th, due 10th of next month — occurredAt 2026-08-01 belongs
    // to the cycle statementing Aug 25, due Sep 10, which is well over a week
    // away from "now" (Aug 11)
    const [r] = generateReminders([loan({ cardStatementDay: 25, cardDueDay: 10, occurredAt: "2026-08-01" })], now);
    expect(r.category).toBe("recover_before_card_due");
  });

  it("card due tomorrow", () => {
    // statement 1st, due 12th — a spend on 2026-07-15 belongs to the cycle
    // statementing Aug 1, due Aug 12, which is tomorrow relative to Aug 11
    const [r] = generateReminders([loan({ cardStatementDay: 1, cardDueDay: 12, occurredAt: "2026-07-15" })], now);
    expect(r).toMatchObject({ category: "card_due_tomorrow", daysUntilDue: 1 });
  });

  it("card due this week", () => {
    const [r] = generateReminders([loan({ cardStatementDay: 1, cardDueDay: 15, occurredAt: "2026-07-15" })], now);
    expect(r.category).toBe("card_due_this_week");
  });

  it("a card cycle whose due date has already passed still falls into recover_before_card_due, not silently dropped", () => {
    const [r] = generateReminders([loan({ cardStatementDay: 25, cardDueDay: 10, occurredAt: "2026-06-01" })], now);
    expect(r.category).toBe("recover_before_card_due");
    expect(r.daysUntilDue).toBeLessThan(0);
  });

  it("a loan with both its own due date AND card billing produces both a loan-level and a card-level reminder", () => {
    const results = generateReminders(
      [loan({ dueDate: "2026-08-12", cardStatementDay: 1, cardDueDay: 12, occurredAt: "2026-07-15" })],
      now
    );
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.category).sort()).toEqual(["card_due_tomorrow", "due_tomorrow"]);
  });
});

describe("generateReminders — ordering and multi-loan behavior", () => {
  it("sorts most urgent first (most-overdue / soonest-due)", () => {
    const results = generateReminders(
      [
        loan({ loanEntryId: "a", dueDate: "2026-08-16" }), // 5 days
        loan({ loanEntryId: "b", dueDate: "2026-08-01" }), // overdue
        loan({ loanEntryId: "c", dueDate: "2026-08-11" }), // today
      ],
      now
    );
    expect(results.map((r) => r.loanEntryId)).toEqual(["b", "c", "a"]);
  });

  it("produces independent reminders for multiple loans across different contacts", () => {
    const results = generateReminders(
      [
        loan({ loanEntryId: "a", participantId: "p1", participantName: "Rohan", dueDate: "2026-08-11" }),
        loan({ loanEntryId: "b", participantId: "p2", participantName: "Karan", dueDate: "2026-08-12" }),
      ],
      now
    );
    expect(results).toHaveLength(2);
    expect(new Set(results.map((r) => r.participantId))).toEqual(new Set(["p1", "p2"]));
  });

  it("an empty loan list produces no reminders", () => {
    expect(generateReminders([], now)).toEqual([]);
  });
});
