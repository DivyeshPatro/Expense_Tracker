// Presentation layer for the group settlement plan.
//
// There is deliberately NO settlement mathematics in this file. The plan comes
// from computeSuggestions() → minimizeSettlements(), which already works purely
// from (id, net) pairs and is therefore identical no matter who is looking at
// it. What was missing was never the maths, it was the framing:
//
//   • the owner was rendered as the literal string "You", which is meaningless
//     the moment the text leaves the owner's phone and lands in a group chat;
//   • the plan was buried behind a toggle inside an owner-centric tab, so the
//     screen never plainly answered "who pays whom".
//
// So this module does three small, pure things: resolve the owner placeholder
// to a real name, phrase the payment count, and render the whole thing as
// plain text someone can paste into WhatsApp.

import { formatPaise } from "./money";

/** The id computeSuggestions() uses for the owner (it has no participant row). */
export const OWNER_ID = "me";

export interface PlanRow {
  key: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  amount: number; // paise
}

/** The shape this module needs from a settlement suggestion. */
interface SuggestionLike {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  amount: number;
}

/**
 * The plan with the owner's placeholder replaced by their real name.
 *
 * The arrow always means "left pays right", and both sides are real people —
 * a payment between two other members stays between those two members and is
 * never re-routed through the viewer.
 */
export function namedPlan(suggestions: SuggestionLike[], ownerName: string): PlanRow[] {
  const name = (id: string, fallback: string) => (id === OWNER_ID ? ownerName : fallback);
  return suggestions.map((s, i) => ({
    // Index-keyed: two members can legitimately owe the same person the same
    // amount, so from/to/amount is not unique on its own.
    key: `${s.fromId}-${s.toId}-${s.amount}-${i}`,
    fromId: s.fromId,
    fromName: name(s.fromId, s.fromName),
    toId: s.toId,
    toName: name(s.toId, s.toName),
    amount: s.amount,
  }));
}

/**
 * How the plan describes itself. Reads as an answer, not a status code —
 * "these are already the fewest payments" rather than "cannot be simplified
 * further", which sounds like the app tried something and failed.
 */
export function settlementHeadline(paymentCount: number): string {
  if (paymentCount <= 0) return "All settled up";
  if (paymentCount === 1) return "1 payment to settle everything";
  return `${paymentCount} payments to settle everything`;
}

export function planTotal(rows: { amount: number }[]): number {
  return rows.reduce((sum, r) => sum + r.amount, 0);
}

/**
 * WhatsApp-ready plain text for exactly the rows on screen.
 *
 * No ids, no jargon, no app chrome — this gets read by people who do not use
 * Ledgerly, in a chat window, on a phone.
 */
export function shareSettlementText(input: {
  groupName: string;
  headline: string;
  rows: PlanRow[];
  total: number;
}): string {
  const { groupName, headline, rows, total } = input;
  const lines = [`🧾 ${groupName} — Settlement`, ""];
  if (rows.length === 0) {
    lines.push("All settled up — nobody owes anything.");
    return lines.join("\n");
  }
  lines.push(`${headline}:`, "");
  for (const r of rows) lines.push(`${r.fromName} → ${r.toName}: ${formatPaise(r.amount)}`);
  lines.push("", `Total: ${formatPaise(total)}`);
  return lines.join("\n");
}
