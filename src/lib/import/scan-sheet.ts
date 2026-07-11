// Real-world exports are rarely a clean table from row 1: app-name/version
// banners, "Created on …" stamps, and month-section labels (e.g. Monito's
// "March 2023") sit above and between the actual data. This scans every sheet
// in the workbook cell-by-cell, finds header rows wherever they occur
// (re-syncing on each repeated header for multi-month exports), and skips
// everything that isn't a header or a data row. Deterministic — no AI.

import type { ParsedSheet } from "./types";
import { looksLikeHeaderRow } from "./detect-columns";

function isBlankRow(cells: unknown[]): boolean {
  return cells.every((c) => String(c ?? "").trim() === "");
}

/** A row with only one populated cell is a banner/section label ("March 2023", "Version 8.3"), not data. */
function isSparseNonDataRow(cells: unknown[]): boolean {
  const nonBlank = cells.filter((c) => String(c ?? "").trim() !== "");
  return nonBlank.length <= 1;
}

export function scanRowsFromGrid(grid: unknown[][]): ParsedSheet {
  let headers: string[] = [];
  let lastHeaders: string[] = [];
  const rows: Record<string, unknown>[] = [];

  for (const row of grid) {
    if (isBlankRow(row)) continue;
    if (looksLikeHeaderRow(row)) {
      headers = row.map((c) => String(c ?? "").trim());
      lastHeaders = headers;
      continue;
    }
    if (!headers.length) continue; // preamble before the first header row
    if (isSparseNonDataRow(row)) continue; // section banner between blocks

    const record: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      if (h) record[h] = row[i] ?? "";
    });
    rows.push(record);
  }

  return { headers: lastHeaders.filter(Boolean), rows };
}

export function scanWorkbookSheets(sheets: unknown[][][]): ParsedSheet {
  const merged: ParsedSheet = { headers: [], rows: [] };
  for (const grid of sheets) {
    const parsed = scanRowsFromGrid(grid);
    if (parsed.rows.length === 0) continue;
    if (merged.headers.length === 0) merged.headers = parsed.headers;
    merged.rows.push(...parsed.rows);
  }
  return merged;
}
