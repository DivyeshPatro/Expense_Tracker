// Lending reporting (Phase 2, Priorities 4 & 7) — pure aggregation functions
// over a flat list of loan/allocation rows fetched once, same "load once,
// aggregate in memory" architecture as src/server/services/ledger.ts's
// monthAgg/categoryTotals/merchantTotals. No new charting library — the UI
// layer reuses Ledgerly's existing hand-rolled SVG/CSS chart patterns.

import { cardCycleForDate } from "./card-billing";
import { daysBetweenYMD, todayYMD } from "./dates";

export interface CardLoanForRecovery {
  accountId: string;
  loanEntryId: string;
  participantId: string;
  participantName: string;
  amount: number; // paise, original
  remainingAmount: number; // paise, still outstanding
  occurredAt: string; // YYYY-MM-DD
}

export interface CardAccountInfo {
  id: string;
  name: string;
  icon: string;
  cardNetwork: string | null;
  cardLast4: string | null;
  statementDay: number;
  dueDay: number;
}

export interface CardRecoverySummary {
  accountId: string;
  accountName: string;
  icon: string;
  cardNetwork: string | null;
  cardLast4: string | null;
  cycleStart: string;
  statementDate: string;
  dueDate: string;
  daysUntilDue: number;
  lentThisCycle: number;
  recoveredThisCycle: number;
  outstandingThisCycle: number;
  pastDue: number;
  affectedLoans: CardLoanForRecovery[];
}

/**
 * Per-card recovery summary — Priority 4. A loan belongs to "this cycle"
 * when its own spend date's billing cycle has the same statement date as
 * today's; anything older with a remaining balance and an already-passed
 * due date counts toward pastDue instead. Cards with no card-funded
 * activity at all (nothing lent this cycle, nothing past due) are omitted
 * — nothing to recover, nothing to show.
 */
export function computeCardRecovery(accounts: CardAccountInfo[], loans: CardLoanForRecovery[], now: Date = new Date()): CardRecoverySummary[] {
  const today = todayYMD(now);
  const result: CardRecoverySummary[] = [];

  for (const account of accounts) {
    const accountLoans = loans.filter((l) => l.accountId === account.id);
    if (accountLoans.length === 0) continue;

    const currentCycle = cardCycleForDate(today, account.statementDay, account.dueDay);
    let lentThisCycle = 0;
    let recoveredThisCycle = 0;
    let outstandingThisCycle = 0;
    let pastDue = 0;
    const affected: CardLoanForRecovery[] = [];

    for (const loan of accountLoans) {
      const cycle = cardCycleForDate(loan.occurredAt, account.statementDay, account.dueDay);
      if (cycle.statementDate === currentCycle.statementDate) {
        lentThisCycle += loan.amount;
        recoveredThisCycle += loan.amount - loan.remainingAmount;
        outstandingThisCycle += loan.remainingAmount;
        if (loan.remainingAmount > 0) affected.push(loan);
      } else if (loan.remainingAmount > 0 && cycle.dueDate < today) {
        pastDue += loan.remainingAmount;
        affected.push(loan);
      }
    }

    if (lentThisCycle === 0 && pastDue === 0) continue;

    result.push({
      accountId: account.id,
      accountName: account.name,
      icon: account.icon,
      cardNetwork: account.cardNetwork,
      cardLast4: account.cardLast4,
      cycleStart: currentCycle.cycleStart,
      statementDate: currentCycle.statementDate,
      dueDate: currentCycle.dueDate,
      daysUntilDue: daysBetweenYMD(today, currentCycle.dueDate),
      lentThisCycle,
      recoveredThisCycle,
      outstandingThisCycle,
      pastDue,
      affectedLoans: affected,
    });
  }

  // urgency: any past-due amount first (worst first), then soonest due date
  return result.sort((a, b) => {
    if (a.pastDue > 0 !== b.pastDue > 0) return a.pastDue > 0 ? -1 : 1;
    if (a.pastDue > 0 && b.pastDue > 0) return b.pastDue - a.pastDue;
    return a.daysUntilDue - b.daysUntilDue;
  });
}

// ─────────────────────── Priority 7 — Lending Reports ───────────────────────

export interface LoanEntryForTrend {
  kind: "GAVE" | "GOT";
  amount: number; // paise
  ymd: string; // YYYY-MM-DD
}

function sumInMonth(entries: LoanEntryForTrend[], kind: "GAVE" | "GOT", monthKey: string): number {
  let sum = 0;
  for (const e of entries) if (e.kind === kind && e.ymd.startsWith(monthKey)) sum += e.amount;
  return sum;
}

export function monthlyLending(entries: LoanEntryForTrend[], monthKeys: string[]): number[] {
  return monthKeys.map((k) => sumInMonth(entries, "GAVE", k));
}

export function monthlyRecoveries(entries: LoanEntryForTrend[], monthKeys: string[]): number[] {
  return monthKeys.map((k) => sumInMonth(entries, "GOT", k));
}

/** Cumulative net (Σ GAVE − Σ GOT) as of the end of each month key — a
 * single sorted pass shared across every month, not a rescan per month
 * (the spec explicitly calls out avoiding repeated balance scans).
 * `monthKeys` must already be in ascending chronological order. */
export function outstandingTrend(entries: LoanEntryForTrend[], monthKeys: string[]): number[] {
  const sorted = [...entries].sort((a, b) => a.ymd.localeCompare(b.ymd));
  const result: number[] = [];
  let cursor = 0;
  let running = 0;
  for (const key of monthKeys) {
    const cutoff = `${key}-32`; // sorts after every real day in that month
    while (cursor < sorted.length && sorted[cursor].ymd < cutoff) {
      running += sorted[cursor].kind === "GAVE" ? sorted[cursor].amount : -sorted[cursor].amount;
      cursor++;
    }
    result.push(running);
  }
  return result;
}

/** All-time recovery rate: what share of everything ever lent has come back. */
export function recoveryRate(entries: LoanEntryForTrend[]): number {
  let lent = 0;
  let recovered = 0;
  for (const e of entries) {
    if (e.kind === "GAVE") lent += e.amount;
    else recovered += e.amount;
  }
  return lent > 0 ? Math.round((recovered / lent) * 100) : 0;
}

export interface ContactNetForReports {
  participantId: string;
  net: number; // paise, positive ⇒ they owe you
}

export function receivableVsPayable(contacts: ContactNetForReports[]): { receivable: number; payable: number } {
  let receivable = 0;
  let payable = 0;
  for (const c of contacts) {
    if (c.net > 0) receivable += c.net;
    else payable += -c.net;
  }
  return { receivable, payable };
}

export interface CardExposureRow {
  accountId: string;
  accountName: string;
  icon: string;
  outstanding: number;
}

/** Total money currently tied up per card, regardless of billing cycle —
 * distinct from Card Recovery's cycle-scoped view (Priority 4), this is a
 * plain snapshot of exposure. Cards with nothing outstanding are omitted. */
export function cardExposure(
  accounts: { id: string; name: string; icon: string }[],
  loans: { accountId: string; remainingAmount: number }[]
): CardExposureRow[] {
  const byAccount = new Map<string, number>();
  for (const l of loans) byAccount.set(l.accountId, (byAccount.get(l.accountId) ?? 0) + l.remainingAmount);
  return accounts
    .map((a) => ({ accountId: a.id, accountName: a.name, icon: a.icon, outstanding: byAccount.get(a.id) ?? 0 }))
    .filter((r) => r.outstanding > 0)
    .sort((a, b) => b.outstanding - a.outstanding);
}

export interface OverdueLoanRow {
  loanEntryId: string;
  participantId: string;
  participantName: string;
  remainingAmount: number;
  dueDate: string;
  daysOverdue: number;
}

export function overdueLoans(
  loans: { loanEntryId: string; participantId: string; participantName: string; remainingAmount: number; dueDate: string }[],
  now: Date = new Date()
): OverdueLoanRow[] {
  const today = todayYMD(now);
  return loans
    .filter((l) => l.remainingAmount > 0 && l.dueDate < today)
    .map((l) => ({
      loanEntryId: l.loanEntryId,
      participantId: l.participantId,
      participantName: l.participantName,
      remainingAmount: l.remainingAmount,
      dueDate: l.dueDate,
      daysOverdue: -daysBetweenYMD(today, l.dueDate),
    }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
}

export interface TopBorrowerRow {
  participantId: string;
  participantName: string;
  outstanding: number;
}

export interface ContactForTopBorrowers {
  participantId: string;
  participantName: string;
  net: number; // paise, positive ⇒ they owe you
}

/** Ranked by what's currently outstanding right now (not lifetime lent) —
 * the actionable framing: who owes the most today. */
export function topBorrowers(contacts: ContactForTopBorrowers[], limit = 5): TopBorrowerRow[] {
  return contacts
    .filter((c) => c.net > 0)
    .map((c) => ({ participantId: c.participantId, participantName: c.participantName, outstanding: c.net }))
    .sort((a, b) => b.outstanding - a.outstanding)
    .slice(0, limit);
}
