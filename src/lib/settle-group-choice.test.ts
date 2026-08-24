// Which group a settlement belongs to, as the settle form decides it.
//
// recordSettlement() infers the group when exactly one of the caller's groups
// contains the person, and deliberately refuses to guess when several do —
// guessing would clear the wrong group's balance. That refusal left the payment
// untagged and the group still asking for the money, so the form has to ask.
//
// The form reuses inferGroupForMembers with a single participant. These tests
// pin the three shapes that reaches, and the one it can never reach: "conflict"
// needs two or more people picked, so a lone participant is always none / one /
// ambiguous — which is why the settle form only ever has to handle "ask or
// don't".

import { describe, expect, it } from "vitest";
import { inferGroupForMembers, needsExplicitGroupChoice, type GroupLike } from "./group-inference";

const ANA = "p-ana";
const BEN = "p-ben";

const trip: GroupLike = { id: "g-trip", name: "Trip", memberIds: [ANA, BEN] };
const flat: GroupLike = { id: "g-flat", name: "Flat", memberIds: [ANA] };
const office: GroupLike = { id: "g-office", name: "Office", memberIds: [BEN] };

/** What the form computes for one person. */
const forPerson = (id: string, groups: GroupLike[]) => inferGroupForMembers([id], groups);

describe("the settle form's group decision", () => {
  it("asks nothing when no group contains the person", () => {
    const inf = forPerson(ANA, [office]);
    expect(inf.kind).toBe("none");
    expect(needsExplicitGroupChoice(inf, false)).toBe(false);
  });

  it("asks nothing when exactly one does — server-side inference still handles it", () => {
    const inf = forPerson(ANA, [flat, office]);
    expect(inf).toEqual({ kind: "one", groupId: "g-flat", groupName: "Flat" });
    expect(needsExplicitGroupChoice(inf, false)).toBe(false);
  });

  it("asks when several do, and names them", () => {
    const inf = forPerson(ANA, [trip, flat, office]);
    expect(inf.kind).toBe("ambiguous");
    expect(inf.kind === "ambiguous" && inf.candidates.map((c) => c.name)).toEqual(["Trip", "Flat"]);
    expect(needsExplicitGroupChoice(inf, false)).toBe(true);
  });

  it("stops asking once answered — including when the answer is 'not for a group'", () => {
    const inf = forPerson(ANA, [trip, flat]);
    expect(needsExplicitGroupChoice(inf, true)).toBe(false);
  });

  it("never reaches the conflict shape: that needs two or more people", () => {
    // The expense form has a fourth state — a group holding most of the people
    // picked but not all. One person is either in a group or not, so the settle
    // form only ever sees none / one / ambiguous.
    for (const groups of [[trip], [trip, flat], [trip, flat, office], []]) {
      for (const who of [ANA, BEN]) expect(forPerson(who, groups).kind).not.toBe("conflict");
    }
  });

  it("offers only the groups that actually contain the person", () => {
    const inf = forPerson(BEN, [trip, flat, office]);
    expect(inf.kind === "ambiguous" && inf.candidates.map((c) => c.id)).toEqual(["g-trip", "g-office"]);
  });

  it("a person in no groups at all is never asked", () => {
    expect(forPerson("p-nobody", [trip, flat, office]).kind).toBe("none");
  });
});
