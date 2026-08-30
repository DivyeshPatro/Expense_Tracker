// Editing one person's share should move the others, not leave the reader to
// repair the split by hand.
//
// Worth stating what this is NOT for, because it changes the design: the engine
// never produces an unbalanced split. splitExact hands the payer `total −
// stated`, and splitByWeights normalises by the weight sum, so raising one
// person to 50% still totals the amount exactly — it just quietly renormalises
// everyone against 125 instead of 100. This keeps the numbers ON SCREEN
// meaningful; it is not arithmetic repair, and it never runs the split itself.
//
// The edited value is always returned untouched. Only the others move.

import { describe, expect, it } from "vitest";
import { redistributeOnEdit, type SplitEditorState } from "./split-editor";
import { computeSplitPreview } from "@/lib/split-shares";

const A = "p-a", B = "p-b", C = "p-c";
const rup = (n: number) => n * 100;

function state(over: Partial<SplitEditorState>): SplitEditorState {
  return {
    split: true, mode: "EQUAL", setMode: () => {}, setSplit: () => {},
    parts: {}, setParts: () => {}, exact: {}, setExact: () => {},
    weights: {}, setWeights: () => {}, payerId: null, setPayerId: () => {},
    ...over,
  };
}

/** What the engine would store for a given set of inputs. */
function sharesFor(mode: SplitEditorState["mode"], ids: string[], inputs: Record<string, string>, total: number, payer: string | null = null) {
  const weighted = mode === "PERCENT" || mode === "RATIO";
  return computeSplitPreview(total, {
    mode, participantIds: ids, payerParticipantId: payer,
    exactAmounts: mode === "EXACT" ? Object.fromEntries(ids.map((id) => [id, Math.round((Number(inputs[id]) || 0) * 100)])) : undefined,
    weights: weighted ? Object.fromEntries(["me", ...ids].map((k) => [k, Number(inputs[k]) || 0])) : undefined,
  });
}

describe("redistributing when one share is edited", () => {
  const ids = [A, B, C];

  // ── EXACT ────────────────────────────────────────────────────────────────
  it("EXACT: raising one friend lowers the others, and the owner's share holds", () => {
    // 250 each across owner + 3 friends. The owner's derived share is 250.
    const st = state({ mode: "EXACT", exact: { [A]: "250", [B]: "250", [C]: "250" } });
    const out = redistributeOnEdit(rup(1000), st, ids, A, "500")!;
    expect(out.exact![A]).toBe("500");           // the user's number wins
    expect(Number(out.exact![B]) + Number(out.exact![C])).toBe(250); // others gave up 250
    // The owner still derives 250, and the engine still totals exactly.
    const p = sharesFor("EXACT", ids, out.exact!, rup(1000));
    expect(p.rows.find((r) => r.participantId === null)!.owedAmount).toBe(rup(250));
    expect(p.total).toBe(rup(1000));
    expect(p.balances).toBe(true);
  });

  it("EXACT: an unequal split keeps its proportions", () => {
    // Friends 500 / 300 / 200; the owner derives 0.
    const st = state({ mode: "EXACT", exact: { [A]: "500", [B]: "300", [C]: "200" } });
    const out = redistributeOnEdit(rup(1000), st, ids, B, "500")!;
    expect(out.exact![B]).toBe("500");
    // A and C shared 500:200 before, so they split the remaining 500 that way.
    expect(Number(out.exact![A])).toBeCloseTo(357.14, 1);
    expect(Number(out.exact![C])).toBeCloseTo(142.86, 1);
    expect(Number(out.exact![A]) + Number(out.exact![B]) + Number(out.exact![C])).toBeCloseTo(1000, 1);
  });

  it("EXACT: the paise always land exactly, never a rupee out", () => {
    const st = state({ mode: "EXACT", exact: { [A]: "333.33", [B]: "333.33", [C]: "333.34" } });
    const out = redistributeOnEdit(rup(1000), st, ids, A, "500")!;
    const paise = ids.reduce((t, id) => t + Math.round(Number(out.exact![id]) * 100), 0);
    expect(paise).toBe(rup(1000));
  });

  it("EXACT: overshooting the total clamps the others at zero rather than going negative", () => {
    const st = state({ mode: "EXACT", exact: { [A]: "250", [B]: "250", [C]: "250" } });
    const out = redistributeOnEdit(rup(1000), st, ids, A, "5000")!;
    expect(out.exact![B]).toBe("0");
    expect(out.exact![C]).toBe("0");
    // The engine is still the judge: this one genuinely exceeds the total.
    expect(sharesFor("EXACT", ids, out.exact!, rup(1000)).error).toBeTruthy();
  });

  it("EXACT: stating your own share scales the friends into what is left", () => {
    // There is no exactAmounts key for the owner — splitExact derives it — so
    // "I put in ₹100" has to become "the friends add up to ₹900".
    const st = state({ mode: "EXACT", exact: { [A]: "250", [B]: "250", [C]: "250" } });
    const out = redistributeOnEdit(rup(1000), st, ids, "me", "100")!;
    const friends = ids.reduce((t, id) => t + Math.round(Number(out.exact![id]) * 100), 0);
    expect(friends).toBe(rup(900));
    // And the engine derives exactly the figure that was asked for.
    const p = sharesFor("EXACT", ids, out.exact!, rup(1000));
    expect(p.rows.find((r) => r.participantId === null)!.owedAmount).toBe(rup(100));
    expect(p.total).toBe(rup(1000));
    expect(p.balances).toBe(true);
  });

  it("EXACT: your share keeps the friends' proportions", () => {
    // Friends at 500:300:200 keep that shape while shrinking into ₹800.
    const st = state({ mode: "EXACT", exact: { [A]: "500", [B]: "300", [C]: "200" } });
    const out = redistributeOnEdit(rup(1000), st, ids, "me", "200")!;
    expect(Number(out.exact![A])).toBeCloseTo(400, 1);
    expect(Number(out.exact![B])).toBeCloseTo(240, 1);
    expect(Number(out.exact![C])).toBeCloseTo(160, 1);
    expect(sharesFor("EXACT", ids, out.exact!, rup(1000)).rows.find((r) => r.participantId === null)!.owedAmount).toBe(rup(200));
  });

  it("EXACT: taking the whole amount yourself leaves the friends at zero", () => {
    const st = state({ mode: "EXACT", exact: { [A]: "250", [B]: "250", [C]: "250" } });
    const out = redistributeOnEdit(rup(1000), st, ids, "me", "1000")!;
    expect(ids.every((id) => Number(out.exact![id]) === 0)).toBe(true);
  });

  // ── PERCENT ──────────────────────────────────────────────────────────────
  it("PERCENT: raising one to 50 pulls the rest into the remaining 50", () => {
    const st = state({ mode: "PERCENT", weights: { me: "25", [A]: "25", [B]: "25", [C]: "25" } });
    const out = redistributeOnEdit(rup(1000), st, ids, A, "50")!;
    expect(out.weights![A]).toBe("50");
    const rest = ["me", B, C].reduce((t, k) => t + Number(out.weights![k]), 0);
    expect(rest).toBeCloseTo(50, 2);
    expect(["me", A, B, C].reduce((t, k) => t + Number(out.weights![k]), 0)).toBeCloseTo(100, 2);
  });

  it("PERCENT: an unequal split redistributes in proportion, not evenly", () => {
    // Owner 0, A 50, B 30, C 20 → change B to 50; A:C were 50:20.
    const st = state({ mode: "PERCENT", weights: { me: "0", [A]: "50", [B]: "30", [C]: "20" } });
    const out = redistributeOnEdit(rup(1000), st, ids, B, "50")!;
    expect(out.weights![B]).toBe("50");
    expect(Number(out.weights![A])).toBeCloseTo(35.71, 1);
    expect(Number(out.weights![C])).toBeCloseTo(14.29, 1);
  });

  it("PERCENT: the result still totals the amount through the engine", () => {
    const st = state({ mode: "PERCENT", weights: { me: "25", [A]: "25", [B]: "25", [C]: "25" } });
    const out = redistributeOnEdit(rup(1000), st, ids, A, "50")!;
    const p = sharesFor("PERCENT", ids, out.weights!, rup(1000));
    expect(p.total).toBe(rup(1000));
    expect(p.balances).toBe(true);
    expect(p.rows.find((r) => r.participantId === A)!.owedAmount).toBe(rup(500));
  });

  it("PERCENT: editing the owner's own weight works the same way", () => {
    const st = state({ mode: "PERCENT", weights: { me: "25", [A]: "25", [B]: "25", [C]: "25" } });
    const out = redistributeOnEdit(rup(1000), st, ids, "me", "40")!;
    expect(out.weights!.me).toBe("40");
    expect([A, B, C].reduce((t, k) => t + Number(out.weights![k]), 0)).toBeCloseTo(60, 2);
  });

  it("PERCENT: 100 to one person leaves the others at zero", () => {
    const st = state({ mode: "PERCENT", weights: { me: "25", [A]: "25", [B]: "25", [C]: "25" } });
    const out = redistributeOnEdit(rup(1000), st, ids, A, "100")!;
    expect(["me", B, C].every((k) => Number(out.weights![k]) === 0)).toBe(true);
  });

  // ── the modes that deliberately do nothing ──────────────────────────────
  it("RATIO is left alone — relative weights are already meaningful", () => {
    // 1/1/2 → 2/1/2 is a real instruction, and the engine still totals exactly.
    // Rewriting the other numbers would be the surprising behaviour.
    const st = state({ mode: "RATIO", weights: { me: "0", [A]: "1", [B]: "1", [C]: "2" } });
    expect(redistributeOnEdit(rup(1000), st, ids, A, "2")).toBeNull();
  });

  it("EQUAL has no inputs to redistribute", () => {
    expect(redistributeOnEdit(rup(1000), state({ mode: "EQUAL" }), ids, A, "5")).toBeNull();
  });

  it("a nonsense entry is refused rather than spread around", () => {
    const st = state({ mode: "PERCENT", weights: { me: "25", [A]: "25", [B]: "25", [C]: "25" } });
    expect(redistributeOnEdit(rup(1000), st, ids, A, "abc")).toBeNull();
    expect(redistributeOnEdit(rup(1000), st, ids, A, "-5")).toBeNull();
  });

  it("nobody selected means nothing to redistribute", () => {
    expect(redistributeOnEdit(rup(1000), state({ mode: "PERCENT" }), [], A, "50")).toBeNull();
  });

  // ── the payer's remainder is the engine's business, not this helper's ────
  it("a friend paying does not change who absorbs the remainder", () => {
    const st = state({ mode: "PERCENT", weights: { me: "33.33", [A]: "33.33", [B]: "33.34" }, payerId: A });
    const out = redistributeOnEdit(rup(10), st, [A, B], "me", "50")!;
    const p = sharesFor("PERCENT", [A, B], out.weights!, rup(10), A);
    expect(p.total).toBe(rup(10));
    // A paid, so A carries the odd paise the floor division could not place.
    expect(p.remainder).toBeGreaterThanOrEqual(0);
    expect(p.rows.find((r) => r.participantId === A)!.isPayer).toBe(true);
  });
});

// ── entering a distribution field by field ────────────────────────────────
//
// Redistribution across EVERY other field made sequential entry impossible:
// each number quietly rewrote the ones before it, so 40 / 30 / 20 / 10 typed
// in that order landed on 36.81 / 31.52 / 21.67 / 10 — three of the reader's
// four numbers replaced without a word.
//
// `touched` is the fix and it is UI-only: fields the reader has set are left
// alone, and only the ones nobody has claimed absorb the difference.
describe("percentages entered one at a time", () => {
  const ids = [A, B, C];
  const start = { me: "25", [A]: "25", [B]: "25", [C]: "25" };

  it("40 / 30 / 20 typed in order arrives at 40 / 30 / 20 / 10", () => {
    const touched = new Set<string>();
    let weights: Record<string, string> = { ...start };
    const enter = (key: string, value: string) => {
      const st = state({ mode: "PERCENT", weights });
      weights = { ...redistributeOnEdit(rup(1000), st, ids, key, value, touched)!.weights! };
      touched.add(key);
    };

    enter("me", "40");
    expect(weights).toEqual({ me: "40", [A]: "20", [B]: "20", [C]: "20" });
    enter(A, "30");
    expect(weights).toEqual({ me: "40", [A]: "30", [B]: "15", [C]: "15" });
    enter(B, "20");
    expect(weights).toEqual({ me: "40", [A]: "30", [B]: "20", [C]: "10" });
    // The one nobody claimed took the balance, and it comes to 100.
    expect(["me", A, B, C].reduce((t, k) => t + Number(weights[k]), 0)).toBe(100);
  });

  it("a claimed field is never rewritten to make room", () => {
    const touched = new Set([A]);
    const st = state({ mode: "PERCENT", weights: { me: "25", [A]: "40", [B]: "20", [C]: "15" } });
    const out = redistributeOnEdit(rup(1000), st, ids, "me", "50", touched)!.weights!;
    expect(out[A]).toBe("40"); // untouched by the redistribution, because it was touched by the reader
    expect(Number(out[B]) + Number(out[C])).toBeCloseTo(10, 2);
  });

  it("when everyone is spoken for, nothing moves and the total is allowed to overshoot", () => {
    // 60 / 30 / 20 in the audit's example. Silently fixing one of these would
    // be changing a number the reader deliberately entered.
    const touched = new Set(["me", A, B, C]);
    const st = state({ mode: "PERCENT", weights: { me: "25", [A]: "30", [B]: "20", [C]: "25" } });
    const out = redistributeOnEdit(rup(1000), st, ids, "me", "60", touched)!.weights!;
    expect(out).toEqual({ me: "60", [A]: "30", [B]: "20", [C]: "25" });
    // splitInputProblem is what tells the reader; see split-member-add.test.ts.
    expect(["me", A, B, C].reduce((t, k) => t + Number(out[k]), 0)).toBeGreaterThan(100);
  });

  it("an over-allocation leaves the free fields alone rather than going negative", () => {
    const touched = new Set([A]);
    const st = state({ mode: "PERCENT", weights: { me: "25", [A]: "90", [B]: "20", [C]: "15" } });
    const out = redistributeOnEdit(rup(1000), st, ids, "me", "50", touched)!.weights!;
    expect(out.me).toBe("50");
    expect(out[A]).toBe("90");
    expect(Number(out[B])).toBeGreaterThanOrEqual(0);
    expect(Number(out[C])).toBeGreaterThanOrEqual(0);
  });

  it("no touched fields is the original behaviour, unchanged", () => {
    const st = state({ mode: "PERCENT", weights: start });
    const withOut = redistributeOnEdit(rup(1000), st, ids, A, "50")!.weights!;
    const withEmpty = redistributeOnEdit(rup(1000), st, ids, A, "50", new Set())!.weights!;
    expect(withOut).toEqual(withEmpty);
    // The rounding drift lands on the largest share, which is why "me" carries
    // the extra two hundredths rather than it being lost.
    expect(withOut).toEqual({ me: "16.68", [A]: "50", [B]: "16.66", [C]: "16.66" });
  });
});

// ── entering exact amounts one at a time ──────────────────────────────────
//
// The same complaint Percent had, in rupees. Redistribution moved every other
// friend, so ₹400 / ₹300 / ₹200 / ₹100 typed in that order never arrived —
// each entry rewrote the ones before it. `touched` composes with EXACT's own
// rule (the friends' total holds steady, which is what keeps the owner's
// derived share where it is) rather than replacing it: the pool the unclaimed
// friends share is simply what is left of that total.
describe("exact amounts entered one at a time", () => {
  const ids = [A, B, C];

  it("₹400 / ₹300 / ₹200 typed in order arrives at 400 / 300 / 200 / 100", () => {
    // ₹1,000 seeded equally: the owner and three friends on ₹250 each.
    const touched = new Set<string>();
    let exact: Record<string, string> = { me: "250", [A]: "250", [B]: "250", [C]: "250" };
    const enter = (key: string, value: string) => {
      const st = state({ mode: "EXACT", exact });
      exact = { ...redistributeOnEdit(rup(1000), st, ids, key, value, touched)!.exact! };
      touched.add(key);
    };

    // The owner's own field first — it is an instruction about what the
    // friends must come to, and every one of them is still unclaimed.
    enter("me", "400");
    expect([A, B, C].reduce((t, k) => t + Number(exact[k]), 0)).toBe(600);

    enter(A, "300");
    expect(exact[A]).toBe("300");
    enter(B, "200");
    expect(exact[B]).toBe("200");

    // What the reader asked for, and C — never touched — carries the balance.
    expect(exact.me).toBe("400");
    expect(exact[A]).toBe("300");
    expect(exact[B]).toBe("200");
    expect(Number(exact[C])).toBe(100);

    // And the engine agrees, to the paise.
    const p = computeSplitPreview(rup(1000), {
      mode: "EXACT", participantIds: ids, payerParticipantId: null,
      exactAmounts: Object.fromEntries(["me", ...ids].map((k) => [k, Math.round(Number(exact[k]) * 100)])),
    });
    expect(p.rows.find((r) => r.participantId === null)!.owedAmount).toBe(rup(400));
    expect(p.total).toBe(rup(1000));
    expect(p.balances).toBe(true);
  });

  it("a friend the reader has already set is not moved again", () => {
    const st = state({ mode: "EXACT", exact: { [A]: "500", [B]: "300", [C]: "200" } });
    const out = redistributeOnEdit(rup(1000), st, ids, C, "100", new Set([A]))!.exact!;
    expect(out[A]).toBe("500");   // claimed
    expect(out[C]).toBe("100");   // just entered
    expect(Number(out[B])).toBe(400); // the only one free absorbs the difference
    expect([A, B, C].reduce((t, k) => t + Number(out[k]), 0)).toBe(1000);
  });

  it("the owner's derived share is still held steady while friends move", () => {
    // Friends total 750, so the owner derives 250 — and keeps it.
    const st = state({ mode: "EXACT", exact: { me: "250", [A]: "250", [B]: "250", [C]: "250" } });
    const out = redistributeOnEdit(rup(1000), st, ids, A, "400", new Set())!.exact!;
    expect([A, B, C].reduce((t, k) => t + Number(out[k]), 0)).toBe(750);
    const p = computeSplitPreview(rup(1000), {
      mode: "EXACT", participantIds: ids, payerParticipantId: null,
      exactAmounts: Object.fromEntries(ids.map((k) => [k, Math.round(Number(out[k]) * 100)])),
    });
    expect(p.rows.find((r) => r.participantId === null)!.owedAmount).toBe(rup(250));
  });

  it("when everyone is spoken for, nothing the reader typed is rewritten", () => {
    const touched = new Set([A, B, C]);
    const st = state({ mode: "EXACT", exact: { [A]: "250", [B]: "250", [C]: "250" } });
    const out = redistributeOnEdit(rup(1000), st, ids, A, "900", touched)!.exact!;
    expect(out).toEqual({ [A]: "900", [B]: "250", [C]: "250" });
  });

  it("and an overshoot is reported by the engine rather than hidden", () => {
    // The state the test above leaves behind: ₹1,400 stated against ₹1,000.
    const p = computeSplitPreview(rup(1000), {
      mode: "EXACT", participantIds: ids, payerParticipantId: null,
      exactAmounts: { [A]: rup(900), [B]: rup(250), [C]: rup(250) },
    });
    expect(p.error).toBe("Split amounts exceed the total");
    expect(p.balances).toBe(false);
  });

  it("no touched fields is the original behaviour, unchanged", () => {
    const st = state({ mode: "EXACT", exact: { [A]: "250", [B]: "250", [C]: "250" } });
    const withOut = redistributeOnEdit(rup(1000), st, ids, A, "500")!.exact!;
    const withEmpty = redistributeOnEdit(rup(1000), st, ids, A, "500", new Set())!.exact!;
    expect(withOut).toEqual(withEmpty);
    expect(Number(withOut[B]) + Number(withOut[C])).toBe(250);
  });

  it("editing your own share still moves every friend, claimed or not", () => {
    // That field is a derived display when the owner pays, so it has to be
    // honoured immediately or the figure shown contradicts the figure typed.
    const st = state({ mode: "EXACT", exact: { me: "250", [A]: "250", [B]: "250", [C]: "250" } });
    const out = redistributeOnEdit(rup(1000), st, ids, "me", "100", new Set([A, B, C]))!.exact!;
    expect(out.me).toBe("100");
    expect([A, B, C].reduce((t, k) => t + Math.round(Number(out[k]) * 100), 0)).toBe(rup(900));
  });
});

// ── the state a real blur actually carries ────────────────────────────────
//
// Every test above hands redistributeOnEdit a state in which the edited field
// still holds its OLD value. No event in the app ever looks like that: the
// friend inputs are controlled, onChange commits each keystroke, so by the
// time onBlur runs `state.exact[editedKey]` is already the new number.
//
// That gap hid a bug for the whole life of the feature. Deriving the pool as
// `friends' total − edited` then cancelled out — the other friends were spread
// onto their own current values and never moved — and the difference came
// silently out of the owner's derived share instead. Measured in the browser:
// ₹1,000 four ways, typing ₹300 against one friend left the other two on ₹250
// and dropped the owner from ₹250 to ₹200.
//
// These pass the state the way the DOM does.
describe("the state a blur actually carries: the edited field already updated", () => {
  const ids = [A, B, C];

  /** What onBlur really sees: onChange has already written the new value. */
  const asCommitted = (exact: Record<string, string>, key: string, value: string) => ({ ...exact, [key]: value });

  it("the other friends still move — the difference does not fall on the owner", () => {
    const seeded = { me: "250", [A]: "250", [B]: "250", [C]: "250" };
    const st = state({ mode: "EXACT", exact: asCommitted(seeded, A, "300") });
    const out = redistributeOnEdit(rup(1000), st, ids, A, "300", new Set())!.exact!;
    expect(out[A]).toBe("300");
    // B and C give up the ₹50 between them, so the friends still hold ₹750...
    expect([A, B, C].reduce((t, k) => t + Math.round(Number(out[k]) * 100), 0)).toBe(rup(750));
    // ...and the owner keeps the ₹250 they were on.
    const p = computeSplitPreview(rup(1000), {
      mode: "EXACT", participantIds: ids, payerParticipantId: null,
      exactAmounts: Object.fromEntries(ids.map((k) => [k, Math.round(Number(out[k]) * 100)])),
    });
    expect(p.rows.find((r) => r.participantId === null)!.owedAmount).toBe(rup(250));
    expect(p.total).toBe(rup(1000));
  });

  it("the whole sequence arrives, committed the way the DOM commits it", () => {
    const touched = new Set<string>();
    let exact: Record<string, string> = { me: "250", [A]: "250", [B]: "250", [C]: "250" };
    const enter = (key: string, value: string) => {
      // The owner's field is uncontrolled, so only a friend's arrives updated.
      const committed = key === "me" ? exact : asCommitted(exact, key, value);
      exact = { ...redistributeOnEdit(rup(1000), state({ mode: "EXACT", exact: committed }), ids, key, value, touched)!.exact! };
      touched.add(key);
    };
    enter("me", "400");
    enter(A, "300");
    enter(B, "200");
    expect(exact.me).toBe("400");
    expect(exact[A]).toBe("300");
    expect(exact[B]).toBe("200");
    expect(Number(exact[C])).toBe(100);
  });

  it("a friend paying reaches the same numbers", () => {
    const touched = new Set<string>();
    let exact: Record<string, string> = { me: "250", [A]: "250", [B]: "250", [C]: "250" };
    const enter = (key: string, value: string) => {
      exact = { ...redistributeOnEdit(rup(1000), state({ mode: "EXACT", exact: asCommitted(exact, key, value), payerId: A }), ids, key, value, touched)!.exact! };
      touched.add(key);
    };
    enter(B, "200");
    enter(C, "100");
    // A paid, so their share is what is left once everyone else is stated.
    const p = computeSplitPreview(rup(1000), {
      mode: "EXACT", participantIds: ids, payerParticipantId: A,
      exactAmounts: Object.fromEntries(["me", ...ids].map((k) => [k, Math.round(Number(exact[k]) * 100)])),
    });
    const owed = Object.fromEntries(p.rows.map((r) => [r.participantId ?? "me", r.owedAmount]));
    expect(owed.me).toBe(rup(250));
    expect(owed[B]).toBe(rup(200));
    expect(owed[C]).toBe(rup(100));
    expect(owed[A]).toBe(rup(450));
    expect(p.total).toBe(rup(1000));
  });

  it("a payload with no owner key still balances against the amount", () => {
    // Nothing has seeded "me" — the owner's share is the balance, and the
    // friends move around it exactly as they did before.
    const st = state({ mode: "EXACT", exact: { [A]: "500", [B]: "250", [C]: "250" } });
    const out = redistributeOnEdit(rup(1000), st, ids, A, "500", new Set())!.exact!;
    expect([A, B, C].reduce((t, k) => t + Math.round(Number(out[k]) * 100), 0)).toBe(rup(1000));
  });
});
