import { describe, expect, it } from "vitest";
import { suggestMapping } from "./detect-columns";

describe("suggestMapping", () => {
  it("maps clear header names directly", () => {
    const headers = ["Date", "Amount", "Merchant", "Category", "Notes"];
    const rows = [{ Date: "2026-07-01", Amount: "420", Merchant: "Swiggy", Category: "Food", Notes: "lunch" }];
    const m = suggestMapping(headers, rows);
    expect(m.date).toBe("Date");
    expect(m.amount).toBe("Amount");
    expect(m.merchant).toBe("Merchant");
    expect(m.category).toBe("Category");
    expect(m.notes).toBe("Notes");
  });

  it("prefers a debit/credit column pair over a single amount column", () => {
    const headers = ["Date", "Narration", "Debit", "Credit"];
    const rows = [{ Date: "2026-07-01", Narration: "Swiggy", Debit: "420", Credit: "" }];
    const m = suggestMapping(headers, rows);
    expect(m.debit).toBe("Debit");
    expect(m.credit).toBe("Credit");
    expect(m.amount).toBeNull();
    expect(m.merchant).toBe("Narration"); // "narration" is a common bank-statement synonym
  });

  it("falls back to value-shape scoring for an ambiguous date header", () => {
    const headers = ["Txn Date", "Description", "Value"];
    const rows = [
      { "Txn Date": "01/07/2026", Description: "Swiggy", Value: "420" },
      { "Txn Date": "02/07/2026", Description: "Uber", Value: "240" },
    ];
    const m = suggestMapping(headers, rows);
    expect(m.date).toBe("Txn Date");
    expect(m.amount).toBe("Value");
  });

  it("does not double-assign the same column to two fields", () => {
    const headers = ["Date", "Amount"];
    const rows = [{ Date: "2026-07-01", Amount: "420" }];
    const m = suggestMapping(headers, rows);
    const assigned = [m.date, m.amount, m.merchant, m.category].filter(Boolean);
    expect(new Set(assigned).size).toBe(assigned.length);
  });

  it("maps Khatabook-style headers (Party Name, Entry Type, Remark) only when the khatabook preset is active", () => {
    const headers = ["Date", "Amount", "Party Name", "Entry Type", "Remark"];
    const rows = [{ Date: "2026-07-01", Amount: "500", "Party Name": "Ravi", "Entry Type": "GAVE", Remark: "for groceries" }];
    // Without the preset, "Party Name" / "Entry Type" / "Remark" aren't recognized merchant/type/notes synonyms.
    const without = suggestMapping(headers, rows);
    expect(without.merchant).not.toBe("Party Name");
    expect(without.notes).not.toBe("Remark");
    // With the preset, the overlay recognizes them.
    const withPreset = suggestMapping(headers, rows, "khatabook");
    expect(withPreset.merchant).toBe("Party Name");
    expect(withPreset.type).toBe("Entry Type");
    expect(withPreset.notes).toBe("Remark");
  });
});
