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
import { buildSplitPayload, seedForMode, type SplitEditorState } from "./split-editor";
import { computeShares } from "@/lib/split-shares";

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
    // The owner is seeded under "me" alongside the friends. When they pay it is
    // ignored — splitExact derives their share — but it is what keeps the
    // distribution intact if somebody else is named as payer.
    expect(seed?.exact).toEqual({ me: "250", [A]: "250", [B]: "250", [C]: "250" });
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
    expect(seedForMode(rup(1000), pct, four, "EXACT")?.exact).toEqual({ me: "0", [A]: "500", [B]: "300", [C]: "200" });
  });

  it("Ratio → Exact gives the amounts that ratio produces", () => {
    const ratio = state({ mode: "RATIO", weights: { me: "0", [A]: "5", [B]: "3", [C]: "2" } });
    expect(seedForMode(rup(1000), ratio, four, "EXACT")?.exact).toEqual({ me: "0", [A]: "500", [B]: "300", [C]: "200" });
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
    expect(seedForMode(rup(1000), edited, four, "EXACT")?.exact).toEqual({ me: "0", [A]: "400", [B]: "300", [C]: "300" });
  });

  it("an edited Ratio split carries into Exact", () => {
    const edited = state({ mode: "RATIO", weights: { me: "0", [A]: "1", [B]: "1", [C]: "2" } });
    expect(seedForMode(rup(1000), edited, four, "EXACT")?.exact).toEqual({ me: "0", [A]: "250", [B]: "250", [C]: "500" });
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
    // A paid, so A carries the odd paise.
    expect(Math.round(Number(seed!.exact![A]) * 100)).toBe(334);
    // The owner's 333 is stated rather than left to be inferred, so the seed
    // accounts for the whole amount.
    expect(Math.round(Number(seed!.exact!.me) * 100)).toBe(333);
    expect(total).toBe(1000);
  });

  // ── a whole-rupee ratio should never render as 1.0000001 ───────────────
  it("ratios stay whole numbers", () => {
    const seed = seedForMode(rup(1000), state({ mode: "EQUAL" }), [A, B, C, D], "RATIO");
    for (const v of Object.values(seed!.weights!)) expect(v).toMatch(/^\d+$/);
  });

  // ── and a ratio has to be small enough to read ─────────────────────────
  //
  // Reducing the paise by their common divisor fails exactly when the split
  // does not divide evenly: ₹1,000 three ways is 33333 / 33334 / 33333, which
  // are coprime, so the "reduced" ratio came out as those same five-digit
  // numbers. It is unreadable, unusable as an input, and adding a member to it
  // stored ₹0.11 against one person and ₹749.81 against another.
  it("an equal split that does not divide evenly still reads 1 : 1 : 1", () => {
    const seed = seedForMode(rup(1000), state({ mode: "EQUAL", payerId: A }), [A, B], "RATIO");
    expect(seed?.weights).toEqual({ me: "1", [A]: "1", [B]: "1" });
  });

  it("every seeded ratio stays small enough to type over", () => {
    for (const n of [2, 3, 4, 5, 6, 7]) {
      const ids = [A, B, C, D, "p-e", "p-f"].slice(0, n - 1);
      for (const total of [rup(1000), rup(999.99), rup(7), 100003]) {
        const seed = seedForMode(total, state({ mode: "EQUAL" }), ids, "RATIO");
        if (!seed) continue;
        for (const [k, v] of Object.entries(seed.weights!)) {
          expect({ n, total, k, v }).toEqual({ n, total, k, v: String(Number(v)) });
          expect(Number(v)).toBeLessThanOrEqual(200);
        }
      }
    }
  });

  it("the reduced ratio still produces the same money", () => {
    // 500 / 300 / 200 has an exact small ratio and must keep it.
    const seed = seedForMode(rup(1000), state({ mode: "EXACT", exact: { [A]: "500", [B]: "300", [C]: "200" } }), four, "RATIO");
    expect(seed?.weights).toEqual({ me: "0", [A]: "5", [B]: "3", [C]: "2" });
  });
});

// ── the seed exists so a change of payer costs nobody anything ────────────
//
// EXACT is the only mode where who paid changes what the engine READS. The
// owner's share is derived from the balance when they paid it, and stated
// under "me" when a friend did. Moving between those two without writing the
// figure down first left "me" at nothing — so the owner dropped to ₹0 and
// whoever was now named as payer was charged for their share. Reported from a
// real ₹1,200 four-way: You 300 / Karan 300 / Priya 300 / Rohan 300 became
// You 0 / Karan 600 the moment Karan was picked as payer.
describe("changing who paid does not change what anyone owes", () => {
  const K = "p-karan", P = "p-priya", R = "p-rohan";
  const ids = [K, P, R];
  const TOTAL = rup(1200);

  /** What the engine stores, keyed by person, for a given payer. */
  function owed(exact: Record<string, string>, payer: string | null) {
    const st = state({ mode: "EXACT", exact, payerId: payer });
    const rows = computeShares(TOTAL, buildSplitPayload(st, ids)!);
    return Object.fromEntries(rows.map((r) => [r.participantId ?? "me", r.owedAmount]));
  }

  it("an equal split seeded into Exact survives being handed to a friend", () => {
    const seeded = seedForMode(TOTAL, state({ mode: "EQUAL" }), ids, "EXACT")!.exact!;
    const evenly = { me: rup(300), [K]: rup(300), [P]: rup(300), [R]: rup(300) };
    expect(owed(seeded, null)).toEqual(evenly);
    expect(owed(seeded, K)).toEqual(evenly);
    expect(owed(seeded, P)).toEqual(evenly);
    expect(owed(seeded, R)).toEqual(evenly);
  });

  it("an uneven distribution survives it too", () => {
    // You 300 / Karan 300 / Priya 200 / Rohan 400 — the no-op-edit case.
    const seeded = { me: "300", [K]: "300", [P]: "200", [R]: "400" };
    const wanted = { me: rup(300), [K]: rup(300), [P]: rup(200), [R]: rup(400) };
    expect(owed(seeded, null)).toEqual(wanted);
    expect(owed(seeded, K)).toEqual(wanted);
    expect(owed(seeded, R)).toEqual(wanted);
  });

  it("re-seeding before the switch is what makes that true", () => {
    // Without the owner's key the payer absorbs their share — the old bug,
    // kept here so a regression reads as a diff rather than a mystery.
    const withoutOwner = { [K]: "300", [P]: "200", [R]: "400" };
    expect(owed(withoutOwner, K)).toEqual({ me: 0, [P]: rup(200), [R]: rup(400), [K]: rup(600) });
  });

  it("whoever pays, everybody is present exactly once and the total is exact", () => {
    const seeded = seedForMode(TOTAL, state({ mode: "EQUAL" }), ids, "EXACT")!.exact!;
    for (const payer of [null, K, P, R]) {
      const rows = owed(seeded, payer);
      expect({ payer, who: Object.keys(rows).sort() }).toEqual({ payer, who: [K, "me", P, R].sort() });
      expect({ payer, total: Object.values(rows).reduce((t, v) => t + v, 0) }).toEqual({ payer, total: TOTAL });
      expect({ payer, negative: Object.values(rows).some((v) => v < 0) }).toEqual({ payer, negative: false });
    }
  });
});
