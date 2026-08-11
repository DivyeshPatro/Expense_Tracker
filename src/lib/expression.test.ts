import { describe, expect, it } from "vitest";
import { evaluateAmount, looksLikeExpression } from "./expression";

/** Convenience: assert a successful parse in rupees. */
function rupees(input: string): number {
  const r = evaluateAmount(input);
  if (!r.ok) throw new Error(`expected success for "${input}", got: ${r.error}`);
  return r.paise / 100;
}

function errorFor(input: string): string {
  const r = evaluateAmount(input);
  if (r.ok) throw new Error(`expected failure for "${input}", got ${r.paise}`);
  return r.error;
}

describe("plain amounts still behave exactly as before", () => {
  it("parses integers and decimals", () => {
    expect(rupees("2500")).toBe(2500);
    expect(rupees("123.45")).toBe(123.45);
    expect(rupees(".5")).toBe(0.5);
  });
  it("tolerates the formatting people paste in", () => {
    expect(rupees("₹1,23,456")).toBe(123456);
    expect(rupees("  420  ")).toBe(420);
  });
  it("marks a plain number as not an expression", () => {
    const r = evaluateAmount("2500");
    expect(r.ok && r.isExpression).toBe(false);
  });
});

describe("the cases from the brief", () => {
  it.each([
    ["250+350", 600],
    ["1200-150", 1050],
    ["500*3", 1500],
    ["2500/5", 500],
    ["2500*18%", 450],
    ["(250+350)*2", 1200],
  ])("%s = %i", (input, expected) => {
    expect(rupees(input)).toBe(expected);
  });
});

describe("operator precedence and grouping", () => {
  it("multiplies before adding", () => {
    expect(rupees("100+2*50")).toBe(200);
    expect(rupees("100-10/2")).toBe(95);
  });
  it("respects brackets, including nested ones", () => {
    expect(rupees("(100+2)*50")).toBe(5100);
    expect(rupees("((100+50)/3)*2")).toBe(100);
  });
  it("is left-associative for subtraction and division", () => {
    expect(rupees("100-20-30")).toBe(50);
    expect(rupees("1000/10/2")).toBe(50);
  });
  it("handles a leading unary minus inside an expression", () => {
    expect(rupees("500+-100")).toBe(400);
    expect(rupees("(-100)+500")).toBe(400);
  });
});

describe("percent is context-sensitive, the way calculators behave", () => {
  it("of, for multiply and divide", () => {
    expect(rupees("2500*18%")).toBe(450); // the GST amount
    expect(rupees("450/18%")).toBe(2500); // back to the base
  });
  it("relative to the left side, for plus and minus", () => {
    expect(rupees("2500+18%")).toBe(2950); // GST-inclusive total
    expect(rupees("2000-10%")).toBe(1800); // a 10% discount
  });
  it("is a plain hundredth with no context", () => {
    expect(rupees("1800%")).toBe(18);
  });
  it("composes with brackets", () => {
    expect(rupees("(1000+1000)+18%")).toBe(2360);
  });
});

describe("real entry patterns", () => {
  it("splits a bill", () => {
    expect(rupees("1847/3")).toBe(615.67); // rounds once, at the end
  });
  it("adds up a few items", () => {
    expect(rupees("120+80+45+260")).toBe(505);
  });
  it("accepts x and the phone-keyboard × ÷ symbols", () => {
    expect(rupees("12x5")).toBe(60);
    expect(rupees("12×5")).toBe(60);
    expect(rupees("60÷4")).toBe(15);
  });
  it("rounds to paise only once, so repeated division doesn't drift", () => {
    // 100/3 = 33.333… ; ×3 must come back to 100, not 99.99
    expect(rupees("100/3*3")).toBe(100);
  });
});

describe("invalid input is rejected with something readable", () => {
  it("rejects empty and whitespace", () => {
    expect(errorFor("")).toMatch(/enter an amount/i);
    expect(errorFor("   ")).toMatch(/enter an amount/i);
  });
  it("rejects incomplete expressions", () => {
    expect(errorFor("250+")).toMatch(/incomplete/i);
    expect(errorFor("*50")).toMatch(/incomplete/i);
  });
  it("rejects unbalanced brackets", () => {
    expect(errorFor("(250+350")).toMatch(/closing bracket/i);
    expect(errorFor("250+350)")).toMatch(/whole expression/i);
  });
  it("rejects letters and stray symbols", () => {
    expect(errorFor("abc")).toMatch(/isn't something I can calculate/i);
    expect(errorFor("250 & 350")).toMatch(/isn't something I can calculate/i);
  });
  it("rejects a malformed decimal", () => {
    expect(errorFor("1.2.3")).toMatch(/decimal point/i);
  });
  it("rejects division by zero rather than returning Infinity", () => {
    expect(errorFor("100/0")).toMatch(/divide by zero/i);
  });
  it("rejects zero and negative results — an expense needs a positive amount", () => {
    expect(errorFor("100-100")).toMatch(/above zero/i);
    expect(errorFor("100-500")).toMatch(/negative/i);
  });
  it("rejects absurd amounts and over-long input", () => {
    expect(errorFor("99999999999")).toMatch(/too large/i);
    expect(errorFor("1+".repeat(60) + "1")).toMatch(/too long/i);
  });
});

describe("cannot be used to execute anything", () => {
  // The whole reason this is a parser and not eval(). Each of these is a
  // valid JavaScript expression and must be rejected as an amount.
  it.each([
    "constructor",
    "process.exit(1)",
    "globalThis",
    "1;alert(1)",
    "[].constructor",
    "0x10",
    "1e400",
    "`${1}`",
  ])("rejects %s", (hostile) => {
    expect(evaluateAmount(hostile).ok).toBe(false);
  });
});

describe("looksLikeExpression", () => {
  it("is false for plain numbers", () => {
    expect(looksLikeExpression("2500")).toBe(false);
    expect(looksLikeExpression("123.45")).toBe(false);
  });
  it("is true when any operator is present", () => {
    expect(looksLikeExpression("250+350")).toBe(true);
    expect(looksLikeExpression("18%")).toBe(true);
    expect(looksLikeExpression("(1)")).toBe(true);
  });
});
