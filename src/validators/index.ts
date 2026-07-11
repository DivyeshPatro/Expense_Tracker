// zod schemas — single source of truth for server actions (and future REST routes).
// All money enters as rupee strings and is parsed to integer paise here, at the boundary.

import { z } from "zod";

export const paiseFromRupees = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const n = typeof v === "string" ? Number(String(v).replace(/[₹,\s]/g, "")) : v;
    if (!Number.isFinite(n) || n <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid amount" });
      return z.NEVER;
    }
    return Math.round(n * 100);
  });

export const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date");

export const splitSchema = z.object({
  mode: z.enum(["EQUAL", "EXACT"]),
  participantIds: z.array(z.string().min(1)).min(1, "Pick at least one friend to split with"),
  payerParticipantId: z.string().nullable(),
  exactAmounts: z.record(z.string(), z.number().int().nonnegative()).optional(),
});

export const expenseSchema = z.object({
  amount: paiseFromRupees,
  accountId: z.string().nullable(),
  categoryId: z.string().nullable(),
  merchant: z.string().trim().max(120).transform((s) => s || "Expense"),
  date: ymd,
  notes: z.string().trim().max(500).optional(),
  paymentMethod: z.string().trim().max(40).optional(),
  split: splitSchema.optional(),
});

export const incomeSchema = z.object({
  amount: paiseFromRupees,
  accountId: z.string().min(1),
  categoryId: z.string().nullable(),
  merchant: z.string().trim().max(120).transform((s) => s || "Income"),
  date: ymd,
  notes: z.string().trim().max(500).optional(),
});

export const transferSchema = z.object({
  amount: paiseFromRupees,
  fromAccountId: z.string().min(1),
  toAccountId: z.string().min(1),
  date: ymd,
  notes: z.string().trim().max(500).optional(),
});

export const settlementSchema = z.object({
  participantId: z.string().min(1),
  direction: z.enum(["TO_OWNER", "FROM_OWNER"]),
  amount: paiseFromRupees,
  method: z.enum(["UPI", "CASH", "BANK"]),
  note: z.string().trim().max(200).optional(),
});

export const budgetSchema = z.object({
  categoryId: z.string().nullable(),
  limit: paiseFromRupees,
});

export const accountSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(60),
  type: z.enum(["BANK", "CASH", "WALLET", "CREDIT_CARD", "INVESTMENT"]),
  openingBalance: z
    .union([z.string(), z.number()])
    .transform((v, ctx) => {
      const n = typeof v === "string" ? Number(String(v).replace(/[₹,\s]/g, "") || 0) : v;
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid opening balance" });
        return z.NEVER;
      }
      return Math.round(n * 100); // may be negative (credit card)
    }),
  bankName: z.string().trim().max(60).optional(),
});

export const billSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  amount: paiseFromRupees,
  categoryId: z.string().nullable(),
  dueDate: ymd,
  cadence: z.enum(["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"]).nullable(),
});

export const participantSchema = z.object({
  displayName: z.string().trim().min(1, "Name is required").max(60),
});

export const categorySchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(40),
  kind: z.enum(["EXPENSE", "INCOME"]),
});
