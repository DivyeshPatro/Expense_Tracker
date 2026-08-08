// Issue #207 — the single source of truth for "what is my financial
// relationship with this person?".
//
// Reads both existing balance systems and combines them. Deliberately does NOT
// reimplement either: lendingBalances and netBalances stay the authority for
// their own ledgers, and both are cache()-wrapped, so calling this alongside
// the Lending or Shared pages costs no extra queries in the same request.

import { cache } from "react";
import { combineBalances, sortByOutstanding, totals, type PersonBalance, type PeopleTotals } from "@/lib/people";
import { lendingBalances } from "./lending";
import { netBalances } from "./shared";

export type { PersonBalance, PeopleTotals };

export const peopleBalances = cache(async (userId: string): Promise<PersonBalance[]> => {
  const [lending, shared] = await Promise.all([lendingBalances(userId), netBalances(userId)]);

  // netBalances returns every participant; lendingBalances returns only those
  // with loan entries. Union them so a lending-only contact is not dropped.
  const source = new Map<string, { id: string; name: string; initial: string; color: string; linkedUserId: string | null }>();
  for (const s of shared) source.set(s.id, { id: s.id, name: s.name, initial: s.initial, color: s.color, linkedUserId: s.linkedUserId });
  for (const l of lending) {
    if (!source.has(l.id)) source.set(l.id, { id: l.id, name: l.name, initial: l.initial, color: l.color, linkedUserId: l.linkedUserId });
  }

  return sortByOutstanding(
    combineBalances(
      [...source.values()],
      new Map(lending.map((l) => [l.id, { net: l.net, overdueCount: l.overdueCount }])),
      new Map(shared.map((s) => [s.id, s.net]))
    )
  );
});

export const peopleSummary = cache(async (userId: string): Promise<{ rows: PersonBalance[]; totals: PeopleTotals }> => {
  const rows = await peopleBalances(userId);
  return { rows, totals: totals(rows) };
});

/** One person's combined position, for the detail view. */
export async function personBalance(userId: string, participantId: string): Promise<PersonBalance | null> {
  const rows = await peopleBalances(userId);
  return rows.find((r) => r.id === participantId) ?? null;
}
