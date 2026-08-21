// How a split's per-person amounts are derived — the ONE implementation.
//
// This function used to live in server/services/transactions.ts, where only
// the writer could reach it. The expense form therefore carried its own
// restatement of the same arithmetic, and the two did not agree: the form's
// EQUAL branch was `floor(total / n)` labelled "₹X each", which models no
// remainder at all, so it could not show that the payer actually absorbs the
// last few paise. Its weighted branch computed only the owner's share, so a
// participant weighted 2 had no rupee figure anywhere on screen. A ₹2,530
// dinner split 1:2:1:1:1 saved ₹843.33 against somebody while the form said
// nothing about it.
//
// Moved here verbatim so the preview and the ExpenseSplit rows come from the
// same call. This module is client-safe on purpose: it imports only money.ts,
// never Prisma or the auth layer, so a React component can call it without
// dragging the server graph into the bundle.
//
// The arithmetic itself is untouched and lives in money.ts — splitEqual,
// splitByWeights and splitExact own the floor-and-remainder-to-the-payer
// policy, and this only routes to them.

import { splitByWeights, splitEqual, splitExact, type SplitShare } from "./money";

export interface SplitInput {
  mode: "EQUAL" | "EXACT" | "PERCENT" | "RATIO";
  participantIds: string[]; // friends included in the split (owner is always included)
  payerParticipantId: string | null; // null ⇒ paid by owner
  exactAmounts?: Record<string, number>; // participantId → paise (EXACT mode, friends only)
  weights?: Record<string, number>; // participantId → weight, plus "me" for the owner (PERCENT/RATIO)
}

export function computeShares(amount: number, split: SplitInput): SplitShare[] {
  const ids: (string | null)[] = [null, ...split.participantIds];
  if (split.mode === "EXACT") {
    const others = split.participantIds.map((id) => ({ participantId: id as string | null, owedAmount: split.exactAmounts?.[id] ?? 0 }));
    // payer absorbs remainder; when a friend paid, the owner's share is stated too
    if (split.payerParticipantId === null) return splitExact(amount, others, null);
    const withoutPayer = others.filter((o) => o.participantId !== split.payerParticipantId);
    return splitExact(amount, withoutPayer, split.payerParticipantId);
  }
  if (split.mode === "PERCENT" || split.mode === "RATIO") {
    const parts = [
      { participantId: null as string | null, weight: split.weights?.["me"] ?? 0 },
      ...split.participantIds.map((id) => ({ participantId: id as string | null, weight: split.weights?.[id] ?? 0 })),
    ];
    return splitByWeights(amount, parts, split.payerParticipantId);
  }
  return splitEqual(amount, ids, split.payerParticipantId);
}

/** One row of the split breakdown, ready to render. */
export interface SplitPreviewRow {
  participantId: string | null; // null ⇒ the owner ("You")
  /** How this person's share was arrived at: "Equal", "2 parts", "40%", "Exact". */
  method: string;
  owedAmount: number; // paise
  isPayer: boolean;
}

export interface SplitPreview {
  rows: SplitPreviewRow[];
  total: number; // paise — the sum of the rows, not the expense amount
  /** Paise the floor division could not distribute, handed to the payer. */
  remainder: number;
  /** Whether `total` matches the expense amount. False ⇒ the split is unsaveable. */
  balances: boolean;
  /** Set when the shares could not be computed at all (e.g. exact amounts over the total). */
  error: string | null;
}

/**
 * The split breakdown the expense form shows before saving.
 *
 * Presentation only: every rupee figure comes from computeShares above, the
 * same call the writer makes, so the preview cannot drift from what is stored.
 * The method labels are derived from the same inputs the engine consumed.
 *
 * `remainder` is reported rather than recomputed — it is the difference
 * between the payer's share and the plain floor, which is exactly what
 * splitEqual/splitByWeights added to them.
 */
export function computeSplitPreview(amount: number, split: SplitInput): SplitPreview {
  const empty: SplitPreview = { rows: [], total: 0, remainder: 0, balances: false, error: null };
  if (!Number.isInteger(amount) || amount <= 0) return { ...empty, error: "Enter an amount first." };

  let shares: SplitShare[];
  try {
    shares = computeShares(amount, split);
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : "This split can't be calculated." };
  }

  const n = shares.length;
  const weightSum = split.participantIds.reduce((s, id) => s + (split.weights?.[id] ?? 0), 0) + (split.weights?.["me"] ?? 0);

  const label = (participantId: string | null): string => {
    if (split.mode === "EQUAL") return "Equal";
    if (split.mode === "EXACT") return "Exact";
    const w = split.weights?.[participantId === null ? "me" : participantId] ?? 0;
    if (split.mode === "PERCENT") return `${w}%`;
    return `${w} ${w === 1 ? "part" : "parts"}`;
  };

  const rows: SplitPreviewRow[] = shares.map((s) => ({
    participantId: s.participantId,
    method: label(s.participantId),
    owedAmount: s.owedAmount,
    isPayer: s.participantId === split.payerParticipantId,
  }));

  // What the payer absorbed beyond an even division. EXACT has no remainder
  // concept — the payer's share IS the balance — so it reports none.
  let remainder = 0;
  if (split.mode === "EQUAL") {
    remainder = amount - Math.floor(amount / n) * n;
  } else if ((split.mode === "PERCENT" || split.mode === "RATIO") && weightSum > 0) {
    const floors = shares.map((s) => {
      const w = split.weights?.[s.participantId === null ? "me" : s.participantId] ?? 0;
      return Math.floor((amount * w) / weightSum);
    });
    remainder = amount - floors.reduce((a, b) => a + b, 0);
  }

  const total = rows.reduce((s, r) => s + r.owedAmount, 0);
  return { rows, total, remainder, balances: total === amount, error: null };
}
