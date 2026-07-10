// Thin wrapper around SheetJS: reads the first sheet of a CSV/XLS/XLSX buffer
// into headers + row objects. Isolated here so the route handler stays a
// one-line delegate (services never touch HTTP, but this one *does* touch a
// third-party parser, so it lives in lib, not server/services).

import * as XLSX from "xlsx";
import type { ParsedSheet } from "./types";

export function parseSpreadsheet(buffer: ArrayBuffer | Buffer): ParsedSheet {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { headers: [], rows: [] };
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: true });
  const headers = (XLSX.utils.sheet_to_json(sheet, { header: 1 })[0] as string[] | undefined) ?? [];
  return { headers: headers.map(String).filter(Boolean), rows };
}
