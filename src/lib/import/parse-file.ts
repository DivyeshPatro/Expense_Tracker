// Reads the first sheet(s) of a CSV/XLSX buffer into headers + row objects.
// Isolated here so the route handler stays a one-line delegate (services
// never touch HTTP, but this one *does* touch a third-party parser, so it
// lives in lib, not server/services).
//
// Uses exceljs for .xlsx (actively maintained; the npm-published `xlsx`/
// SheetJS build has known unpatched prototype-pollution/ReDoS CVEs in its
// parser, and this function's whole job is parsing untrusted user uploads).
// exceljs doesn't read legacy binary .xls (pre-2007 OOXML) or CSV, so those
// are handled explicitly below — CSV via a small hand-rolled RFC4180 parser
// rather than pulling in another parsing dependency for adversarial input.

import ExcelJS from "exceljs";
import type { ParsedSheet } from "./types";
import { scanWorkbookSheets } from "./scan-sheet";

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // .xlsx is a zip archive
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0]; // legacy binary .xls — not supported by exceljs

function hasMagic(buf: Buffer, magic: number[]): boolean {
  return buf.length >= magic.length && magic.every((b, i) => buf[i] === b);
}

/**
 * Minimal RFC4180 CSV parser. Every value comes out as a raw string — no
 * type-guessing — which matters specifically for dates: a prior bug here had
 * SheetJS silently reinterpreting day-first "01/07/2026" as month-first
 * (Jan 7) before parse-value.ts's own day-first-aware logic ever saw the
 * original string. Real .xlsx date cells are handled separately below and
 * are unaffected (they carry explicit type info, no guessing involved).
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip UTF-8 BOM
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inQuotes) {
      if (c === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && body[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

async function parseXlsx(buf: Buffer): Promise<unknown[][][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb.worksheets.map((ws) => {
    const grid: unknown[][] = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
      const cells: unknown[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell.value;
        // rich text / hyperlink cells carry { text } or { text, hyperlink }
        // instead of a plain scalar — flatten to the display text
        cells.push(v && typeof v === "object" && "text" in v ? (v as { text: unknown }).text : (v ?? ""));
      });
      grid.push(cells);
    });
    return grid;
  });
}

export async function parseSpreadsheet(buffer: ArrayBuffer | Buffer): Promise<ParsedSheet> {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  if (hasMagic(buf, OLE_MAGIC)) {
    throw new Error("Legacy .xls files aren't supported — please save as .xlsx or .csv and re-upload.");
  }
  if (hasMagic(buf, ZIP_MAGIC)) {
    return scanWorkbookSheets(await parseXlsx(buf));
  }
  return scanWorkbookSheets([parseCsv(buf.toString("utf8"))]);
}
