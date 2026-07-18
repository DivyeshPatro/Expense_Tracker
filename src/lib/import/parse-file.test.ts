import { describe, expect, it } from "vitest";
import { parseSpreadsheet } from "./parse-file";
import { suggestMapping } from "./detect-columns";
import { normalizeRow } from "./normalize";

// Regression test: SheetJS's cellDates:true option used to pre-parse ambiguous
// CSV date strings itself (US month-first) before parseFlexibleDate's own
// day-first-aware parsing ever saw them — silently swapping day/month for
// any Indian-style "DD/MM/YYYY" date whose day component is <= 12, e.g.
// "01/07/2026" (1 July) was becoming "Jan 7". Real .xlsx date cells still
// come through fine as Excel serial numbers without cellDates.
describe("parseSpreadsheet — day-first CSV dates aren't pre-parsed as month-first", () => {
  const csv = "Date,Merchant,Amount\n01/07/2026,Swiggy,-350\n02/07/2026,Salary,50000\n";
  const buf = Buffer.from(csv, "utf8");

  it("hands the raw date string through, not a Date object SheetJS guessed itself", async () => {
    const parsed = await parseSpreadsheet(buf);
    expect(parsed.rows[0]["Date"] instanceof Date).toBe(false);
  });

  it("resolves through the full pipeline to the correct day-first date", async () => {
    const parsed = await parseSpreadsheet(buf);
    const mapping = suggestMapping(parsed.headers, parsed.rows);
    const rows = parsed.rows.map((r, i) => normalizeRow(r, i, mapping));
    expect(rows[0].ymd).toBe("2026-07-01"); // NOT 2026-01-07
    expect(rows[1].ymd).toBe("2026-07-02"); // NOT 2026-02-07
  });
});
