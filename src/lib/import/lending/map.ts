// Row mapping + validation: raw spreadsheet row → canonical LendingImportRow.
//
// Pure and DB-free. Duplicate marking happens later (it needs cross-row and
// existing-ledger context); here a row is only ever "valid" or "invalid".

import { parseFlexibleAmount, parseFlexibleDate } from "../parse-value";
import type { LendingImportRow, LendingKind, ResolvedColumns } from "./types";

/**
 * Merge key for a contact name: lowercased, trimmed, internal whitespace
 * collapsed. This is the "smart merge" — "Rahul", "rahul" and " Rahul " become
 * one contact, while "Rahul" and "Rahul Kumar" stay distinct people. No fuzzy
 * or token matching: merging different names would silently fuse real people.
 */
export function normalizeContactName(raw: string): string {
  return collapseSpaces(raw).toLowerCase();
}

/** Display form: original casing, trimmed, internal runs of whitespace collapsed to one space. */
export function displayContactName(raw: string): string {
  return collapseSpaces(raw);
}

function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const GAVE_WORDS = new Set(["gave", "yougave", "given", "give", "debit", "dr", "out", "cashout", "paid", "lent", "gaveamount"]);
const GOT_WORDS = new Set(["got", "yougot", "received", "receive", "credit", "cr", "in", "cashin", "repaid", "returned", "gotamount"]);

function normType(raw: unknown): string {
  return String(raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

function kindFromType(raw: unknown): LendingKind | null {
  const n = normType(raw);
  if (!n) return null;
  if (GAVE_WORDS.has(n)) return "GAVE";
  if (GOT_WORDS.has(n)) return "GOT";
  // Some exports write a symbol/word inside a longer cell ("Cash In", "You Got ₹").
  for (const w of GAVE_WORDS) if (n.includes(w)) return "GAVE";
  for (const w of GOT_WORDS) if (n.includes(w)) return "GOT";
  return null;
}

function cell(raw: Record<string, unknown>, col: string | undefined): unknown {
  return col ? raw[col] : undefined;
}

function invalid(rowIndex: number, contact: string | null, contactKey: string | null, ymd: string | null, reason: string): LendingImportRow {
  return { rowIndex, contact, contactKey, ymd, kind: null, amountPaise: null, note: null, status: "invalid", reason };
}

/** Maps and validates one raw row. `rowIndex` is 1-based for user-facing messages. */
export function mapLendingRow(raw: Record<string, unknown>, rowIndex: number, cols: ResolvedColumns): LendingImportRow {
  const contactRaw = String(cell(raw, cols.contact) ?? "");
  const contact = contactRaw.trim() ? displayContactName(contactRaw) : null;
  const contactKey = contact ? normalizeContactName(contactRaw) : null;

  const note = noteOf(raw, cols);

  if (!contact || !contactKey) return invalid(rowIndex, null, null, null, "Missing contact");

  const ymd = parseFlexibleDate(cell(raw, cols.date));
  if (!ymd) return invalid(rowIndex, contact, contactKey, null, "Missing or invalid date");

  const resolved = resolveKindAmount(raw, cols);
  if (resolved.error) return invalid(rowIndex, contact, contactKey, ymd, resolved.error);

  return {
    rowIndex,
    contact,
    contactKey,
    ymd,
    kind: resolved.kind,
    amountPaise: resolved.amountPaise,
    note,
    status: "valid",
    reason: null,
  };
}

function noteOf(raw: Record<string, unknown>, cols: ResolvedColumns): string | null {
  const n = String(cell(raw, cols.note) ?? "").trim();
  return n ? n : null;
}

/**
 * Resolves a row's direction and magnitude from whichever shape the source uses:
 * the two-column You-Gave / You-Got form, or a single amount plus a type column.
 */
function resolveKindAmount(
  raw: Record<string, unknown>,
  cols: ResolvedColumns
): { kind: LendingKind; amountPaise: number; error: null } | { kind: null; amountPaise: null; error: string } {
  const err = (error: string) => ({ kind: null, amountPaise: null, error } as const);

  if (cols.gave || cols.got) {
    const gave = parseFlexibleAmount(cell(raw, cols.gave));
    const got = parseFlexibleAmount(cell(raw, cols.got));
    const gaveP = gave && gave.paise > 0 ? gave.paise : 0;
    const gotP = got && got.paise > 0 ? got.paise : 0;
    if (gaveP > 0 && gotP > 0) return err("Row has both a You Gave and a You Got amount");
    if (gaveP > 0) return { kind: "GAVE", amountPaise: gaveP, error: null };
    if (gotP > 0) return { kind: "GOT", amountPaise: gotP, error: null };
    return err("Missing or zero amount");
  }

  // Single amount + explicit type.
  const kind = kindFromType(cell(raw, cols.type));
  if (!kind) return err("Unknown transaction type");
  const amount = parseFlexibleAmount(cell(raw, cols.amount));
  if (!amount || amount.paise <= 0) return err("Missing or invalid amount");
  return { kind, amountPaise: amount.paise, error: null };
}

/** Maps every raw row. Duplicate detection is a separate, later pass. */
export function mapLendingRows(rawRows: Record<string, unknown>[], cols: ResolvedColumns): LendingImportRow[] {
  return rawRows.map((raw, i) => mapLendingRow(raw, i + 1, cols));
}
