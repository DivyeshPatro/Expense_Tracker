// Who paid whom, for a settlement stored either way.
//
// A settlement used to be owner ↔ member, so the storage said so: one
// `participantId` and a `direction` that pointed at or away from the owner.
// minimizeSettlements has always been able to produce member → member edges —
// the plan for a group where nobody owes the owner directly needs them — and
// the ledger simply could not record those, so such a group could never be
// driven to zero.
//
// New rows carry both parties explicitly. Old rows are not rewritten: their
// direction says everything needed, and deriving it here costs nothing while
// a data migration over history costs trust. Every consumer reads through this
// function so neither representation leaks into balance arithmetic.

/** Null means the owner — the same convention ExpenseSplit uses for their share. */
export interface SettlementParties {
  from: string | null;
  to: string | null;
}

export interface SettlementRow {
  participantId?: string | null;
  direction?: "TO_OWNER" | "FROM_OWNER" | null;
  fromParticipantId?: string | null;
  toParticipantId?: string | null;
}

/**
 * The two ends of a settlement, whichever way it was stored.
 *
 * Explicit columns win when present. Otherwise the legacy pair is read:
 * TO_OWNER means the member paid the owner, FROM_OWNER the reverse.
 *
 * A row with neither — which the writer never produces — resolves to owner →
 * owner, an edge that moves nothing. That is deliberate: a malformed row
 * should be inert in the arithmetic rather than throwing inside a balance
 * calculation that a dashboard render depends on.
 */
export function settlementParties(s: SettlementRow): SettlementParties {
  if (s.fromParticipantId != null || s.toParticipantId != null) {
    return { from: s.fromParticipantId ?? null, to: s.toParticipantId ?? null };
  }
  if (s.direction === "TO_OWNER") return { from: s.participantId ?? null, to: null };
  if (s.direction === "FROM_OWNER") return { from: null, to: s.participantId ?? null };
  return { from: null, to: null };
}

/** True when the owner is one of the two parties — the only case in which a
 *  settlement moves money through one of the owner's own accounts. */
export function involvesOwner(s: SettlementRow): boolean {
  const { from, to } = settlementParties(s);
  return from === null || to === null;
}

/**
 * How a settlement moves one person's balance, in the owner-centric sign the
 * group dashboard uses: positive means "owes the owner".
 *
 * Paying reduces what you owe; being paid reduces what you are owed. The owner
 * is excluded here because their own net is accumulated separately — see
 * ownerDelta.
 */
export function participantDelta(s: SettlementRow, participantId: string, amount: number): number {
  const { from, to } = settlementParties(s);
  let delta = 0;
  if (from === participantId) delta -= amount;
  if (to === participantId) delta += amount;
  return delta;
}

/**
 * How a settlement moves the OWNER's own net, which is kept in the opposite
 * sign (positive means the owner is owed).
 *
 * Zero when the owner is not a party — a payment between two members changes
 * what they owe each other and nothing about the owner's position.
 */
export function ownerDelta(s: SettlementRow, amount: number): number {
  const { from, to } = settlementParties(s);
  let delta = 0;
  if (from === null) delta += amount; // the owner paid, so is owed more
  if (to === null) delta -= amount; // the owner was paid, so is owed less
  return delta;
}
