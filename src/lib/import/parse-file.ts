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
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const grids = wb.SheetNames.map((name) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: "", raw: true }));
  return scanWorkbookSheets(grids);
}
