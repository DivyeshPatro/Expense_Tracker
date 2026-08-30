// The keypad's editing rules, and what an amount display shows mid-sum.
//
// The parser in expression.ts was already complete and tested — precedence,
// brackets, percent, division by zero, overflow, single-rounding. What did not
// exist was a way to BUILD one of its strings from a grid of keys without a
// caret. These two functions are that, and the states they must make
// unreachable are the ones that would otherwise reach the parser as garbage.

import { describe, expect, it } from "vitest";
import { evaluateAmount, partialAmount, pressAmountKey } from "./expression";

/** Tap a sequence of keys from empty, the way a thumb would. */
const tap = (...keys: string[]) => keys.reduce((s, k) => pressAmountKey(s, k), "");

describe("building an amount from keypad taps", () => {
  it("types a plain number", () => {
    expect(tap("5", "0", "0")).toBe("500");
  });

  it("keeps a sum as a sum", () => {
    expect(tap("5", "0", "0", "+", "2", "5", "0")).toBe("500+250");
  });

  it("chains operators without ever doubling one", () => {
    expect(tap("5", "0", "0", "+", "+")).toBe("500+");
    expect(tap("5", "0", "0", "+", "×")).toBe("500×");
    expect(tap("5", "0", "0", "+", "-", "÷")).toBe("500÷");
  });

  it("refuses to start with an operator", () => {
    expect(tap("+")).toBe("");
    expect(tap("÷", "5")).toBe("5");
  });

  it("allows a trailing operator while the next number is still coming", () => {
    // "500+" is what the string looks like between two taps. It is not valid,
    // and evaluateAmount says so — which is exactly why saving is gated on it.
    expect(evaluateAmount("500+").ok).toBe(false);
  });

  // ── zeros ────────────────────────────────────────────────────────────────
  it("has no leading zeros", () => {
    expect(tap("0", "0", "0")).toBe("0");
    expect(tap("0", "5")).toBe("5");
    expect(tap("0", "0", "7")).toBe("7");
  });

  it("treats the double zero as a real 00 only after a real digit", () => {
    expect(tap("1", "2", "00")).toBe("1200");
    expect(tap("00")).toBe("0");
    expect(tap("0", "00")).toBe("0");
  });

  it("applies the zero rule per operand, not per string", () => {
    expect(tap("5", "0", "0", "+", "0", "9")).toBe("500+9");
    expect(tap("5", "0", "0", "×", "0")).toBe("500×0");
  });

  // ── decimals ─────────────────────────────────────────────────────────────
  it("takes one decimal point per operand", () => {
    expect(tap("1", ".", "5", ".", "2")).toBe("1.52");
    expect(tap("1", ".", "5", "+", "2", ".", "5")).toBe("1.5+2.5");
  });

  it("opens a bare point with a zero", () => {
    expect(tap(".", "5")).toBe("0.5");
    expect(tap("1", "0", "+", ".", "5")).toBe("10+0.5");
  });

  it("stops at two decimal places, because money has two", () => {
    expect(tap("1", ".", "2", "3", "4")).toBe("1.23");
    expect(tap("1", ".", "0", "0", "0")).toBe("1.00");
  });

  it("a double zero fills only the room that is left", () => {
    expect(tap("1", ".", "5", "00")).toBe("1.50");
  });

  // ── size ─────────────────────────────────────────────────────────────────
  it("caps the digits in any one operand", () => {
    const long = tap(...Array(14).fill("9"));
    expect(long).toBe("999999999");
    // …and the cap is per operand, so a sum can still be built.
    expect(pressAmountKey(long + "+", "7")).toBe("999999999+7");
  });

  // ── backspace and clear ──────────────────────────────────────────────────
  it("backspace removes one character, operators included", () => {
    expect(pressAmountKey("500+250", "back")).toBe("500+25");
    expect(pressAmountKey("500+", "back")).toBe("500");
    expect(pressAmountKey("", "back")).toBe("");
  });

  it("clear empties the whole thing", () => {
    expect(pressAmountKey("500+250×2", "clear")).toBe("");
  });

  it("ignores a key it does not know", () => {
    expect(pressAmountKey("500", "banana")).toBe("500");
    expect(pressAmountKey("500", "(")).toBe("500");
  });
});

describe("what the display reads while a sum is being typed", () => {
  it("shows the number itself when there is no arithmetic", () => {
    expect(partialAmount("500")).toBe(50000);
    expect(partialAmount("12.34")).toBe(1234);
  });

  it("shows the result once the sum is complete", () => {
    expect(partialAmount("500+250")).toBe(75000);
    expect(partialAmount("1000-250")).toBe(75000);
    expect(partialAmount("100×3")).toBe(30000);
    expect(partialAmount("1200÷4")).toBe(30000);
    expect(partialAmount("500+200-50")).toBe(65000);
  });

  it("holds the running total while an operator is trailing", () => {
    // The reader has to see the ₹500 they are adding to.
    expect(partialAmount("500+")).toBe(50000);
    expect(partialAmount("500+250-")).toBe(75000);
  });

  it("shows nothing for an entry with no number in it yet", () => {
    expect(partialAmount("")).toBe(0);
    expect(partialAmount("0")).toBe(0);
  });

  it("shows nothing rather than a guess when the sum cannot be read", () => {
    expect(partialAmount("1÷0")).toBe(0);
    expect(partialAmount("1.2.3")).toBe(0);
  });
});

describe("the money the keypad ultimately produces", () => {
  it("is integer paise, with float error resolved once at the end", () => {
    // 0.1 + 0.2 is the canonical float trap.
    const r = evaluateAmount(tap("0", ".", "1", "+", "0", ".", "2"));
    expect(r.ok && r.paise).toBe(30);
    expect(r.ok && r.paise).not.toBe(30.000000000000004);
  });

  it("survives a division that does not terminate", () => {
    const r = evaluateAmount(tap("1", "0", "0", "0", "÷", "3"));
    expect(r.ok && r.paise).toBe(33333);
  });

  it("refuses a sum that comes out at zero or below", () => {
    expect(evaluateAmount("500-500").ok).toBe(false);
    expect(evaluateAmount("500-900").ok).toBe(false);
  });

  it("refuses division by zero", () => {
    const r = evaluateAmount(tap("5", "0", "0", "÷", "0"));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/divide by zero/i);
  });

  it("refuses an unfinished sum", () => {
    const r = evaluateAmount(tap("5", "0", "0", "+"));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/incomplete/i);
  });

  it("refuses an absurd figure", () => {
    expect(evaluateAmount("99999999×99999999").ok).toBe(false);
  });

  it("multiplies before adding, the way a calculator is expected to", () => {
    // Stated explicitly because it is a choice: the parser climbs precedence,
    // it does not evaluate left to right.
    expect(evaluateAmount("100+50×2").ok && evaluateAmount("100+50×2")).toMatchObject({ paise: 20000 });
  });
});
