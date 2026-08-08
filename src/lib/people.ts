// Issue #207 — one balance per person.
//
// Ledgerly tracked the same relationship in two places. Reproduced during the
// UX audit: Shared said Karan would pay ₹12,638.33; Lending said he owed
// ₹3,000; the app never once said ₹15,638.33. Both modules read the same
// Participant list, so this was never two people — it was one person with two
// half-answers, and the user was left to add them up.
//
// This module is the pure arithmetic: no Prisma, no React, so the combination
// rule is unit-testable on its own. Both sources already agree on sign —
// lending's GAVE is +amount and shared's owedToYou filters net > 0 — so
// POSITIVE MEANS THEY OWE YOU in both, and the two are safely additive.

/** Below this many paise a balance is "settled" — ignores rounding dust from splits. */
export const SETTLED_THRESHOLD = 100;

export interface PersonSource {
  id: string;
  name: string;
  initial: string;
  color: string;
  linkedUserId: string | null;
}

export interface PersonBalance extends PersonSource {
  /** Paise. Positive ⇒ they owe you. */
  lendingNet: number;
  sharedNet: number;
  /** The one number: lendingNet + sharedNet. */
  net: number;
  /** Loans of yours that are past their due date. */
  overdueCount: number;
  /** True when both sources carry a non-trivial balance — the case that used
   *  to force the user to do mental arithmetic across two screens. */
  hasBothSources: boolean;
  settled: boolean;
}

export function combineBalances(
  people: PersonSource[],
  lending: Map<string, { net: number; overdueCount: number }>,
  shared: Map<string, number>
): PersonBalance[] {
  return people.map((p) => {
    const l = lending.get(p.id);
    const lendingNet = l?.net ?? 0;
    const sharedNet = shared.get(p.id) ?? 0;
    const net = lendingNet + sharedNet;
    return {
      ...p,
      lendingNet,
      sharedNet,
      net,
      overdueCount: l?.overdueCount ?? 0,
      hasBothSources: Math.abs(lendingNet) > SETTLED_THRESHOLD && Math.abs(sharedNet) > SETTLED_THRESHOLD,
      settled: Math.abs(net) <= SETTLED_THRESHOLD,
    };
  });
}

/** Largest debts to you first, then largest you owe, settled people last. */
export function sortByOutstanding(rows: PersonBalance[]): PersonBalance[] {
  return [...rows].sort((a, b) => {
    if (a.settled !== b.settled) return a.settled ? 1 : -1;
    return b.net - a.net;
  });
}

export interface PeopleTotals {
  owedToYou: number;
  youOwe: number;
  net: number;
  toSettle: number;
  overdueCount: number;
}

export function totals(rows: PersonBalance[]): PeopleTotals {
  let owedToYou = 0;
  let youOwe = 0;
  let toSettle = 0;
  let overdueCount = 0;
  for (const r of rows) {
    if (r.net > SETTLED_THRESHOLD) owedToYou += r.net;
    else if (r.net < -SETTLED_THRESHOLD) youOwe += -r.net;
    if (!r.settled) toSettle++;
    overdueCount += r.overdueCount;
  }
  return { owedToYou, youOwe, net: owedToYou - youOwe, toSettle, overdueCount };
}
