// The split engine the expense form and the writer now share.
//
// The case that made this necessary: a ₹2,530 dinner split 1:2:1:1:1. Ledgerly
// stored ₹843.33 against the double-weighted person and ₹421.69 against the
// payer, and the form said only "Your share: ₹421.69" — the ₹843.33 appeared
// nowhere until the group statement was exported days later. These tests pin
// what computeShares actually produces, and that the preview reports exactly
// that and nothing of its own.

import { describe, expect, it } from "vitest";
import { computeShares, computeSplitPreview, type SplitInput } from "./split-shares";

const rup = (n: number) => Math.round(n * 100);
const ME = null; // the owner's own share is stored with participantId null

const SRIKANT = "p-srikant";
const BALDEV = "p-baldev";
const ABHISEKH = "p-abhisekh";
const NITYA = "p-nitya";

/** The real trip: ₹2,530, Srikant counting double, paid by the owner. */
const srisailam = (payer: string | null = null): SplitInput => ({
  mode: "RATIO",
  participantIds: [SRIKANT, BALDEV, ABHISEKH, NITYA],
  payerParticipantId: payer,
  weights: { me: 1, [SRIKANT]: 2, [BALDEV]: 1, [ABHISEKH]: 1, [NITYA]: 1 },
});

const owed = (shares: { participantId: string | null; owedAmount: number }[], id: string | null) =>
  shares.find((s) => s.participantId === id)!.owedAmount;

describe("computeShares", () => {
  it("splits equally when it divides cleanly", () => {
    const shares = computeShares(rup(900), { mode: "EQUAL", participantIds: ["a", "b"], payerParticipantId: null });
    expect(shares.map((s) => s.owedAmount)).toEqual([rup(300), rup(300), rup(300)]);
  });

  it("gives the leftover paise to the payer, not to whoever sorts first", () => {
    // ₹10 three ways = 333.33 each; one paise cannot be divided.
    const shares = computeShares(rup(10), { mode: "EQUAL", participantIds: ["a", "b"], payerParticipantId: null });
    expect(owed(shares, ME)).toBe(334);
    expect(owed(shares, "a")).toBe(333);
    expect(owed(shares, "b")).toBe(333);
    expect(shares.reduce((s, x) => s + x.owedAmount, 0)).toBe(rup(10));
  });

  it("moves the remainder when somebody else pays", () => {
    const shares = computeShares(rup(10), { mode: "EQUAL", participantIds: ["a", "b"], payerParticipantId: "a" });
    expect(owed(shares, "a")).toBe(334);
    expect(owed(shares, ME)).toBe(333);
  });

  it("honours exact amounts, the payer taking the balance", () => {
    const shares = computeShares(rup(1000), {
      mode: "EXACT",
      participantIds: ["a", "b"],
      payerParticipantId: null,
      exactAmounts: { a: rup(250), b: rup(400) },
    });
    expect(owed(shares, "a")).toBe(rup(250));
    expect(owed(shares, "b")).toBe(rup(400));
    expect(owed(shares, ME)).toBe(rup(350));
  });

  it("allows a zero share", () => {
    const shares = computeShares(rup(600), {
      mode: "EXACT",
      participantIds: ["a", "b"],
      payerParticipantId: null,
      exactAmounts: { a: rup(600), b: 0 },
    });
    expect(owed(shares, "b")).toBe(0);
    expect(owed(shares, ME)).toBe(0); // paid for it, consumed none of it
  });

  it("splits by percentage", () => {
    const shares = computeShares(rup(1000), {
      mode: "PERCENT",
      participantIds: ["a", "b"],
      payerParticipantId: null,
      weights: { me: 50, a: 30, b: 20 },
    });
    expect(owed(shares, ME)).toBe(rup(500));
    expect(owed(shares, "a")).toBe(rup(300));
    expect(owed(shares, "b")).toBe(rup(200));
  });

  it("reproduces the Srisailam ratio exactly", () => {
    const shares = computeShares(rup(2530), srisailam());
    expect(owed(shares, ME)).toBe(42169); // ₹421.69 — payer, so it carries the 3p
    expect(owed(shares, SRIKANT)).toBe(84333); // ₹843.33 — the figure the old form hid
    expect(owed(shares, BALDEV)).toBe(42166);
    expect(owed(shares, ABHISEKH)).toBe(42166);
    expect(owed(shares, NITYA)).toBe(42166);
    expect(shares.reduce((s, x) => s + x.owedAmount, 0)).toBe(rup(2530));
  });

  it("moves Srisailam's remainder when Srikant pays instead", () => {
    const shares = computeShares(rup(2530), srisailam(SRIKANT));
    expect(owed(shares, SRIKANT)).toBe(84336); // 84333 + the 3p
    expect(owed(shares, ME)).toBe(42166);
    expect(shares.reduce((s, x) => s + x.owedAmount, 0)).toBe(rup(2530));
  });

  it("rejects exact amounts that exceed the total", () => {
    expect(() =>
      computeShares(rup(100), { mode: "EXACT", participantIds: ["a"], payerParticipantId: null, exactAmounts: { a: rup(200) } })
    ).toThrow(/exceed/i);
  });
});

describe("computeSplitPreview", () => {
  it("reports every participant, not just the person filling the form", () => {
    const p = computeSplitPreview(rup(2530), srisailam());
    expect(p.rows).toHaveLength(5);
    expect(p.rows.map((r) => r.participantId)).toEqual([ME, SRIKANT, BALDEV, ABHISEKH, NITYA]);
  });

  it("shows the same rupee figures computeShares stores", () => {
    // The property that matters: the preview adds no arithmetic of its own.
    const input = srisailam();
    const shares = computeShares(rup(2530), input);
    const p = computeSplitPreview(rup(2530), input);
    for (const s of shares) expect(p.rows.find((r) => r.participantId === s.participantId)!.owedAmount).toBe(s.owedAmount);
  });

  it("labels a ratio so 2 parts is visibly different from 1", () => {
    const p = computeSplitPreview(rup(2530), srisailam());
    expect(p.rows.find((r) => r.participantId === SRIKANT)!.method).toBe("2 parts");
    expect(p.rows.find((r) => r.participantId === BALDEV)!.method).toBe("1 part");
  });

  it("labels percentages with the percentage", () => {
    const p = computeSplitPreview(rup(1000), {
      mode: "PERCENT",
      participantIds: ["a"],
      payerParticipantId: null,
      weights: { me: 60, a: 40 },
    });
    expect(p.rows.map((r) => r.method)).toEqual(["60%", "40%"]);
    expect(p.rows.map((r) => r.owedAmount)).toEqual([rup(600), rup(400)]);
  });

  it("labels equal and exact plainly", () => {
    expect(computeSplitPreview(rup(900), { mode: "EQUAL", participantIds: ["a"], payerParticipantId: null }).rows[0].method).toBe("Equal");
    expect(
      computeSplitPreview(rup(900), { mode: "EXACT", participantIds: ["a"], payerParticipantId: null, exactAmounts: { a: rup(400) } })
        .rows[0].method
    ).toBe("Exact");
  });

  it("totals the shares and confirms they balance", () => {
    const p = computeSplitPreview(rup(2530), srisailam());
    expect(p.total).toBe(rup(2530));
    expect(p.balances).toBe(true);
  });

  it("reports the remainder and who absorbs it", () => {
    const p = computeSplitPreview(rup(2530), srisailam());
    expect(p.remainder).toBe(3); // 3 paise
    expect(p.rows.find((r) => r.isPayer)!.participantId).toBe(ME);
  });

  it("reports no remainder when the division is clean", () => {
    expect(computeSplitPreview(rup(900), { mode: "EQUAL", participantIds: ["a", "b"], payerParticipantId: null }).remainder).toBe(0);
  });

  it("marks the new payer as the remainder's recipient", () => {
    const p = computeSplitPreview(rup(2530), srisailam(SRIKANT));
    expect(p.rows.find((r) => r.isPayer)!.participantId).toBe(SRIKANT);
    expect(p.remainder).toBe(3);
  });

  it("surfaces an unbalanced split rather than throwing at the user", () => {
    const p = computeSplitPreview(rup(100), {
      mode: "EXACT",
      participantIds: ["a"],
      payerParticipantId: null,
      exactAmounts: { a: rup(200) },
    });
    expect(p.error).toMatch(/exceed/i);
    expect(p.balances).toBe(false);
  });

  it("asks for an amount before it will compute anything", () => {
    const p = computeSplitPreview(0, srisailam());
    expect(p.error).toMatch(/amount/i);
    expect(p.rows).toEqual([]);
  });

  // ── the preview tracks every input the user can change ──────────────────
  it("follows the amount", () => {
    const a = computeSplitPreview(rup(2530), srisailam());
    const b = computeSplitPreview(rup(5060), srisailam());
    expect(b.total).toBe(rup(5060));
    expect(b.rows[1].owedAmount).toBe(a.rows[1].owedAmount * 2);
  });

  it("follows the participants", () => {
    const fewer = computeSplitPreview(rup(2530), { ...srisailam(), participantIds: [SRIKANT, BALDEV] });
    expect(fewer.rows).toHaveLength(3);
    expect(fewer.total).toBe(rup(2530));
  });

  it("follows the weights", () => {
    const evened = computeSplitPreview(rup(2530), {
      ...srisailam(),
      weights: { me: 1, [SRIKANT]: 1, [BALDEV]: 1, [ABHISEKH]: 1, [NITYA]: 1 },
    });
    expect(evened.rows.find((r) => r.participantId === SRIKANT)!.owedAmount).toBe(50600);
    expect(evened.total).toBe(rup(2530));
  });

  it("follows the mode", () => {
    const asEqual = computeSplitPreview(rup(2530), { ...srisailam(), mode: "EQUAL" });
    expect(asEqual.rows.every((r) => r.method === "Equal")).toBe(true);
    expect(asEqual.rows.find((r) => r.participantId === SRIKANT)!.owedAmount).toBe(50600);
    expect(asEqual.total).toBe(rup(2530));
  });
});

// ── The owner is a participant whoever paid ─────────────────────────────────
//
// EXACT used to drop the owner entirely when a friend paid. ₹1,000 between the
// owner, Karan and Priya, paid by Karan, stored `priya=333.33, karan=666.67`
// and no owner row at all — so the owner consumed nothing of an expense they
// shared, and Karan carried a share he never agreed to. Group balances were
// wrong by the owner's share.
//
// EQUAL, PERCENT and RATIO all included the owner in that case; EXACT was the
// only mode that did not, which is what marked it as a bug rather than a rule.
describe("EXACT keeps the owner in the split when a friend pays", () => {
  const K = "karan", P = "priya";
  const ids = [K, P];

  it("the owner gets the share they stated", () => {
    const rows = computeShares(rup(1000), {
      mode: "EXACT", participantIds: ids, payerParticipantId: K,
      exactAmounts: { me: rup(333.33), [K]: rup(333.33), [P]: rup(333.33) },
    });
    const owner = rows.find((r) => r.participantId === null);
    expect(owner).toBeDefined();
    expect(owner!.owedAmount).toBe(rup(333.33));
    // Karan paid, so Karan still absorbs whatever is left.
    expect(rows.find((r) => r.participantId === K)!.owedAmount).toBe(rup(1000) - rup(333.33) - rup(333.33));
    expect(rows.reduce((t, r) => t + r.owedAmount, 0)).toBe(rup(1000));
  });

  it("every mode now agrees about who is in the split", () => {
    const each = { me: 1, [K]: 1, [P]: 1 };
    for (const mode of ["EQUAL", "PERCENT", "RATIO", "EXACT"] as const) {
      const rows = computeShares(rup(999), {
        mode, participantIds: ids, payerParticipantId: K,
        weights: each,
        exactAmounts: { me: rup(333), [K]: rup(333), [P]: rup(333) },
      });
      expect({ mode, hasOwner: rows.some((r) => r.participantId === null) }).toEqual({ mode, hasOwner: true });
      expect({ mode, total: rows.reduce((t, r) => t + r.owedAmount, 0) }).toEqual({ mode, total: rup(999) });
    }
  });

  it("the owner paying still derives their share rather than stating it", () => {
    // Unchanged behaviour: no "me" is consumed, the owner takes the remainder.
    const rows = computeShares(rup(1000), {
      mode: "EXACT", participantIds: ids, payerParticipantId: null,
      exactAmounts: { me: rup(999), [K]: rup(300), [P]: rup(300) },
    });
    expect(rows.find((r) => r.participantId === null)!.owedAmount).toBe(rup(400));
    expect(rows.reduce((t, r) => t + r.owedAmount, 0)).toBe(rup(1000));
  });

  it("an absent owner key means an owner share of zero, not an absent owner", () => {
    // Old payloads carry no "me". The owner is still listed, at zero, so the
    // expense says plainly that they took no share of it.
    const rows = computeShares(rup(1000), {
      mode: "EXACT", participantIds: ids, payerParticipantId: K,
      exactAmounts: { [K]: rup(300), [P]: rup(300) },
    });
    expect(rows.find((r) => r.participantId === null)!.owedAmount).toBe(0);
    expect(rows.reduce((t, r) => t + r.owedAmount, 0)).toBe(rup(1000));
  });
});

// The payer × mode matrix. The bug that prompted this was payer-dependent and
// mode-dependent at once, so the invariants are asserted across every
// combination rather than the one shape that happened to break.
describe("payer x mode: everyone present, nobody twice, totals exact", () => {
  const K = "karan", P = "priya";
  const ids = [K, P];
  const MODES = ["EQUAL", "EXACT", "PERCENT", "RATIO"] as const;

  for (const payer of [null, K] as const) {
    for (const mode of MODES) {
      it(`${mode} paid by ${payer ?? "me"}`, () => {
        const rows = computeShares(rup(1000), {
          mode, participantIds: ids, payerParticipantId: payer,
          weights: { me: 1, [K]: 1, [P]: 2 },
          exactAmounts: { me: rup(250), [K]: rup(250), [P]: rup(250) },
        });
        const who = rows.map((r) => r.participantId ?? "me");
        // The owner and both friends are all in the split, whoever paid.
        expect({ mode, payer, who: [...who].sort() }).toEqual({ mode, payer, who: ["karan", "me", "priya"] });
        // Nobody appears twice.
        expect({ mode, payer, unique: new Set(who).size }).toEqual({ mode, payer, unique: 3 });
        // The shares are exactly the amount — no paise created or lost.
        expect({ mode, payer, total: rows.reduce((t, r) => t + r.owedAmount, 0) }).toEqual({ mode, payer, total: rup(1000) });
        // And no negative share.
        expect({ mode, payer, negative: rows.some((r) => r.owedAmount < 0) }).toEqual({ mode, payer, negative: false });
      });
    }
  }
});
