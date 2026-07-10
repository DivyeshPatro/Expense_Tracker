// Applies a ColumnMapping to a raw spreadsheet row, producing a NormalizedRow.
// Pure and deterministic — no DB access (category/account text stay as raw
// strings here; resolving them to ids happens in the service layer).

import type { ColumnMapping, NormalizedRow } from "./types";
import { parseFlexibleAmount, parseFlexibleDate } from "./parse-value";

const EXPENSE_WORDS = ["debit", "expense", "withdrawal", "dr", "spent", "out"];
const INCOME_WORDS = ["credit", "income", "deposit", "cr", "received", "in"];

export function normalizeRow(raw: Record<string, unknown>, rowIndex: number, mapping: ColumnMapping): NormalizedRow {
  const ymd = mapping.date ? parseFlexibleDate(raw[mapping.date]) : null;
  const merchant = mapping.merchant ? String(raw[mapping.merchant] ?? "").trim() || null : null;
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

  return { rowIndex, type, amountPaise, ymd, merchant, categoryRaw, accountRaw, notes, paymentMethod };
}

function resolveTypeColumn(raw: unknown): "EXPENSE" | "INCOME" | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (EXPENSE_WORDS.some((w) => s.includes(w))) return "EXPENSE";
  if (INCOME_WORDS.some((w) => s.includes(w))) return "INCOME";
  return null;
}
