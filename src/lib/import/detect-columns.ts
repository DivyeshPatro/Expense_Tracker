// Deterministic column-mapping suggestions: header-keyword matching first,
// value-shape scoring as a fallback for ambiguous headers (Architecture doc §5
// — "header heuristics + value-shape scoring", zero AI).

import type { ColumnMapping, TargetField } from "./types";
import { emptyMapping } from "./types";
import { parseFlexibleAmount, parseFlexibleDate } from "./parse-value";

export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export const HEADER_SYNONYMS: Record<Exclude<TargetField, "ignore">, string[]> = {
  date: ["date", "transactiondate", "txndate", "postingdate", "valuedate", "trandate"],
  amount: ["amount", "amt", "value", "transactionamount"],
  debit: ["debit", "withdrawal", "withdrawalamt", "debitamount", "dr"],
  credit: ["credit", "deposit", "depositamt", "creditamount", "cr"],
  type: ["type", "txntype", "transactiontype", "categorytype", "debitcredit", "drcr", "incomeexpense", "direction"],
  merchant: ["merchant", "description", "narration", "particulars", "payee", "details", "transactiondetails", "remarks"],
  category: ["category", "cat", "categoryname"],
  account: ["account", "accountname", "wallet", "paymentaccount", "bank", "source"],
  notes: ["notes", "note", "memo", "comment", "comments"],
  paymentMethod: ["paymentmethod", "mode", "channel", "paymentmode"],
};

// Preset overlays: source-specific header guesses merged on top of
// HEADER_SYNONYMS only when that preset is explicitly chosen (Import Center
// hub) — kept out of the generic table so a bare "Name" column in an
// unrelated CSV doesn't get mis-guessed as a merchant just because Khatabook
// happens to call its party-name column that.
export const PRESET_HEADER_SYNONYMS: Record<string, Partial<Record<Exclude<TargetField, "ignore">, string[]>>> = {
  khatabook: {
    merchant: ["partyname", "party", "name", "customername"],
    type: ["entrytype", "inout", "cashinout", "gavegot"],
    notes: ["remark"],
  },
};

/** True when a raw spreadsheet row looks like a header row (2+ cells match known field keywords). */
export function looksLikeHeaderRow(cells: unknown[]): boolean {
  const texts = cells.map((c) => norm(String(c ?? "")));
  let matches = 0;
  for (const n of texts) {
    if (!n) continue;
    for (const synonyms of Object.values(HEADER_SYNONYMS)) {
      if (synonyms.some((s) => n === s)) {
        matches++;
        break;
      }
    }
  }
  return matches >= 2;
}

/** Suggests a column mapping from spreadsheet headers + a sample of rows.
 *  Optional `preset` (e.g. "khatabook") overlays source-specific header
 *  synonyms on top of the base list — see PRESET_HEADER_SYNONYMS. */
export function suggestMapping(
  headers: string[],
  sampleRows: Record<string, unknown>[],
  preset?: string
): ColumnMapping {
  const mapping = emptyMapping();
  const used = new Set<string>();

  const overlay = preset ? PRESET_HEADER_SYNONYMS[preset] : undefined;
  const synonymsFor = (field: Exclude<TargetField, "ignore">): string[] => {
    const base = HEADER_SYNONYMS[field];
    const extra = overlay?.[field];
    return extra && extra.length ? [...extra, ...base] : base;
  };

  const byHeader = (field: Exclude<TargetField, "ignore">): string | null => {
    const synonyms = synonymsFor(field);
    for (const h of headers) {
      if (used.has(h)) continue;
      const n = norm(h);
      if (synonyms.some((s) => n === s)) return h;
    }
    for (const h of headers) {
      if (used.has(h)) continue;
      const n = norm(h);
      if (synonyms.some((s) => n.includes(s))) return h;
    }
    return null;
  };

  const claim = (field: Exclude<TargetField, "ignore">): string | null => {
    const h = byHeader(field);
    if (h) used.add(h);
    return h;
  };

  // debit/credit pair takes priority over a single amount column if both present
  const debit = claim("debit");
  const credit = claim("credit");
  if (debit && credit) {
    mapping.debit = debit;
    mapping.credit = credit;
  } else {
    used.delete(debit ?? "");
    used.delete(credit ?? "");
    mapping.amount = claim("amount");
  }
  mapping.type = claim("type");
  mapping.date = claim("date");
  mapping.merchant = claim("merchant");
  mapping.category = claim("category");
  mapping.account = claim("account");
  mapping.notes = claim("notes");
  mapping.paymentMethod = claim("paymentMethod");

  // value-shape fallback: unmapped columns tested against a sample for date/amount shape
  if (!mapping.date) {
    mapping.date = shapeMatch(headers, sampleRows, used, (v) => parseFlexibleDate(v) !== null);
    if (mapping.date) used.add(mapping.date);
  }
  if (!mapping.amount && !mapping.debit) {
    mapping.amount = shapeMatch(headers, sampleRows, used, (v) => parseFlexibleAmount(v) !== null);
  }

  return mapping;
}

function shapeMatch(
  headers: string[],
  rows: Record<string, unknown>[],
  used: Set<string>,
  test: (v: unknown) => boolean
): string | null {
  for (const h of headers) {
    if (used.has(h)) continue;
    const sample = rows.slice(0, 10).map((r) => r[h]).filter((v) => v !== undefined && v !== "");
    if (sample.length === 0) continue;
    const hits = sample.filter(test).length;
    if (hits / sample.length >= 0.8) return h;
  }
  return null;
}
