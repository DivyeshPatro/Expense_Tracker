// How one line of a contact's ledger is WORDED. Presentation only — every
// number handed in here was already computed elsewhere (running balances in
// contact-ledger.tsx, allocation in loan-settlement.ts). Nothing in this file
// adds, subtracts or reorders anything.
//
// It exists as its own module so the financial libs stay untouched: lending.ts
// keeps `balanceAfterLabel`, which names the contact and is right for the loan
// detail sheet, while the ledger row needs the same fact without the name.

import { formatPaise } from "./money";

/** Sub-rupee drift is not a debt. The same ±100 paise deadband
 *  `balanceAfterLabel` uses, so the two never disagree about "settled". */
const SETTLED_WITHIN = 100;

/**
 * The running balance as of one entry, worded for a row that already sits
 * under the contact's name.
 *
 * "Balance: Roshan Prusty owes you ₹5,000" repeated down forty rows is forty
 * copies of a name the panel header already shows — it crowded out the number
 * it was meant to deliver. Same fact, same direction, no name.
 *
 * Positive means they owe you, matching the sign convention `net` and the
 * running-balance accumulator both use.
 */
export function compactBalanceLabel(balancePaise: number): { text: string; color: string } {
  if (balancePaise > SETTLED_WITHIN) return { text: `You'll get ${formatPaise(balancePaise)}`, color: "var(--green)" };
  if (balancePaise < -SETTLED_WITHIN) return { text: `You'll pay ${formatPaise(-balancePaise)}`, color: "var(--red)" };
  return { text: "Settled up", color: "var(--mut2)" };
}

/**
 * The Notes column: what this entry was for, and where the money came from or
 * went. Two separate strings because they are two separate things on screen —
 * the note is plain text, the source is a link when an account backs it.
 *
 * `note` is null when the entry carries neither a reason nor a free-text note;
 * `noteLabel` is the display string, which falls back to a neutral "No note".
 */
export function entryNotes(entry: { reason?: string | null; notes?: string | null; accountName?: string | null }): {
  note: string | null;
  noteLabel: string;
  source: string;
  linksToAccount: boolean;
} {
  // Only ever the two fields a person typed. Nothing else on a LoanEntry is
  // fit to show here — ids least of all — so the parameter type admits no
  // other field and this is the only place the column's text comes from.
  const note = entry.reason?.trim() || entry.notes?.trim() || null;
  // A row with nothing typed on it still needs to say so, or the column reads
  // as a rendering failure rather than an entry that simply has no note.
  const noteLabel = note ?? "No note";
  return entry.accountName
    ? { note, noteLabel, source: `via ${entry.accountName}`, linksToAccount: true }
    : { note, noteLabel, source: "Untracked / cash", linksToAccount: false };
}

/** Which of the two amount columns this entry belongs in, and how it reads.
 *  Never both — an entry is money out or money in, and the ledger shows the
 *  other column as an em dash so the eye can run straight down either one. */
export function amountColumns(entry: { kind: "GAVE" | "GOT"; amount: number }): { gave: string | null; got: string | null } {
  return entry.kind === "GAVE" ? { gave: formatPaise(entry.amount), got: null } : { gave: null, got: formatPaise(entry.amount) };
}
