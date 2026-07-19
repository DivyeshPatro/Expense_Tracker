import { describe, expect, it } from "vitest";
import { accountSchema, paiseFromRupees } from "./index";

describe("paiseFromRupees", () => {
  it("parses a plain rupee string to paise", () => {
    expect(paiseFromRupees.parse("123.45")).toBe(12345);
  });
  it("strips currency symbol, commas, and whitespace", () => {
    expect(paiseFromRupees.parse("₹1,234.56")).toBe(123456);
    expect(paiseFromRupees.parse(" 100 ")).toBe(10000);
  });
  it("accepts a plain number", () => {
    expect(paiseFromRupees.parse(50)).toBe(5000);
  });
  it("rejects zero and negative amounts", () => {
    expect(() => paiseFromRupees.parse("0")).toThrow();
    expect(() => paiseFromRupees.parse("-5")).toThrow();
  });
  it("rejects non-numeric input", () => {
    expect(() => paiseFromRupees.parse("abc")).toThrow();
  });
});

describe("accountSchema.openingBalance", () => {
  const parse = (openingBalance: unknown) => accountSchema.parse({ name: "Test", type: "BANK", openingBalance }).openingBalance;

  it("parses a plain rupee string to paise", () => {
    expect(parse("500")).toBe(50000);
  });
  it("strips currency symbol and commas", () => {
    expect(parse("₹1,234.56")).toBe(123456);
  });
  it("defaults an empty string to 0", () => {
    expect(parse("")).toBe(0);
  });
  it("allows negative balances (credit cards)", () => {
    expect(parse("-1500")).toBe(-150000);
  });
  it("rejects non-numeric input", () => {
    expect(() => accountSchema.parse({ name: "Test", type: "BANK", openingBalance: "abc" })).toThrow();
  });
});
