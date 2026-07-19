// Applies a ColumnMapping to a raw spreadsheet row, producing a NormalizedRow.
// Pure and deterministic — no DB access (category/account text stay as raw
// strings here; resolving them to ids happens in the service layer).

import type { ColumnMapping, NormalizedRow } from "./types";
import { parseFlexibleAmount, parseFlexibleDate } from "./parse-value";

// "gave"/"got" cover Khatabook's type-column vocabulary (EntryType = GAVE/GOT).
// Safe here because these are substring-matched only against a mapped type
// column whose values are a controlled vocabulary, not free text.
const EXPENSE_WORDS = ["debit", "expense", "withdrawal", "dr", "spent", "out", "gave"];
const INCOME_WORDS = ["credit", "income", "deposit", "cr", "received", "in", "got"];

export function normalizeRow(raw: Record<string, unknown>, rowIndex: number, mapping: ColumnMapping): NormalizedRow {
  const ymd = mapping.date ? parseFlexibleDate(raw[mapping.date]) : null;
  const mappedMerchant = mapping.merchant ? String(raw[mapping.merchant] ?? "").trim() || null : null;
  const categoryRaw = mapping.category ? String(raw[mapping.category] ?? "").trim() || null : null;
  const accountRaw = mapping.account ? String(raw[mapping.account] ?? "").trim() || null : null;
  const notes = mapping.notes ? String(raw[mapping.notes] ?? "").trim() || null : null;
  const paymentMethod = mapping.paymentMethod ? String(raw[mapping.paymentMethod] ?? "").trim() || null : null;

  let type: "EXPENSE" | "INCOME" | null = null;
  let amountPaise: number | null = null;

  if (mapping.debit && mapping.credit) {
    const d = parseFlexibleAmount(raw[mapping.debit]);
    const c = parseFlexibleAmount(raw[mapping.credit]);
    if (d && d.paise > 0) {
      type = "EXPENSE";
      amountPaise = d.paise;
    } else if (c && c.paise > 0) {
      type = "INCOME";
      amountPaise = c.paise;
    }
  } else if (mapping.amount) {
    const a = parseFlexibleAmount(raw[mapping.amount]);
    if (a) {
      amountPaise = a.paise;
      if (mapping.type) {
        type = resolveTypeColumn(raw[mapping.type]);
      } else if (a.paise > 0) {
        const isNeg = a.negative;
        type = mapping.amountSign === "negative-is-expense" ? (isNeg ? "EXPENSE" : "INCOME") : isNeg ? "INCOME" : "EXPENSE";
      }
    }
  }

  if (type === null && mapping.type && amountPaise !== null) {
    type = resolveTypeColumn(raw[mapping.type]);
  }

  // Sources like Monito have no dedicated merchant/payee column — category + an
  // optional free-text note stand in for it. Fall back through what's available
  // so a transaction always has *some* readable name, rather than failing
  // validation purely because the note happened to be blank.
  const merchant = mappedMerchant || notes || categoryRaw || (type ? (type === "EXPENSE" ? "Expense" : "Income") : null);

  return { rowIndex, type, amountPaise, ymd, merchant, categoryRaw, accountRaw, notes, paymentMethod };
}

function resolveTypeColumn(raw: unknown): "EXPENSE" | "INCOME" | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (EXPENSE_WORDS.some((w) => s.includes(w))) return "EXPENSE";
  if (INCOME_WORDS.some((w) => s.includes(w))) return "INCOME";
  return null;
}
