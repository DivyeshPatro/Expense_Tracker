// Joining an existing split, and the states the schema will refuse.
//
// A member added to a live Percent or Ratio split used to start blank.
// buildSplitPayload turns a blank into 0, splitSchema.weights is positive(),
// and computeSplitPreview is perfectly happy either way — the shares still
// total the amount, the newcomer simply gets ₹0 — so the screen looked
// finished, said nothing, and the save came back "Number must be greater than
// 0" without naming anyone. Two taps from picking a group.
//
// seedForNewMember gives the newcomer an equal share of what is currently
// being divided, in whatever units the mode speaks. splitInputProblem says the
// schema's rule out loud, early, for the states a reader can still reach by
// typing.

import { describe, expect, it } from "vitest";
import { buildSplitPayload, seedForNewMember, splitInputProblem, type SplitEditorState } from "./split-editor";
import { computeSplitPreview } from "@/lib/split-shares";
import { splitSchema } from "@/validators";

const K = "p-karan", R = "p-rohan", P = "p-priya";
const rup = (n: number) => n * 100;

function state(over: Partial<SplitEditorState>): SplitEditorState {
  return {
    split: true, mode: "EQUAL", setMode: () => {}, setSplit: () => {},
    parts: {}, setParts: () => {}, exact: {}, setExact: () => {},
    weights: {}, setWeights: () => {}, payerId: null, setPayerId: () => {},
    ...over,
  };
}

/** Would the server take this? The schema is the authority; this asks it. */
function accepted(st: SplitEditorState, selectedIds: string[]): boolean {
  return splitSchema.safeParse(buildSplitPayload(st, selectedIds)).success;
}

describe("a member joining an existing split", () => {
  // ── PERCENT ──────────────────────────────────────────────────────────────
  it("PERCENT: the newcomer gets an equal share and the rest scale into what is left", () => {
    // The exact numbers the audit reported: You 48.7 / Karan 20 / Rohan 31.3.
    const before = state({ mode: "PERCENT", weights: { me: "48.7", [K]: "20", [R]: "31.3" } });
    const seed = seedForNewMember(rup(1000), before, [K, R, P], P)!;
    expect(seed.weights![P]).toBe("25"); // 100 ÷ 4 heads
    const total = ["me", K, R, P].reduce((t, k) => t + Number(seed.weights![k]), 0);
    expect(total).toBeCloseTo(100, 2);
    // In proportion to what they held before, not flattened.
    expect(Number(seed.weights!.me)).toBeGreaterThan(Number(seed.weights![R]));
    expect(Number(seed.weights![R])).toBeGreaterThan(Number(seed.weights![K]));
  });

  it("PERCENT: the result is a split the server accepts", () => {
    const before = state({ mode: "PERCENT", weights: { me: "48.7", [K]: "20", [R]: "31.3" } });
    const seed = seedForNewMember(rup(1000), before, [K, R, P], P)!;
    const after = state({ mode: "PERCENT", weights: seed.weights! });
    expect(accepted(after, [K, R, P])).toBe(true);
    // and it is what the blank case failed
    expect(accepted(state({ mode: "PERCENT", weights: before.weights }), [K, R, P])).toBe(false);
  });

  it("PERCENT: the newcomer actually gets money, not a zero row", () => {
    const before = state({ mode: "PERCENT", weights: { me: "48.7", [K]: "20", [R]: "31.3" } });
    const seed = seedForNewMember(rup(1000), before, [K, R, P], P)!;
    const preview = computeSplitPreview(rup(1000), buildSplitPayload(state({ mode: "PERCENT", weights: seed.weights! }), [K, R, P])!);
    expect(preview.rows.find((r) => r.participantId === P)!.owedAmount).toBe(rup(250));
    expect(preview.total).toBe(rup(1000));
    expect(preview.balances).toBe(true);
  });

  // ── RATIO ────────────────────────────────────────────────────────────────
  it("RATIO: the newcomer gets the mean of the existing parts, as a whole number", () => {
    // You 5 / Karan 3 / Rohan 2 — the audit's example. Mean 3.33 → 3.
    const before = state({ mode: "RATIO", weights: { me: "5", [K]: "3", [R]: "2" } });
    const seed = seedForNewMember(rup(1000), before, [K, R, P], P)!;
    expect(seed.weights![P]).toBe("3");
    expect(seed.weights![P]).toMatch(/^\d+$/);
  });

  it("RATIO: everyone already there keeps their part — relative standing is the point of a ratio", () => {
    const before = state({ mode: "RATIO", weights: { me: "5", [K]: "3", [R]: "2" } });
    const seed = seedForNewMember(rup(1000), before, [K, R, P], P)!;
    expect(seed.weights!.me).toBe("5");
    expect(seed.weights![K]).toBe("3");
    expect(seed.weights![R]).toBe("2");
  });

  it("RATIO: never zero parts, even when everyone else is on 1", () => {
    const before = state({ mode: "RATIO", weights: { me: "1", [K]: "1", [R]: "1" } });
    const seed = seedForNewMember(rup(1000), before, [K, R, P], P)!;
    expect(Number(seed.weights![P])).toBeGreaterThan(0);
    expect(accepted(state({ mode: "RATIO", weights: seed.weights! }), [K, R, P])).toBe(true);
  });

  // ── EXACT ────────────────────────────────────────────────────────────────
  it("EXACT: the newcomer's share comes out of the other friends, not the owner", () => {
    // ₹1,200: Karan 400, Rohan 200, owner derives 600.
    const before = state({ mode: "EXACT", exact: { [K]: "400", [R]: "200" } });
    const seed = seedForNewMember(rup(1200), before, [K, R, P], P)!;
    expect(Number(seed.exact![P])).toBe(300); // 1200 ÷ 4 heads
    const friends = [K, R, P].reduce((t, id) => t + Math.round(Number(seed.exact![id]) * 100), 0);
    expect(friends).toBe(rup(600)); // unchanged, so the owner still derives 600
    const preview = computeSplitPreview(rup(1200), buildSplitPayload(state({ mode: "EXACT", exact: seed.exact! }), [K, R, P])!);
    expect(preview.rows.find((r) => r.participantId === null)!.owedAmount).toBe(rup(600));
    expect(preview.total).toBe(rup(1200));
  });

  // ── the cases where there is nothing to seed ─────────────────────────────
  it("EQUAL has no per-person input, so nothing is seeded", () => {
    expect(seedForNewMember(rup(1000), state({ mode: "EQUAL" }), [K, P], P)).toBeNull();
  });

  it("someone who is not actually in the split is not seeded", () => {
    expect(seedForNewMember(rup(1000), state({ mode: "PERCENT" }), [K, R], P)).toBeNull();
  });

  it("EXACT with no amount yet cannot invent a share", () => {
    expect(seedForNewMember(undefined, state({ mode: "EXACT" }), [K, P], P)).toBeNull();
    expect(seedForNewMember(0, state({ mode: "EXACT" }), [K, P], P)).toBeNull();
  });
});

describe("saying what the schema will refuse, before the save", () => {
  it("names a zero percentage rather than letting the server say it", () => {
    const st = state({ mode: "PERCENT", weights: { me: "50", [K]: "50", [P]: "0" } });
    expect(splitInputProblem(st, [K, P])).toMatch(/percentage above 0/);
    expect(accepted(st, [K, P])).toBe(false);
  });

  it("catches a blank the same way — a blank IS a zero once it is sent", () => {
    const st = state({ mode: "PERCENT", weights: { me: "50", [K]: "50" } });
    expect(splitInputProblem(st, [K, P])).toBeTruthy();
    expect(accepted(st, [K, P])).toBe(false);
  });

  it("counts the owner too, because the schema does", () => {
    const st = state({ mode: "RATIO", weights: { me: "0", [K]: "1", [P]: "1" } });
    expect(splitInputProblem(st, [K, P])).toMatch(/at least one part/);
    expect(accepted(st, [K, P])).toBe(false);
  });

  it("reports percentages that overshoot, and says by how much", () => {
    // 60 / 30 / 20 — the reader has to be told, not quietly corrected.
    const st = state({ mode: "PERCENT", weights: { me: "60", [K]: "30", [P]: "20" } });
    expect(splitInputProblem(st, [K, P])).toBe("These add up to 110% — that is 10% too much.");
  });

  it("allows the rounding slack a hundredth of a percent needs", () => {
    const st = state({ mode: "PERCENT", weights: { me: "33.33", [K]: "33.33", [P]: "33.34" } });
    expect(splitInputProblem(st, [K, P])).toBeNull();
  });

  it("says nothing about a split that is fine", () => {
    expect(splitInputProblem(state({ mode: "PERCENT", weights: { me: "25", [K]: "25", [P]: "50" } }), [K, P])).toBeNull();
    expect(splitInputProblem(state({ mode: "RATIO", weights: { me: "1", [K]: "1", [P]: "2" } }), [K, P])).toBeNull();
  });

  it("has nothing to say about Equal or Exact — neither carries a weight", () => {
    expect(splitInputProblem(state({ mode: "EQUAL" }), [K, P])).toBeNull();
    expect(splitInputProblem(state({ mode: "EXACT", exact: { [K]: "0", [P]: "0" } }), [K, P])).toBeNull();
  });

  it("says nothing when there is no split at all", () => {
    expect(splitInputProblem(state({ split: false, mode: "PERCENT" }), [K, P])).toBeNull();
    expect(splitInputProblem(state({ mode: "PERCENT" }), [])).toBeNull();
  });
});
