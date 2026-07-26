// All money in Ledgerly is integer paise (₹1 = 100 paise). Never floats.
// Formatting happens at the edge only, via Intl.NumberFormat('en-IN').

export type Paise = number;

/** Parse user input (rupees, e.g. "1234.56") into integer paise. */
export function toPaise(rupees: string | number): Paise {
  const n = typeof rupees === "string" ? Number(rupees.replace(/[₹,\s]/g, "")) : rupees;
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${rupees}`);
  return Math.round(n * 100);
}

const intFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const decFmt = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "₹1,23,456" for whole rupees, "₹1,23,456.78" otherwise. Sign is dropped (callers add − / +). */
export function formatPaise(paise: Paise | bigint): string {
  const p = Math.abs(Number(paise));
  const rupees = p / 100;
  return "₹" + (p % 100 === 0 ? intFmt.format(rupees) : decFmt.format(rupees));
}

export interface SplitShare {
  participantId: string | null; // null = the owner
  owedAmount: Paise;
}

/**
 * Equal split at paise precision. Every participant gets floor(total/n);
 * the remainder paise (0..n−1) go to the payer (PRD §5 rounding rule).
 * participantIds must include the payer (payerId; null = owner).
 */
export function splitEqual(total: Paise, participantIds: (string | null)[], payerId: string | null): SplitShare[] {
  assertPositiveInt(total);
  const n = participantIds.length;
  if (n === 0) throw new Error("No participants");
  if (!participantIds.some((id) => id === payerId)) throw new Error("Payer must be a participant");
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  return participantIds.map((id) => ({
    participantId: id,
    owedAmount: base + (id === payerId ? remainder : 0),
  }));
}

/**
 * Weighted split (covers PERCENT and RATIO): shares proportional to weights,
 * floored to paise, remainder to the payer. Shares always sum to total.
 */
export function splitByWeights(
  total: Paise,
  parts: { participantId: string | null; weight: number }[],
  payerId: string | null
): SplitShare[] {
  assertPositiveInt(total);
  const weightSum = parts.reduce((s, p) => s + p.weight, 0);
  if (weightSum <= 0) throw new Error("Weights must sum to a positive number");
  if (!parts.some((p) => p.participantId === payerId)) throw new Error("Payer must be a participant");
  const shares = parts.map((p) => ({
    participantId: p.participantId,
    owedAmount: Math.floor((total * p.weight) / weightSum),
  }));
  const remainder = total - shares.reduce((s, p) => s + p.owedAmount, 0);
  const payer = shares.find((s) => s.participantId === payerId)!;
  payer.owedAmount += remainder;
  return shares;
}

/**
 * Exact split: everyone except the payer has a stated amount; the payer
 * absorbs the remainder. Throws if the stated amounts exceed the total.
 */
export function splitExact(
  total: Paise,
  others: { participantId: string | null; owedAmount: Paise }[],
  payerId: string | null
): SplitShare[] {
  assertPositiveInt(total);
  const stated = others.reduce((s, p) => s + p.owedAmount, 0);
  if (others.some((p) => p.owedAmount < 0 || !Number.isInteger(p.owedAmount)))
    throw new Error("Split amounts must be non-negative integers");
  if (stated > total) throw new Error("Split amounts exceed the total");
  return [...others.map((p) => ({ ...p })), { participantId: payerId, owedAmount: total - stated }];
}

function assertPositiveInt(total: Paise) {
  if (!Number.isInteger(total) || total <= 0) throw new Error(`Amount must be a positive integer of paise, got ${total}`);
}
