// The lending statement as plain text — what gets shared to WhatsApp.
//
// Pure and presentation-only. Every figure here is handed in by a caller that
// read it from the financial model (contactStatement / the ledger's own running
// balance); nothing is recomputed, so this can never disagree with the screen.
//
// Sign convention is Ledgerly's, not Khatabook's: a POSITIVE balance means the
// contact owes you, matching the NET card and every other surface in the app.
// The reference design shows the same balance as negative, which would read as
// the opposite of what the dashboard says two taps away — so the amounts are
// worded instead of signed, and nobody has to guess.

import { entryDate, recordedAtTime } from "./dates";
import { formatPaise } from "./money";

export interface StatementTextEntry {
  ymd: string; // "YYYY-MM-DD" — the date the money moved
  createdAt: string; // ISO instant — when the row was RECORDED (see recordedAtTime)
  kind: "GAVE" | "GOT";
  amount: number; // paise
  balanceAfterPaise: number; // positive ⇒ they owe you
}

export interface StatementTextInput {
  contactName: string;
  periodLabel: string;
  entries: StatementTextEntry[]; // newest first
  totalGavePaise: number;
  totalGotPaise: number;
  closingBalancePaise: number;
  /** Beyond this many rows the message is trimmed — a WhatsApp message with a
   *  thousand lines is unusable, and the PDF is the complete record. */
  maxRows?: number;
}

const DEFAULT_MAX_ROWS = 40;

/** "₹7,700 owed to you" / "you owe ₹800" / "settled up" — never a bare sign. */
export function balanceWording(paise: number, contactName: string): string {
  if (paise > 0) return `${formatPaise(paise)} owed to you`;
  if (paise < 0) return `you owe ${formatPaise(Math.abs(paise))}`;
  return `settled up with ${contactName}`;
}

export function lendingStatementText(input: StatementTextInput): string {
  const { contactName, periodLabel, entries, totalGavePaise, totalGotPaise, closingBalancePaise } = input;
  const max = input.maxRows ?? DEFAULT_MAX_ROWS;
  const out: string[] = [
    "Ledgerly — Lending Statement",
    "",
    `Person: ${contactName}`,
    `Period: ${periodLabel}`,
    "",
    "Current balance:",
    balanceWording(closingBalancePaise, contactName),
    "",
  ];

  if (entries.length === 0) {
    out.push("No transactions yet.");
    return out.join("\n");
  }

  out.push("Transactions:", "");
  for (const e of entries.slice(0, max)) {
    out.push(
      // "added" is deliberate: occurredAt carries no time of day, so this is
      // when the entry was recorded, not when the money changed hands.
      `${entryDate(e.ymd)} · added ${recordedAtTime(e.createdAt)}`,
      `${e.kind === "GAVE" ? "You Gave" : "You Got"} ${formatPaise(e.amount)}`,
      `Balance: ${balanceWording(e.balanceAfterPaise, contactName)}`,
      ""
    );
  }
  if (entries.length > max) {
    out.push(`…and ${entries.length - max} earlier ${entries.length - max === 1 ? "entry" : "entries"}. Export the PDF for the full statement.`, "");
  }

  out.push(
    "Summary:",
    `You gave: ${formatPaise(totalGavePaise)}`,
    `You got: ${formatPaise(totalGotPaise)}`,
    `Net: ${balanceWording(closingBalancePaise, contactName)}`
  );
  return out.join("\n");
}
