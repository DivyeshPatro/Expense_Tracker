import { describe, expect, it } from "vitest";
import { formatPaise, splitByWeights, splitEqual, splitExact, toPaise } from "./money";

describe("toPaise", () => {
  it("parses rupee strings to integer paise", () => {
    expect(toPaise("2500")).toBe(250000);
    expect(toPaise("123.45")).toBe(12345);
    expect(toPaise("₹1,23,456")).toBe(12345600);
    expect(toPaise(0.1 + 0.2)).toBe(30); // float noise rounded away
  });
  it("rejects garbage", () => {
    expect(() => toPaise("abc")).toThrow();
  });
});

describe("formatPaise (en-IN)", () => {
  it("uses Indian digit grouping", () => {
    expect(formatPaise(12345600)).toBe("₹1,23,456");
    expect(formatPaise(250000)).toBe("₹2,500");
  });
  it("shows paise only when non-zero", () => {
    expect(formatPaise(33334)).toBe("₹333.34");
    expect(formatPaise(-250000)).toBe("₹2,500");
  });
});

describe("splitEqual — PRD §5 acceptance criteria", () => {
  it("₹2,500 ÷ 4 equal = ₹625 each", () => {
    const shares = splitEqual(250000, [null, "p1", "p2", "p3"], null);
    expect(shares.map((s) => s.owedAmount)).toEqual([62500, 62500, 62500, 62500]);
  });
  it("₹1,000 ÷ 3 equal: remainder paise go to the payer", () => {
    const shares = splitEqual(100000, [null, "p1", "p2"], null);
    expect(shares.find((s) => s.participantId === null)!.owedAmount).toBe(33334);
    expect(shares.filter((s) => s.participantId !== null).map((s) => s.owedAmount)).toEqual([33333, 33333]);
    expect(shares.reduce((s, x) => s + x.owedAmount, 0)).toBe(100000);
  });
  it("remainder goes to the payer even when payer is not the owner", () => {
    const shares = splitEqual(100000, [null, "p1", "p2"], "p2");
    expect(shares.find((s) => s.participantId === "p2")!.owedAmount).toBe(33334);
    expect(shares.reduce((s, x) => s + x.owedAmount, 0)).toBe(100000);
  });
  it("rejects a payer who is not a participant (exclude-participants case)", () => {
    expect(() => splitEqual(100000, ["p1", "p2"], null)).toThrow();
  });
});

describe("splitByWeights (percent / ratio)", () => {
  it("60/40 percent split sums exactly", () => {
    const shares = splitByWeights(99999, [{ participantId: null, weight: 60 }, { participantId: "p1", weight: 40 }], null);
    expect(shares.reduce((s, x) => s + x.owedAmount, 0)).toBe(99999);
    expect(shares.find((s) => s.participantId === "p1")!.owedAmount).toBe(39999);
  });
  it("2:1:1 ratio split sums exactly with remainder on payer", () => {
    const shares = splitByWeights(100001, [
      { participantId: null, weight: 2 },
      { participantId: "p1", weight: 1 },
      { participantId: "p2", weight: 1 },
    ], null);
    expect(shares.reduce((s, x) => s + x.owedAmount, 0)).toBe(100001);
    expect(shares.find((s) => s.participantId === "p1")!.owedAmount).toBe(25000);
  });
});

describe("splitExact", () => {
  it("payer absorbs the remainder", () => {
    const shares = splitExact(250000, [{ participantId: "p1", owedAmount: 100000 }], null);
    expect(shares.find((s) => s.participantId === null)!.owedAmount).toBe(150000);
  });
  it("rejects stated amounts exceeding the total", () => {
    expect(() => splitExact(1000, [{ participantId: "p1", owedAmount: 2000 }], null)).toThrow();
  });
});
