import { describe, expect, it } from "vitest";
import { DuplicateIndex, normalizeMerchant } from "./dedupe";

describe("normalizeMerchant", () => {
  it("case-folds and strips punctuation", () => {
    expect(normalizeMerchant("Swiggy - Order #123")).toBe("swiggy order 123");
  });
});

describe("DuplicateIndex", () => {
  const existing = [
    { ymd: "2026-07-10", amountPaise: 42000, merchant: "Swiggy" },
    { ymd: "2026-07-01", amountPaise: 120000, merchant: "Salary · Acme Corp" },
  ];

  it("flags an exact date+amount+merchant match", () => {
    const idx = new DuplicateIndex(existing);
    expect(idx.isDuplicate({ ymd: "2026-07-10", amountPaise: 42000, merchant: "Swiggy" })).toBe(true);
  });

  it("flags a match within ±1 day", () => {
    const idx = new DuplicateIndex(existing);
    expect(idx.isDuplicate({ ymd: "2026-07-09", amountPaise: 42000, merchant: "Swiggy" })).toBe(true);
    expect(idx.isDuplicate({ ymd: "2026-07-11", amountPaise: 42000, merchant: "Swiggy" })).toBe(true);
  });

  it("does not flag beyond the ±1 day window", () => {
    const idx = new DuplicateIndex(existing);
    expect(idx.isDuplicate({ ymd: "2026-07-13", amountPaise: 42000, merchant: "Swiggy" })).toBe(false);
  });

  it("does not flag a different amount or merchant", () => {
    const idx = new DuplicateIndex(existing);
    expect(idx.isDuplicate({ ymd: "2026-07-10", amountPaise: 50000, merchant: "Swiggy" })).toBe(false);
    expect(idx.isDuplicate({ ymd: "2026-07-10", amountPaise: 42000, merchant: "Zomato" })).toBe(false);
  });

  it("catches duplicates introduced within the same import batch via add()", () => {
    const idx = new DuplicateIndex([]);
    const candidate = { ymd: "2026-07-10", amountPaise: 42000, merchant: "Swiggy" };
    expect(idx.isDuplicate(candidate)).toBe(false);
    idx.add(candidate);
    expect(idx.isDuplicate(candidate)).toBe(true);
  });
});
