import { describe, expect, it } from "vitest";
import { parseFlexibleAmount, parseFlexibleDate } from "./parse-value";

describe("parseFlexibleDate", () => {
  it("parses ISO dates", () => {
    expect(parseFlexibleDate("2026-07-10")).toBe("2026-07-10");
  });
  it("parses DD/MM/YYYY (Indian default)", () => {
    expect(parseFlexibleDate("10/07/2026")).toBe("2026-07-10");
  });
  it("swaps to MM/DD/YYYY when the first component can't be a day", () => {
    // 07/25/2026: "25" can't be a month, so this must be MM/DD, not DD/MM
    expect(parseFlexibleDate("07/25/2026")).toBe("2026-07-25");
    expect(parseFlexibleDate("13/45/2026")).toBeNull(); // invalid either way
  });
  it("parses 'DD Mon YYYY' and 'Mon DD, YYYY'", () => {
    expect(parseFlexibleDate("10 Jul 2026")).toBe("2026-07-10");
    expect(parseFlexibleDate("Jul 10, 2026")).toBe("2026-07-10");
  });
  it("parses a Date object using UTC calendar fields (xlsx cellDates)", () => {
    expect(parseFlexibleDate(new Date(Date.UTC(2026, 6, 10)))).toBe("2026-07-10");
  });
  it("parses an Excel serial date number", () => {
    const serial = (Date.UTC(2026, 6, 10) - Date.UTC(1899, 11, 30)) / 86400000;
    expect(parseFlexibleDate(serial)).toBe("2026-07-10");
  });
  it("returns null for garbage", () => {
    expect(parseFlexibleDate("not a date")).toBeNull();
    expect(parseFlexibleDate("")).toBeNull();
  });
});

describe("parseFlexibleAmount", () => {
  it("parses plain numbers", () => {
    expect(parseFlexibleAmount(420)).toEqual({ paise: 42000, negative: false });
    expect(parseFlexibleAmount(-420)).toEqual({ paise: 42000, negative: true });
  });
  it("strips currency symbols and thousands separators", () => {
    expect(parseFlexibleAmount("₹1,23,456.78")).toEqual({ paise: 12345678, negative: false });
    expect(parseFlexibleAmount("Rs. 500")).toEqual({ paise: 50000, negative: false });
    expect(parseFlexibleAmount("INR 500")).toEqual({ paise: 50000, negative: false });
  });
  it("treats parentheses as negative (accounting notation)", () => {
    expect(parseFlexibleAmount("(500.00)")).toEqual({ paise: 50000, negative: true });
  });
  it("treats a Dr suffix as negative and Cr as positive", () => {
    expect(parseFlexibleAmount("500.00 Dr")).toEqual({ paise: 50000, negative: true });
    expect(parseFlexibleAmount("500.00 Cr")).toEqual({ paise: 50000, negative: false });
  });
  it("returns null for unparseable text", () => {
    expect(parseFlexibleAmount("N/A")).toBeNull();
    expect(parseFlexibleAmount("")).toBeNull();
  });
});
