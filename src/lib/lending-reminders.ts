// Reminder Data Engine (Lending Phase 2, Priority 6) — pure function that
// turns still-outstanding loans into structured reminder candidates. No
// notifications yet, by design (per spec): this is data a future
// notification system can consume, not a delivery mechanism itself.

import { cardCycleForDate } from "./card-billing";
import { daysBetweenYMD, todayYMD } from "./dates";

export type ReminderCategory =
  | "due_today"
  | "due_tomorrow"
  | "due_this_week"
  | "overdue"
  | "recover_before_card_due"
  | "card_due_tomorrow"
  | "card_due_this_week";

export interface LoanForReminder {
  loanEntryId: string;
  participantId: string;
  participantName: string;
  remainingAmount: number; // paise — loans with nothing outstanding produce no reminders
  dueDate: string | null; // the loan's own due date, YYYY-MM-DD
  cardStatementDay: number | null; // set only when funded by a card with billing details configured
  cardDueDay: number | null;
  occurredAt: string; // YYYY-MM-DD — which billing cycle a card-funded loan belongs to
}

export interface ReminderCandidate {
  id: string; // stable dedupe key
  category: ReminderCategory;
  loanEntryId: string;
  participantId: string;
  participantName: string;
  amount: number; // paise, the loan's remaining balance
  dueDate: string; // the date this reminder is about (loan due date or card cycle due date)
  daysUntilDue: number; // negative ⇒ already past
}

/**
 * Two independent reminder families per loan, since they track two
 * different deadlines: the loan's own due date (set by the user, Due
 * Today/Tomorrow/This Week/Overdue) and — separately, only for card-funded
 * loans with billing details configured — the card's own billing due date
 * (Recover Before Card Due Date / Card Due Tomorrow / Card Due This Week).
 * Both can fire for the same loan; within each family the buckets are
 * mutually exclusive (a loan is never "due today" and "overdue" at once).
 */
export function generateReminders(loans: LoanForReminder[], now: Date = new Date()): ReminderCandidate[] {
  const today = todayYMD(now);
  const result: ReminderCandidate[] = [];

  for (const loan of loans) {
    if (loan.remainingAmount <= 0) continue;

    if (loan.dueDate) {
      const days = daysBetweenYMD(today, loan.dueDate);
      let category: ReminderCategory | null = null;
      if (days < 0) category = "overdue";
      else if (days === 0) category = "due_today";
      else if (days === 1) category = "due_tomorrow";
      else if (days <= 7) category = "due_this_week";
      if (category) {
        result.push({
          id: `loan-${category}:${loan.loanEntryId}`,
          category,
          loanEntryId: loan.loanEntryId,
          participantId: loan.participantId,
          participantName: loan.participantName,
          amount: loan.remainingAmount,
          dueDate: loan.dueDate,
          daysUntilDue: days,
        });
      }
    }

    if (loan.cardStatementDay != null && loan.cardDueDay != null) {
      const cycle = cardCycleForDate(loan.occurredAt, loan.cardStatementDay, loan.cardDueDay);
      const days = daysBetweenYMD(today, cycle.dueDate);
      const category: ReminderCategory = days === 1 ? "card_due_tomorrow" : days >= 0 && days <= 7 ? "card_due_this_week" : "recover_before_card_due";
      result.push({
        id: `card-${category}:${loan.loanEntryId}`,
        category,
        loanEntryId: loan.loanEntryId,
        participantId: loan.participantId,
        participantName: loan.participantName,
        amount: loan.remainingAmount,
        dueDate: cycle.dueDate,
        daysUntilDue: days,
      });
    }
  }

  return result.sort((a, b) => a.daysUntilDue - b.daysUntilDue);
}
