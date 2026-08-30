// Switching split mode must carry the current distribution across.
//
// Before this, each mode kept its own inputs and switching blanked them: a user
// looking at ₹250/₹250/₹250/₹250 who tapped "Exact amounts" got four empty
// boxes and had to retype what was already on screen.
//
// The bridge is deliberately the SHARES, not the previous mode's raw inputs —
// so an edit made in one mode survives into the next. seedForMode asks
// computeSplitPreview (the same call the breakdown and the writer make) what
// each person owes, then expresses that in the next mode's units. It does no
// split arithmetic of its own, which is why a percentage that cannot express
// the paise exactly is simply re-derived by the engine rather than quietly
// disagreeing with what was shown.

import { describe, expect, it } from "vitest";
import { seedForMode, type SplitEditorState } from "./split-editor";

const A = "p-a", B = "p-b", C = "p-c", D = "p-d";
const rup = (n: number) => n * 100;

/** A state object with only the fields seedForMode reads. */
function state(over: Partial<SplitEditorState>): SplitEditorState {
  return {
    split: true,
    mode: "EQUAL",
    setMode: () => {},
    setSplit: () => {},
    parts: {},
    setParts: () => {},
    exact: {},
    setExact: () => {},
    weights: {},
    setWeights: () => {},
    payerId: null,
    setPayerId: () => {},
    ...over,
  };
}

describe("seeding a split mode from the current distribution", () => {
  // ── TEST 1: an equal split of ₹1,000 across four ─────────────────────────
  const four = [A, B, C];  // + the owner = 4 people
  const equal = state({ mode: "EQUAL" });

  it("Equal → Exact starts from the equal shares, not blank", () => {
    const seed = seedForMode(rup(1000), equal, four, "EXACT");
    // EXACT carries friends only; the owner's share is derived by the engine.
    expect(seed?.exact).toEqual({ [A]: "250", [B]: "250", [C]: "250" });
  });

  it("Equal → Percent reads 25% each, including the owner", () => {
    const seed = seedForMode(rup(1000), equal, four, "PERCENT");
    expect(seed?.weights).toEqual({ me: "25", [A]: "25", [B]: "25", [C]: "25" });
  });

  it("Equal → Ratio reads 1 each, with no float noise", () => {
    const seed = seedForMode(rup(1000), equal, four, "RATIO");
    expect(seed?.weights).toEqual({ me: "1", [A]: "1", [B]: "1", [C]: "1" });
  });

  // ── TEST 2: exact → the others ───────────────────────────────────────────
  // Owner 0, A 500, B 300, C 200 — the owner takes no share here.
  const exact = state({ mode: "EXACT", exact: { [A]: "500", [B]: "300", [C]: "200" } });

  it("Exact → Percent converts the amounts to percentages", () => {
    const seed = seedForMode(rup(1000), exact, four, "PERCENT");
    expect(seed?.weights).toEqual({ me: "0", [A]: "50", [B]: "30", [C]: "20" });
  });

  it("Exact → Ratio reduces to the simplest whole ratio", () => {
    const seed = seedForMode(rup(1000), exact, four, "RATIO");
    expect(seed?.weights).toEqual({ me: "0", [A]: "5", [B]: "3", [C]: "2" });
  });

  // ── TEST 3/4: percent and ratio round-trip back to exact ────────────────
  it("Percent → Exact gives the rupee amounts those percentages produce", () => {
    const pct = state({ mode: "PERCENT", weights: { me: "0", [A]: "50", [B]: "30", [C]: "20" } });
    expect(seedForMode(rup(1000), pct, four, "EXACT")?.exact).toEqual({ [A]: "500", [B]: "300", [C]: "200" });
  });

  it("Ratio → Exact gives the amounts that ratio produces", () => {
    const ratio = state({ mode: "RATIO", weights: { me: "0", [A]: "5", [B]: "3", [C]: "2" } });
    expect(seedForMode(rup(1000), ratio, four, "EXACT")?.exact).toEqual({ [A]: "500", [B]: "300", [C]: "200" });
  });

  it("Ratio → Percent goes straight across", () => {
    const ratio = state({ mode: "RATIO", weights: { me: "0", [A]: "5", [B]: "3", [C]: "2" } });
    expect(seedForMode(rup(1000), ratio, four, "PERCENT")?.weights).toEqual({ me: "0", [A]: "50", [B]: "30", [C]: "20" });
  });

  // ── TEST 5/6/7: an edit in one mode has to survive into the next ────────
  it("an edited Exact split carries its OWN numbers into Percent", () => {
    const edited = state({ mode: "EXACT", exact: { [A]: "500", [B]: "200", [C]: "200" } }); // owner keeps 100
    const seed = seedForMode(rup(1000), edited, four, "PERCENT");
    expect(seed?.weights).toEqual({ me: "10", [A]: "50", [B]: "20", [C]: "20" });
  });

  it("an edited Percent split carries into Exact", () => {
    const edited = state({ mode: "PERCENT", weights: { me: "0", [A]: "40", [B]: "30", [C]: "30" } });
    expect(seedForMode(rup(1000), edited, four, "EXACT")?.exact).toEqual({ [A]: "400", [B]: "300", [C]: "300" });
  });

  it("an edited Ratio split carries into Exact", () => {
    const edited = state({ mode: "RATIO", weights: { me: "0", [A]: "1", [B]: "1", [C]: "2" } });
    expect(seedForMode(rup(1000), edited, four, "EXACT")?.exact).toEqual({ [A]: "250", [B]: "250", [C]: "500" });
  });

  // ── the cases where seeding would be invention rather than conversion ───
  it("EQUAL needs no inputs, so nothing is seeded", () => {
    expect(seedForMode(rup(1000), exact, four, "EQUAL")).toBeNull();
  });

  it("no amount yet means nothing to convert", () => {
    expect(seedForMode(0, equal, four, "EXACT")).toBeNull();
  });

  it("nobody selected means nothing to convert", () => {
    expect(seedForMode(rup(1000), equal, [], "PERCENT")).toBeNull();
  });

  it("a distribution the engine rejects is not converted into a bad seed", () => {
    // Exact amounts over the total — computeSplitPreview reports an error, and
    // seeding from a broken distribution would spread that error further.
    const over = state({ mode: "EXACT", exact: { [A]: "900", [B]: "900", [C]: "900" } });
    expect(seedForMode(rup(1000), over, four, "PERCENT")).toBeNull();
  });

  // ── the payer's remainder must survive the conversion ───────────────────
  it("the remainder stays with the payer through a conversion", () => {
    // ₹10 across 3 people does not divide evenly: 333/333/334 in paise terms.
    const three = [A, B];
    const seed = seedForMode(1000, state({ mode: "EQUAL", payerId: A }), three, "EXACT");
    const total = Object.values(seed!.exact!).reduce((t, v) => t + Math.round(Number(v) * 100), 0);
    // A paid, so A carries the odd paise; the owner's share is the balance.
    expect(Math.round(Number(seed!.exact![A]) * 100)).toBe(334);
    expect(total).toBe(667);
  });

  // ── a whole-rupee ratio should never render as 1.0000001 ───────────────
  it("ratios stay whole numbers", () => {
    const seed = seedForMode(rup(1000), state({ mode: "EQUAL" }), [A, B, C, D], "RATIO");
    for (const v of Object.values(seed!.weights!)) expect(v).toMatch(/^\d+$/);
  });
});
