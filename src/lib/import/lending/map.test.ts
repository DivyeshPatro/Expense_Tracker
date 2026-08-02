import { describe, expect, it } from "vitest";
import { displayContactName, mapLendingRow, normalizeContactName } from "./map";
import type { ResolvedColumns } from "./types";

const TWO_COL: ResolvedColumns = { contact: "Name", date: "Date", gave: "You Gave", got: "You Got", note: "Details" };
const AMT_TYPE: ResolvedColumns = { contact: "Party", date: "Date", amount: "Amount", type: "Type", note: "Note" };

const row = (r: Record<string, unknown>, cols = TWO_COL, i = 1) => mapLendingRow(r, i, cols);

describe("normalizeContactName (smart merge)", () => {
  it("folds case and surrounding/internal whitespace to one key", () => {
    expect(normalizeContactName("Rahul")).toBe("rahul");
    expect(normalizeContactName("rahul")).toBe("rahul");
    expect(normalizeContactName("  Rahul  ")).toBe("rahul");
    expect(normalizeContactName("Rahul   Kumar")).toBe("rahul kumar");
  });

  it("keeps genuinely different names distinct — never fuzzy-merges", () => {
    expect(normalizeContactName("Rahul")).not.toBe(normalizeContactName("Rahul Kumar"));
  });

  it("preserves original casing in the display form", () => {
    expect(displayContactName("  Rahul   Kumar ")).toBe("Rahul Kumar");
  });
});

describe("mapLendingRow — two-column You Gave / You Got", () => {
  it("maps a You Gave row to GAVE with paise and keeps the note verbatim", () => {
    const r = row({ Name: "Ramesh", Date: "10/07/2026", "You Gave": "1,500", "You Got": "", Details: "Rice bags" });
    expect(r).toMatchObject({ status: "valid", kind: "GAVE", amountPaise: 150000, ymd: "2026-07-10", contact: "Ramesh", note: "Rice bags" });
  });

  it("maps a You Got row to GOT", () => {
    const r = row({ Name: "Ramesh", Date: "2026-07-11", "You Gave": "", "You Got": "₹500" });
    expect(r).toMatchObject({ status: "valid", kind: "GOT", amountPaise: 50000 });
  });

  it("rejects a row carrying both a gave and a got amount", () => {
    const r = row({ Name: "X", Date: "2026-07-11", "You Gave": "100", "You Got": "50" });
    expect(r.status).toBe("invalid");
    expect(r.reason).toMatch(/both/i);
  });

  it("rejects a row with neither amount", () => {
    const r = row({ Name: "X", Date: "2026-07-11", "You Gave": "0", "You Got": "" });
    expect(r.status).toBe("invalid");
    expect(r.reason).toMatch(/amount/i);
  });
});

describe("mapLendingRow — single amount + type", () => {
  it("reads the type word to pick a direction", () => {
    expect(row({ Party: "A", Date: "2026-07-10", Amount: "200", Type: "You Gave" }, AMT_TYPE).kind).toBe("GAVE");
    expect(row({ Party: "A", Date: "2026-07-10", Amount: "200", Type: "Credit" }, AMT_TYPE).kind).toBe("GOT");
    expect(row({ Party: "A", Date: "2026-07-10", Amount: "200", Type: "Cash In" }, AMT_TYPE).kind).toBe("GOT");
  });

  it("rejects an unrecognised type", () => {
    const r = row({ Party: "A", Date: "2026-07-10", Amount: "200", Type: "whatever" }, AMT_TYPE);
    expect(r.status).toBe("invalid");
    expect(r.reason).toMatch(/type/i);
  });
});

describe("mapLendingRow — validation", () => {
  it("flags a missing contact", () => {
    const r = row({ Name: "  ", Date: "2026-07-10", "You Gave": "100" });
    expect(r).toMatchObject({ status: "invalid", reason: "Missing contact" });
  });

  it("flags a missing or unparseable date", () => {
    const r = row({ Name: "A", Date: "not a date", "You Gave": "100" });
    expect(r.status).toBe("invalid");
    expect(r.reason).toMatch(/date/i);
  });

  it("carries the 1-based row index for user-facing messages", () => {
    expect(row({ Name: "", Date: "", "You Gave": "" }, TWO_COL, 42).rowIndex).toBe(42);
  });
});
