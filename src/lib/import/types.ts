// Shared types for the generic import engine (Architecture doc §5 — adapter
// pattern: any spreadsheet source maps onto these same fields).

export type TargetField =
  | "date"
  | "amount"
  | "debit"
  | "credit"
  | "type"
  | "merchant"
  | "category"
  | "account"
  | "notes"
  | "paymentMethod"
  | "ignore";

export interface ColumnMapping {
  date: string | null;
  /** single signed/unsigned amount column (alternative to debit/credit pair) */
  amount: string | null;
  amountSign: "negative-is-expense" | "positive-is-expense";
  /** separate debit/credit columns (common in Indian bank statement exports) */
  debit: string | null;
  credit: string | null;
  /** explicit type column (e.g. "Debit"/"Credit", "Expense"/"Income") overrides sign conventions */
  type: string | null;
  merchant: string | null;
  category: string | null;
  account: string | null;
  notes: string | null;
  paymentMethod: string | null;
}

export function emptyMapping(): ColumnMapping {
  return {
    date: null,
    amount: null,
    amountSign: "negative-is-expense",
    debit: null,
    credit: null,
    type: null,
    merchant: null,
    category: null,
    account: null,
    notes: null,
    paymentMethod: null,
  };
}

export interface ParsedSheet {
  headers: string[];
  rows: Record<string, unknown>[];
}

export type RowStatus = "valid" | "duplicate" | "invalid";

export interface NormalizedRow {
  rowIndex: number;
  type: "EXPENSE" | "INCOME" | null;
  amountPaise: number | null;
  ymd: string | null;
  merchant: string | null;
  categoryRaw: string | null;
  accountRaw: string | null;
  notes: string | null;
  paymentMethod: string | null;
}

export interface PreviewRow extends NormalizedRow {
  status: RowStatus;
  reason: string | null;
  skip: boolean;
}
