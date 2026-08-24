// What the member↔member settle action will accept (#240).
//
// The schema is the outer gate, not the authority: recordMemberSettlement
// re-checks that both people are the caller's own contacts, that the group is
// theirs, and that both are in it. These tests pin what is rejected before it
// ever reaches that — the malformed shapes, and the one semantic rule cheap
// enough to enforce here (a payment needs two different people).

import { describe, expect, it } from "vitest";
import { memberSettlementSchema } from "./index";

const valid = {
  groupId: "g1",
  fromParticipantId: "p-a",
  toParticipantId: "p-b",
  amount: "250",
  method: "UPI" as const,
};

const parse = (patch: Record<string, unknown>) => memberSettlementSchema.safeParse({ ...valid, ...patch });

describe("memberSettlementSchema", () => {
  it("accepts a well-formed payment and converts the amount to paise", () => {
    const r = memberSettlementSchema.safeParse(valid);
    expect(r.success).toBe(true);
    expect(r.success && r.data.amount).toBe(25_000);
  });

  it("keeps the paise — settling ₹745.33 must not become ₹745", () => {
    const r = parse({ amount: "745.33" });
    expect(r.success && r.data.amount).toBe(74_533);
  });

  it("rejects a payment from someone to themselves", () => {
    const r = parse({ toParticipantId: "p-a" });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0].message).toBe("A settlement needs two different people.");
  });

  it("requires a group — this payment only means anything against one ledger", () => {
    expect(parse({ groupId: "" }).success).toBe(false);
    expect(memberSettlementSchema.safeParse({ ...valid, groupId: undefined }).success).toBe(false);
  });

  it("requires both ends", () => {
    expect(parse({ fromParticipantId: "" }).success).toBe(false);
    expect(parse({ toParticipantId: "" }).success).toBe(false);
  });

  it("rejects amounts that are not real money", () => {
    for (const amount of ["0", "-50", "", "abc"]) expect({ amount, ok: parse({ amount }).success }).toEqual({ amount, ok: false });
  });

  it("rejects a method the ledger does not have", () => {
    expect(parse({ method: "CARD" }).success).toBe(false);
  });

  it("takes a note, and caps it", () => {
    expect(parse({ note: "cash in hand" }).success).toBe(true);
    expect(parse({ note: "x".repeat(201) }).success).toBe(false);
  });

  it("has no direction or account field — the pair is the direction and no account moves", () => {
    const r = parse({ direction: "TO_OWNER", accountId: "acc-1" });
    expect(r.success).toBe(true);
    expect(r.success && "direction" in r.data).toBe(false);
    expect(r.success && "accountId" in r.data).toBe(false);
  });
});
