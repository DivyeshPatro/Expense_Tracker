// Pure lending-balance math (Phase 1): Σ GAVE − Σ GOT per contact, the same
// sign convention netBalances() already uses (positive ⇒ they owe you,
// negative ⇒ you owe them). Kept separate from the DB-orchestrating service
// (src/server/services/lending.ts) — same split as settlement.ts/shared.ts —
// so the arithmetic itself is unit-testable without a database.

import { formatPaise } from "./money";

export interface LoanEntryForBalance {
  participantId: string;
  kind: "GAVE" | "GOT";
  amount: number; // paise, always positive
  dueDate: Date | null; // meaningful for GAVE rows only
  /** optional — only needed for entryCount/lastTransactionYmd (Phase 1.5's
   * richer contact list); omit in call sites that only need net/overdue. */
  ymd?: string;
}

export interface LoanBalance {
  net: number; // paise: positive ⇒ they owe you, negative ⇒ you owe them
  overdueCount: number;
  entryCount: number;
  lastTransactionYmd: string | null;
}

/**
 * Per-participant net balance + overdue count, from a flat list of GAVE/GOT
 * entries. Phase 1 approximation (no FIFO allocation yet — that's Phase 2):
 * a GAVE row counts toward "overdue" only while the contact still owes
 * something overall, since without per-loan allocation there's no way to
 * know a specific past-due tranche was actually the one repaid.
 */
export function computeLoanBalances(entries: LoanEntryForBalance[], now: Date = new Date()): Map<string, LoanBalance> {
  const nets = new Map<string, number>();
  const pastDueGaveCount = new Map<string, number>();
  const entryCounts = new Map<string, number>();
  const lastYmds = new Map<string, string>();
  for (const e of entries) {
    const delta = e.kind === "GAVE" ? e.amount : -e.amount;
    nets.set(e.participantId, (nets.get(e.participantId) ?? 0) + delta);
    entryCounts.set(e.participantId, (entryCounts.get(e.participantId) ?? 0) + 1);
    if (e.ymd) {
      const cur = lastYmds.get(e.participantId);
      if (!cur || e.ymd > cur) lastYmds.set(e.participantId, e.ymd);
    }
    if (e.kind === "GAVE" && e.dueDate && e.dueDate < now) {
      pastDueGaveCount.set(e.participantId, (pastDueGaveCount.get(e.participantId) ?? 0) + 1);
    }
  }
  const result = new Map<string, LoanBalance>();
  for (const [participantId, net] of nets) {
    result.set(participantId, {
      net,
      overdueCount: net > 0 ? (pastDueGaveCount.get(participantId) ?? 0) : 0,
      entryCount: entryCounts.get(participantId) ?? 0,
      lastTransactionYmd: lastYmds.get(participantId) ?? null,
    });
  }
  return result;
}

export interface LoanEntryForSummary {
  kind: "GAVE" | "GOT";
  amount: number; // paise
  ymd: string; // "YYYY-MM-DD" — lexicographically sortable
}

export interface ContactSummary {
  outstandingLoanCount: number;
  totalLent: number; // paise, Σ GAVE all-time
  totalRecovered: number; // paise, Σ GOT all-time
  largestLoan: number; // paise, biggest single GAVE
  averageLoan: number; // paise, totalLent / number of GAVE entries
  recoveryPercentage: number; // 0-100+ — can exceed 100 if recovered exceeds lent (e.g. also borrowed and fully repaid)
  firstTransactionYmd: string | null;
  lastTransactionYmd: string | null;
}

/**
 * Rich per-contact summary (Contact Summary Card, Phase 1.5; Contact
 * Insights, Phase 2) — computed from a contact's own entries plus their
 * already-known net balance, so it needs no new query: the contact sheet
 * already fetches every entry for this contact via listLoanEntries().
 * "Outstanding Loans" is the same Phase 1 approximation as
 * computeLoanBalances' overdueCount (a coarser signal than the Phase 2
 * settlement engine's per-loan status — see loan-settlement.ts for that):
 * counts GAVE entries only while the contact still owes something overall.
 * averageLoan/recoveryPercentage are folded into the same single pass —
 * zero extra iteration over the entry list.
 */
export function computeContactSummary(entries: LoanEntryForSummary[], net: number): ContactSummary {
  let totalLent = 0;
  let totalRecovered = 0;
  let largestLoan = 0;
  let gaveCount = 0;
  let firstYmd: string | null = null;
  let lastYmd: string | null = null;
  for (const e of entries) {
    if (e.kind === "GAVE") {
      totalLent += e.amount;
      gaveCount++;
      if (e.amount > largestLoan) largestLoan = e.amount;
    } else {
      totalRecovered += e.amount;
    }
    if (firstYmd === null || e.ymd < firstYmd) firstYmd = e.ymd;
    if (lastYmd === null || e.ymd > lastYmd) lastYmd = e.ymd;
  }
  return {
    outstandingLoanCount: net > 0 ? gaveCount : 0,
    totalLent,
    totalRecovered,
    largestLoan,
    averageLoan: gaveCount > 0 ? Math.round(totalLent / gaveCount) : 0,
    recoveryPercentage: totalLent > 0 ? Math.round((totalRecovered / totalLent) * 100) : 0,
    firstTransactionYmd: firstYmd,
    lastTransactionYmd: lastYmd,
  };
}

/** "Rohan owes you ₹500" / "You owe Rohan ₹100" / "Settled up" — the one
 * phrasing used everywhere a running or resulting balance needs to be
 * stated in plain language (contact ledger row, Loan Detail's balance
 * visualization). Same >100/<-100 paise dust threshold as the contact
 * balance hero, so a per-entry line never disagrees with the header. */
export function balanceAfterLabel(balancePaise: number, contactName: string): { text: string; color: string } {
  if (balancePaise > 100) return { text: `${contactName} owes you ${formatPaise(balancePaise)}`, color: "var(--green)" };
  if (balancePaise < -100) return { text: `You owe ${contactName} ${formatPaise(-balancePaise)}`, color: "var(--red)" };
  return { text: "Settled up", color: "var(--mut2)" };
}
