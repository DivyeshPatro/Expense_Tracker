// Thin wrapper around SheetJS: reads the first sheet of a CSV/XLS/XLSX buffer
// into headers + row objects. Isolated here so the route handler stays a
// one-line delegate (services never touch HTTP, but this one *does* touch a
// third-party parser, so it lives in lib, not server/services).

import * as XLSX from "xlsx";
import type { ParsedSheet } from "./types";
import { scanWorkbookSheets } from "./scan-sheet";

/**
 * Reads every sheet as a raw grid and hands it to the header-scanning parser
 * (scan-sheet.ts), which finds the real header row wherever it sits — this
 * tolerates banner rows, "Created on …" stamps, and repeated month-section
 * headers that real exports (Monito, bank statements) commonly have.
 */
export function parseSpreadsheet(buffer: ArrayBuffer | Buffer): ParsedSheet {
  // cellDates deliberately NOT set, and raw:true disables SheetJS's own
  // plaintext value-guessing for CSV: without it, a date-shaped CSV string
  // like "01/07/2026" got silently parsed as a serial number using SheetJS's
  // own (US month-first) guess — "Jan 7" instead of "1 July" — before our
  // Indian-day-first parser in parse-value.ts ever saw the original string.
  // Real .xlsx date cells are unaffected: those already carry explicit
  // numeric/date type info, no guessing involved.
  const wb = XLSX.read(buffer, { type: "buffer", raw: true });
  const grids = wb.SheetNames.map((name) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: "", raw: true }));
  return scanWorkbookSheets(grids);
}
