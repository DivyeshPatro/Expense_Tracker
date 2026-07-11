import { describe, expect, it } from "vitest";
import { describeQuery, parseQuery, type ParserContext } from "./search-parser";

const ctx: ParserContext = {
  merchants: ["Swiggy", "BigBasket", "Rent · Flat 402", "Salary · Acme Corp"],
  categories: [
    { name: "Food", kind: "EXPENSE" },
    { name: "Travel", kind: "EXPENSE" },
    { name: "Salary", kind: "INCOME" },
    { name: "Misc", kind: "EXPENSE" },
  ],
  accounts: [
    { id: "a1", name: "HDFC Savings", type: "BANK" },
    { id: "a4", name: "PhonePe", type: "WALLET" },
  ],
  now: new Date("2026-07-10T12:00:00+05:30"),
};

describe("deterministic search parser (PRD §4.7)", () => {
  it("parses 'swiggy in march'", () => {
    const p = parseQuery("swiggy in march", ctx);
    expect(p.merchant).toBe("Swiggy");
    expect(p.monthKey).toBe("2026-03");
    expect(p.type).toBe("EXPENSE");
    expect(p.matched).toBe(true);
  });

  it("parses 'upi expenses' as wallet account type", () => {
    const p = parseQuery("upi expenses", ctx);
    expect(p.accountType).toBe("WALLET");
    expect(p.type).toBe("EXPENSE");
  });

  it("parses 'income in june'", () => {
    const p = parseQuery("income in june", ctx);
    expect(p.type).toBe("INCOME");
    expect(p.monthKey).toBe("2026-06");
  });

  it("months after the current one refer to last year", () => {
    expect(parseQuery("spent in december", ctx).monthKey).toBe("2025-12");
  });

  it("parses relative months and amount ranges", () => {
    const p = parseQuery("food above ₹500 last month", ctx);
    expect(p.category).toBe("Food");
    expect(p.monthKey).toBe("2026-06");
    expect(p.minPaise).toBe(50000);
  });

  it("matches accounts by name word", () => {
    expect(parseQuery("hdfc spends", ctx).accountId).toBe("a1");
  });

  it("flags unparseable queries for full-text fallback (never an error)", () => {
    expect(parseQuery("random gibberish zzz", ctx).matched).toBe(false);
  });

  it("describes results in plain language", () => {
    const p = parseQuery("swiggy in march", ctx);
    expect(describeQuery(p, "₹1,240", 3)).toBe("You spent ₹1,240 on Swiggy in March · 3 transactions");
  });

  describe("explicit years — for imported history that predates the current year", () => {
    it("parses 'food in march 2023' with the exact year, not the current-year default", () => {
      const p = parseQuery("food in march 2023", ctx);
      expect(p.monthKey).toBe("2023-03");
      expect(p.category).toBe("Food");
      expect(p.yearIsExplicit).toBe(true);
    });

    it("echoes the year in the answer only when it was explicitly given", () => {
      const explicit = parseQuery("food in march 2023", ctx);
      expect(describeQuery(explicit, "₹500", 2)).toBe("You spent ₹500 on Food in March 2023 · 2 transactions");
      const implicit = parseQuery("food in march", ctx);
      expect(describeQuery(implicit, "₹500", 2)).toBe("You spent ₹500 on Food in March · 2 transactions");
    });

    it("parses a bare year with no month ('expenses in 2023')", () => {
      const p = parseQuery("expenses in 2023", ctx);
      expect(p.yearKey).toBe("2023");
      expect(p.monthKey).toBeNull();
      expect(p.matched).toBe(true);
      expect(describeQuery(p, "₹12,000", 18)).toBe("You spent ₹12,000 in 2023 · 18 transactions");
    });
  });
});
