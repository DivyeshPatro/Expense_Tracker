// Who a member row addresses, and how (P0 · CH-2).
//
// Two separate lies lived in this one label. The row marked as the reader's was
// the OWNER's row (`participantId === null`), so a linked member saw somebody
// else carrying their pronoun. And every other row said "will pay you", which
// is only true for the owner — what a member owes goes to whoever fronted the
// bill, and this column cannot name them.
//
// Fixture rule: nobody shares a number with anybody else, so a label that reads
// the wrong row cannot accidentally look right.

import { describe, expect, it } from "vitest";
import { memberRowLabel, SETTLED_THRESHOLD } from "./group-dashboard";

const ANA = "p-ana";
const BEN = "p-ben";
const OWNER = null;

// Stored convention: a member's net is "owes the group"; the owner's row is
// kept the other way up. Distinct magnitudes throughout.
const OWNER_NET = 13_000; // owner is owed ₹130
const ANA_NET = -29_000; // Ana is owed ₹290
const BEN_NET = 10_000; // Ben owes ₹100

describe("the reader's own row, and only theirs, speaks in first person", () => {
  it("the owner reading their own row", () => {
    expect(memberRowLabel(OWNER, OWNER_NET, OWNER)).toEqual({ isSelf: true, label: "you'll get overall" });
  });

  it("a member reading their own row — owed", () => {
    expect(memberRowLabel(ANA, ANA_NET, ANA)).toEqual({ isSelf: true, label: "you'll get overall" });
  });

  it("a member reading their own row — owing", () => {
    expect(memberRowLabel(BEN, BEN_NET, BEN)).toEqual({ isSelf: true, label: "you'll pay overall" });
  });

  it("the owner's row is NOT the reader's when a member is reading", () => {
    const r = memberRowLabel(OWNER, OWNER_NET, ANA);
    expect(r.isSelf).toBe(false);
    expect(r.label).not.toMatch(/you/i);
  });

  it("another member's row never says 'you' to anyone", () => {
    for (const viewer of [OWNER, ANA, BEN]) {
      const r = memberRowLabel("p-cara", 32_000, viewer);
      expect({ viewer, isSelf: r.isSelf, saysYou: /you/i.test(r.label) }).toEqual({ viewer, isSelf: false, saysYou: false });
    }
  });
});

describe("third-party rows state a standing, not a direction", () => {
  it("someone who owes the group", () => {
    expect(memberRowLabel(BEN, BEN_NET, ANA).label).toBe("owes overall");
  });

  it("someone the group owes", () => {
    expect(memberRowLabel(ANA, ANA_NET, BEN).label).toBe("is owed overall");
  });

  it("never claims the money is coming to the reader", () => {
    // "will pay you" was the old wording, and it named a destination this
    // column has no way to know.
    expect(memberRowLabel(BEN, BEN_NET, ANA).label).not.toMatch(/pay you|owes you/i);
  });
});

describe("the settled threshold is unchanged", () => {
  it("dust reads as settled on the reader's own row, both signs", () => {
    for (const net of [SETTLED_THRESHOLD, -SETTLED_THRESHOLD, 0, 40, -40]) {
      expect({ net, label: memberRowLabel(ANA, net, ANA).label }).toEqual({ net, label: "all settled" });
    }
  });

  it("a hair over the threshold is not settled", () => {
    expect(memberRowLabel(ANA, -(SETTLED_THRESHOLD + 1), ANA).label).toBe("you'll get overall");
    expect(memberRowLabel(ANA, SETTLED_THRESHOLD + 1, ANA).label).toBe("you'll pay overall");
  });

  it("third-party rows use the same threshold as before", () => {
    expect(memberRowLabel(BEN, SETTLED_THRESHOLD, ANA).label).toBe("all settled");
    expect(memberRowLabel(BEN, SETTLED_THRESHOLD + 1, ANA).label).toBe("owes overall");
  });
});

describe("the three viewers cannot be confused for one another", () => {
  it("the same row reads differently depending on who is reading", () => {
    const seen = [OWNER, ANA, BEN].map((viewer) => memberRowLabel(ANA, ANA_NET, viewer));
    expect(seen.filter((r) => r.isSelf)).toHaveLength(1);
    expect(seen.find((r) => r.isSelf)!.label).toBe("you'll get overall");
    expect(seen.filter((r) => !r.isSelf).every((r) => r.label === "is owed overall")).toBe(true);
  });
});
