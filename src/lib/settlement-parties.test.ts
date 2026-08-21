// Reading a settlement written either way.
//
// Owner-involved rows keep the original participantId + direction encoding and
// are not rewritten; member↔member rows carry both ends explicitly. Everything
// downstream reads through settlementParties, so the arithmetic never has to
// know which shape it got.

import { describe, expect, it } from "vitest";
import { involvesOwner, ownerDelta, participantDelta, settlementParties } from "./settlement-parties";

const ANA = "p-ana";
const BEN = "p-ben";

const legacyToOwner = { participantId: ANA, direction: "TO_OWNER" as const };
const legacyFromOwner = { participantId: ANA, direction: "FROM_OWNER" as const };
const memberToMember = { participantId: null, direction: null, fromParticipantId: ANA, toParticipantId: BEN };

describe("settlementParties", () => {
  it("reads a legacy row where the member paid the owner", () => {
    expect(settlementParties(legacyToOwner)).toEqual({ from: ANA, to: null });
  });

  it("reads a legacy row where the owner paid the member", () => {
    expect(settlementParties(legacyFromOwner)).toEqual({ from: null, to: ANA });
  });

  it("reads a member-to-member row", () => {
    expect(settlementParties(memberToMember)).toEqual({ from: ANA, to: BEN });
  });

  it("prefers the explicit columns when a row carries both encodings", () => {
    const both = { participantId: ANA, direction: "TO_OWNER" as const, fromParticipantId: BEN, toParticipantId: ANA };
    expect(settlementParties(both)).toEqual({ from: BEN, to: ANA });
  });

  it("treats a malformed row as inert rather than throwing inside a balance", () => {
    // A dashboard render must not crash on one bad row; owner → owner moves
    // nothing, which is the safest reading of "we cannot tell".
    expect(settlementParties({ participantId: null, direction: null })).toEqual({ from: null, to: null });
    expect(ownerDelta({ participantId: null, direction: null }, 5000)).toBe(0);
  });
});

describe("involvesOwner", () => {
  it("is true for both legacy directions", () => {
    expect(involvesOwner(legacyToOwner)).toBe(true);
    expect(involvesOwner(legacyFromOwner)).toBe(true);
  });

  it("is false between two members — the reason no cash leg is written", () => {
    expect(involvesOwner(memberToMember)).toBe(false);
  });
});

describe("balance deltas", () => {
  const AMT = 50000; // ₹500

  it("legacy member → owner behaves exactly as before", () => {
    // was: add(net, participantId, -amount) and settlementDelta -= amount
    expect(participantDelta(legacyToOwner, ANA, AMT)).toBe(-AMT);
    expect(ownerDelta(legacyToOwner, AMT)).toBe(-AMT);
  });

  it("legacy owner → member behaves exactly as before", () => {
    expect(participantDelta(legacyFromOwner, ANA, AMT)).toBe(AMT);
    expect(ownerDelta(legacyFromOwner, AMT)).toBe(AMT);
  });

  it("the payer owes less and the recipient is owed less", () => {
    expect(participantDelta(memberToMember, ANA, AMT)).toBe(-AMT);
    expect(participantDelta(memberToMember, BEN, AMT)).toBe(AMT);
  });

  it("leaves the owner's position untouched between two members", () => {
    // The financial invariant this whole change rests on.
    expect(ownerDelta(memberToMember, AMT)).toBe(0);
  });

  it("touches nobody else", () => {
    expect(participantDelta(memberToMember, "p-someone-else", AMT)).toBe(0);
    expect(participantDelta(legacyToOwner, BEN, AMT)).toBe(0);
  });

  it("every settlement is zero-sum, whichever shape it is stored in", () => {
    // Members are tracked as "owes the owner" and the owner as "is owed", so
    // the owner's delta is negated to bring both into one frame. In that frame
    // a settlement only ever moves debt between two people — it never creates
    // or destroys any.
    for (const row of [legacyToOwner, legacyFromOwner, memberToMember]) {
      const { from, to } = settlementParties(row);
      const members = [from, to].filter((id): id is string => id !== null);
      const memberSide = members.reduce((sum, id) => sum + participantDelta(row, id, AMT), 0);
      const ownerSide = -ownerDelta(row, AMT);
      expect(memberSide + ownerSide).toBe(0);
    }
  });
});
