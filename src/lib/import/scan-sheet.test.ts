import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { parseSpreadsheet } from "./parse-file";
import { suggestMapping } from "./detect-columns";
import { normalizeRow } from "./normalize";

// Reproduces the real Monito export shape: app-name/version/created-on banner
// rows, a "March 2023" section label, then the real header row, then data —
// exactly what a user attached from their actual export.
const MONITO_GRID = [
  ["", "Monito Expense Manager", "", "", "", ""],
  ["", "Version 8.3", "", "", "", ""],
  ["", "Created on 11 Jul 2026 02:17:23", "", "", "", ""],
  ["", "", "", "", "", ""],
  ["", "", "", "March 2023", "", ""],
  ["", "", "", "", "", ""],
  ["", "Date", "Category type", "Category name", "Note", "Amount"],
  ["", "1 Mar 2023", "Expense", "Food", "Bristi mandi", "235"],
  ["", "1 Mar 2023", "Expense", "Rent", "", "7000"],
  ["", "1 Mar 2023", "Expense", "Home", "Feb", "10000"],
  ["", "2 Mar 2023", "Expense", "Food", "Dosa", "60"],
  ["", "9 Mar 2023", "Income", "Refund", "Cap refund", "275"],
];

async function buildBuffer(grid: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRows(grid);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("parseSpreadsheet against a real Monito-shaped export", () => {
  it("skips the app-name/version/created-on banner and the month-section label", async () => {
    const parsed = await parseSpreadsheet(await buildBuffer(MONITO_GRID));
    expect(parsed.rows).toHaveLength(5);
    expect(parsed.headers).toEqual(["Date", "Category type", "Category name", "Note", "Amount"]);
  });

  it("auto-suggests Date/type/category/notes/amount without a merchant column", async () => {
    const parsed = await parseSpreadsheet(await buildBuffer(MONITO_GRID));
    const mapping = suggestMapping(parsed.headers, parsed.rows.slice(0, 20));
    expect(mapping.date).toBe("Date");
    expect(mapping.type).toBe("Category type");
    expect(mapping.category).toBe("Category name");
    expect(mapping.notes).toBe("Note");
    expect(mapping.amount).toBe("Amount");
    expect(mapping.merchant).toBeNull();
  });

  it("normalizes every row correctly, falling back to note/category for the merchant field", async () => {
    const parsed = await parseSpreadsheet(await buildBuffer(MONITO_GRID));
    const mapping = suggestMapping(parsed.headers, parsed.rows.slice(0, 20));
    const rows = parsed.rows.map((r, i) => normalizeRow(r, i, mapping));

    expect(rows[0]).toMatchObject({ ymd: "2023-03-01", type: "EXPENSE", amountPaise: 23500, merchant: "Bristi mandi", categoryRaw: "Food" });
    // blank note -> falls back to the category name, never blocks the row
    expect(rows[1]).toMatchObject({ ymd: "2023-03-01", type: "EXPENSE", amountPaise: 700000, merchant: "Rent", categoryRaw: "Rent" });
    expect(rows[2]).toMatchObject({ ymd: "2023-03-01", type: "EXPENSE", amountPaise: 1000000, merchant: "Feb", categoryRaw: "Home" });
    expect(rows[3]).toMatchObject({ ymd: "2023-03-02", type: "EXPENSE", amountPaise: 6000, merchant: "Dosa" });
    // "Category type" = Income correctly flips the sign even though Amount itself is unsigned
    expect(rows[4]).toMatchObject({ ymd: "2023-03-09", type: "INCOME", amountPaise: 27500, merchant: "Cap refund" });

    // every row must be usable — none silently dropped for lack of a merchant column
    expect(rows.every((r) => r.merchant !== null)).toBe(true);
  });

  it("handles a second month block with its own repeated header row (re-sync)", async () => {
    const grid = [
      ...MONITO_GRID,
      ["", "", "", "", "", ""],
      ["", "", "", "April 2023", "", ""],
      ["", "", "", "", "", ""],
      ["", "Date", "Category type", "Category name", "Note", "Amount"],
      ["", "3 Apr 2023", "Expense", "Fuel", "Petrol", "500"],
    ];
    const parsed = await parseSpreadsheet(await buildBuffer(grid));
    expect(parsed.rows).toHaveLength(6);
    expect(parsed.rows[5]).toMatchObject({ Date: "3 Apr 2023", "Category name": "Fuel", Amount: "500" });
  });
});
