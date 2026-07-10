// Deterministic column-mapping suggestions: header-keyword matching first,
// value-shape scoring as a fallback for ambiguous headers (Architecture doc §5
// — "header heuristics + value-shape scoring", zero AI).

import type { ColumnMapping, TargetField } from "./types";
import { emptyMapping } from "./types";
import { parseFlexibleAmount, parseFlexibleDate } from "./parse-value";

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const HEADER_SYNONYMS: Record<Exclude<TargetField, "ignore">, string[]> = {
  date: ["date", "transactiondate", "txndate", "postingdate", "valuedate", "trandate"],
  amount: ["amount", "amt", "value", "transactionamount"],
  debit: ["debit", "withdrawal", "withdrawalamt", "debitamount", "dr"],
  credit: ["credit", "deposit", "depositamt", "creditamount", "cr"],
  type: ["type", "txntype", "transactiontype", "debitcredit", "drcr", "incomeexpense", "direction"],
  merchant: ["merchant", "description", "narration", "particulars", "payee", "details", "transactiondetails", "remarks"],
  category: ["category", "cat", "categoryname"],
  account: ["account", "accountname", "wallet", "paymentaccount", "bank", "source"],
  notes: ["notes", "note", "memo", "comment", "comments"],
  paymentMethod: ["paymentmethod", "mode", "channel", "paymentmode"],
};

/** Suggests a column mapping from spreadsheet headers + a sample of rows. */
export function suggestMapping(headers: string[], sampleRows: Record<string, unknown>[]): ColumnMapping {
  const mapping = emptyMapping();
  const used = new Set<string>();

  const byHeader = (field: Exclude<TargetField, "ignore">): string | null => {
    const synonyms = HEADER_SYNONYMS[field];
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
