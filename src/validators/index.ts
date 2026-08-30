// zod schemas — single source of truth for server actions (and future REST routes).
// All money enters as rupee strings and is parsed to integer paise here, at the boundary.

import { z } from "zod";
import { evaluateAmount } from "@/lib/expression";
import { toPaise } from "@/lib/money";
import {
  detectNetwork,
  isPlausibleLength,
  isValidCvv,
  isValidLuhn,
  networkLabel,
  normalizeCardNumber,
  parseExpiry,
} from "@/lib/card-identity";

/**
 * Rupee input → integer paise, accepting a calculator expression as well as a
 * plain number ("2500+18%" is as valid as "2950").
 *
 * Resolved HERE, at the boundary, rather than only in the amount field:
 *
 *  • Submission stopped depending on event ordering. The field resolved the
 *    expression on blur, so any path that submitted without blurring first
 *    sent the raw string in and got "Enter a valid amount" — while the preview
 *    directly above it read "= ₹2,950".
 *  • The offline outbox stores the payload verbatim. An expression queued
 *    while offline has to still resolve when it replays, possibly days later,
 *    and that replay never goes near the input.
 *
 * Safe to run server-side: evaluateAmount is a hand-written parser with no
 * eval, a 100-character input cap, and no regex backtracking — its only
 * possible output is a number or an error (see lib/expression.ts).
 */
export const paiseFromRupees = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    // Numbers keep the original, cheaper path — nothing to parse.
    if (typeof v === "number") {
      let n: number;
      try {
        n = toPaise(v);
      } catch {
        n = NaN;
      }
      if (!Number.isFinite(n) || n <= 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid amount" });
        return z.NEVER;
      }
      return n;
    }
    const result = evaluateAmount(v);
    if (!result.ok) {
      // Surface the parser's own message ("Can't divide by zero", "Missing a
      // closing bracket") — far more useful than a blanket "invalid amount".
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.error });
      return z.NEVER;
    }
    return result.paise;
  });

export const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date");

export const splitSchema = z.object({
  mode: z.enum(["EQUAL", "EXACT", "PERCENT", "RATIO"]),
  participantIds: z.array(z.string().min(1)).min(1, "Pick at least one friend to split with"),
  payerParticipantId: z.string().nullable(),
  // Keyed by participantId, plus "me" for the owner's own stated share, which
  // is read only when a friend paid (the owner's share is derived otherwise).
  exactAmounts: z.record(z.string(), z.number().int().nonnegative()).optional(),
  // Keyed by participantId, plus "me" for the owner's own weight — used by PERCENT/RATIO.
  weights: z.record(z.string(), z.number().positive()).optional(),
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
  // collaboration-architecture-rfc §2/§4 (migration step 4): tags the row as
  // collaborative, gated server-side by assertCanCreateInGroup.
  // v2.1: an edit MAY now reassign this (resolveGroupReassignment), which is
  // what makes an expense split with a group's members but saved as personal
  // repairable from the UI. Omitting the key still means "leave it alone" —
  // only an explicitly sent value can move a row between groups.
  groupId: z.string().min(1).nullable().optional(),
});

/** Offline-sync intent metadata (offline-sync-spec §4.3) — optional on
 * in-scope mutations; presence turns the mutation exactly-once. `baseVersion`
 * (update/delete only, Phase 3) drives the solo LWW-override check; `deviceName`
 * lets an overridden device's edit be named in OK_OVERRIDE copy (spec §13). */
export const intentMetaSchema = z.object({
  intentId: z.string().uuid(),
  deviceId: z.string().min(8).max(64),
  deviceName: z.string().trim().max(80).optional(),
  clientTs: z.string().datetime(),
  entityId: z.string().min(10).max(40).optional(),
  baseVersion: z.number().int().nonnegative().optional(),
});

export const expenseWithIntentSchema = expenseSchema.extend({ intent: intentMetaSchema.optional() });

export const incomeSchema = z.object({
  amount: paiseFromRupees,
  accountId: z.string().min(1),
  categoryId: z.string().nullable(),
  merchant: z.string().trim().max(120).transform((s) => s || "Income"),
  date: ymd,
  notes: z.string().trim().max(500).optional(),
  groupId: z.string().min(1).nullable().optional(),
});

export const transferSchema = z.object({
  amount: paiseFromRupees,
  fromAccountId: z.string().min(1),
  toAccountId: z.string().min(1),
  date: ymd,
  notes: z.string().trim().max(500).optional(),
  groupId: z.string().min(1).nullable().optional(),
});

export const incomeWithIntentSchema = incomeSchema.extend({ intent: intentMetaSchema.optional() });
export const transferWithIntentSchema = transferSchema.extend({ intent: intentMetaSchema.optional() });

/** v2.1 re-home: the minimal payload for moving an expense between a group and
 *  Personal. `null` means Personal. Deliberately carries nothing else, so this
 *  endpoint physically cannot alter an amount, payer or split. */
export const rehomeExpenseSchema = z.object({
  id: z.string().min(1),
  groupId: z.string().min(1).nullable(),
});

export const updateExpenseSchema = z.object({ id: z.string().min(1) }).merge(expenseSchema);
export const updateIncomeSchema = z.object({ id: z.string().min(1) }).merge(incomeSchema);
export const updateTransferSchema = z.object({ id: z.string().min(1) }).merge(transferSchema);

// Phase 3: offline edit/delete of already-synced records (offline-sync-spec §17)
export const updateExpenseWithIntentSchema = updateExpenseSchema.extend({ intent: intentMetaSchema.optional() });
export const updateIncomeWithIntentSchema = updateIncomeSchema.extend({ intent: intentMetaSchema.optional() });
export const updateTransferWithIntentSchema = updateTransferSchema.extend({ intent: intentMetaSchema.optional() });
export const deleteTransactionSchema = z.object({ id: z.string().min(1), intent: intentMetaSchema.optional() });

export const settlementSchema = z.object({
  participantId: z.string().min(1),
  direction: z.enum(["TO_OWNER", "FROM_OWNER"]),
  amount: paiseFromRupees,
  method: z.enum(["UPI", "CASH", "BANK"]),
  note: z.string().trim().max(200).optional(),
  // v2.0 P3: attributes the settlement to a group (validated server-side).
  groupId: z.string().min(1).optional(),
  // The account the money actually moved through. Optional: a repayment in
  // cash that never touched a tracked account stays a debt record only.
  accountId: z.string().min(1).optional(),
});

/**
 * A payment between two members, neither of them the owner (#240).
 *
 * Separate from settlementSchema rather than an optional extension of it,
 * because the two shapes have nothing in common beyond an amount: there is no
 * direction to pick (the pair IS the direction) and no account, since the
 * owner's money never moves. groupId is required — a member↔member payment only
 * makes sense against the ledger holding the debt it clears, and the group page
 * is the only place it can be started from.
 *
 * Every field is re-checked server-side by recordMemberSettlement: both people
 * must be the caller's own contacts, the group must be theirs, and both must be
 * in it. This schema only rejects what is malformed before it gets that far.
 */
export const memberSettlementSchema = z
  .object({
    groupId: z.string().min(1),
    fromParticipantId: z.string().min(1),
    toParticipantId: z.string().min(1),
    amount: paiseFromRupees,
    method: z.enum(["UPI", "CASH", "BANK"]),
    note: z.string().trim().max(200).optional(),
  })
  .refine((v) => v.fromParticipantId !== v.toParticipantId, {
    message: "A settlement needs two different people.",
    path: ["toParticipantId"],
  });

export const budgetSchema = z.object({
  categoryId: z.string().nullable(),
  limit: paiseFromRupees,
});

// lending-module-phase2: Card Vault fields — only meaningful when
// type === "CREDIT_CARD", drive Card Billing Intelligence's cycle math.
const cardDayField = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isInteger(n) || n < 1 || n > 31) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a day between 1 and 31" });
    return z.NEVER;
  }
  return n;
});
export const accountSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(60),
  type: z.enum(["BANK", "CASH", "WALLET", "CREDIT_CARD", "INVESTMENT"]),
  openingBalance: z
    .union([z.string(), z.number()])
    .transform((v, ctx) => {
      // v === "" -> Number("") === 0, same as toPaise's own behavior, so
      // this needs no special-casing beyond what toPaise already does.
      let n: number;
      try {
        n = toPaise(v);
      } catch {
        n = NaN;
      }
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid opening balance" });
        return z.NEVER;
      }
      return n; // may be negative (credit card)
    }),
  bankName: z.string().trim().max(60).optional(),
  cardNetwork: z.string().trim().max(30).optional(),
  cardLast4: z.string().trim().regex(/^\d{0,4}$/, "Last 4 digits only").optional(),
  statementDay: cardDayField.optional(),
  dueDay: cardDayField.optional(),
});

export const accountCardDetailsSchema = z.object({
  accountId: z.string().min(1),
  cardNetwork: z.string().trim().max(30).nullable().optional(),
  cardLast4: z.string().trim().regex(/^\d{0,4}$/, "Last 4 digits only").nullable().optional(),
  statementDay: cardDayField.nullable().optional(),
  dueDay: cardDayField.nullable().optional(),
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

export const renameCategorySchema = z.object({
  categoryId: z.string().min(1),
  name: z.string().trim().min(1, "Name is required").max(40),
});

export const changeCategoryKindSchema = z.object({
  categoryId: z.string().min(1),
  kind: z.enum(["EXPENSE", "INCOME"]),
});

export const categorySchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(40),
  kind: z.enum(["EXPENSE", "INCOME"]),
});

export const groupSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(60),
  participantIds: z.array(z.string().min(1)).min(1, "Pick at least one friend"),
});

export const groupMemberSchema = z.object({
  groupId: z.string().min(1),
  participantId: z.string().min(1),
  // true ⇒ a brand-new person just created (vs an existing contact linked in) —
  // drives the membership audit event copy.
  isNew: z.boolean().optional(),
});

// Lending module (Phase 1)
// lending-module-phase2: allocations is meaningful for GOT entries only —
// which prior GAVE entries this repayment settles. Omitted ⇒ server
// auto-allocates FIFO (oldest outstanding loan first); provided ⇒ manual
// override, validated against each loan's own remaining balance.
export const loanAllocationSchema = z.object({
  gaveEntryId: z.string().min(1),
  amount: paiseFromRupees,
});
export const loanEntrySchema = z.object({
  participantId: z.string().min(1, "Pick a contact"),
  kind: z.enum(["GAVE", "GOT"]),
  amount: paiseFromRupees,
  accountId: z.string().nullable(),
  reason: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(500).optional(),
  date: ymd,
  dueDate: ymd.nullable().optional(),
  allocations: z.array(loanAllocationSchema).optional(),
});
export const loanEntryWithIntentSchema = loanEntrySchema.extend({ intent: intentMetaSchema.optional() });
export const updateLoanEntrySchema = z.object({ id: z.string().min(1) }).merge(loanEntrySchema);
export const updateLoanEntryWithIntentSchema = updateLoanEntrySchema.extend({ intent: intentMetaSchema.optional() });
export const deleteLoanEntrySchema = z.object({ id: z.string().min(1), intent: intentMetaSchema.optional() });

export const participantDetailsSchema = z.object({
  participantId: z.string().min(1),
  displayName: z.string().trim().min(1, "Name is required").max(60).optional(),
  photo: z.string().trim().max(2000).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  email: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

// Recurring rules. Validated here rather than trusted from the client because
// this payload is stored and then replayed unattended by the nightly cron —
// malformed data written once fails every night, with nobody watching.
export const recurringRuleSchema = z
  .object({
    type: z.enum(["EXPENSE", "INCOME"]),
    amount: paiseFromRupees,
    accountId: z.string().min(1).nullable(),
    categoryId: z.string().min(1).nullable(),
    merchant: z.string().trim().min(1, "Give this a description").max(120),
    cadence: z.enum(["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"]),
    // Guards the catch-up loop as much as the user: interval 0 would never
    // advance nextRunAt and would spin against the per-run cap forever.
    interval: z.coerce.number().int().min(1, "Repeat every at least 1").max(99),
    startDate: ymd,
    endDate: ymd.nullable().optional(),
  })
  .refine((v) => !v.endDate || v.endDate >= v.startDate, {
    message: "End date can't be before the start date",
    path: ["endDate"],
  });

export const updateRecurringRuleSchema = z.object({ id: z.string().min(1) }).and(recurringRuleSchema);

/** Account rename — the only field of an existing account that's freely editable
 * (type and opening balance feed the balance invariant; card fields have their
 * own editor). */
export const accountNameSchema = z.string().trim().min(1, "Name is required").max(60);

export const updateBillSchema = z.object({ id: z.string().min(1) }).merge(billSchema);

// ─────────── Credit Cards (Phase 3.1) ───────────
// Validated here, at the boundary, because these values are encrypted
// immediately afterwards — a malformed number that reaches storage becomes
// ciphertext nobody can inspect without decrypting it first.

export const creditCardSchema = z
  .object({
    nickname: z.string().trim().min(1, "Give the card a nickname").max(60),
    bank: z.string().trim().min(1, "Which bank issued it?").max(60),
    cardholderName: z.string().trim().min(1, "Cardholder name is required").max(60),
    // Spaces and dashes are stripped: people paste card numbers in every format.
    cardNumber: z
      .string()
      .transform((v) => normalizeCardNumber(v))
      .pipe(z.string().regex(/^\d+$/, "Card number must be digits only")),
    expiryMonth: z.coerce.number().int(),
    expiryYear: z.coerce.number().int(),
    cvv: z.string().trim().regex(/^\d+$/, "CVV must be digits only"),
    // Auto-detected from the number when the client doesn't send one.
    network: z.enum(["VISA", "MASTERCARD", "RUPAY", "AMEX", "DINERS", "OTHER"]).optional(),
    color: z.string().trim().max(20).nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    isDefault: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    // Cross-field rules: the network decides both the plausible number length
    // and the CVV length, so they can only be checked once the number is known.
    const network = v.network ?? detectNetwork(v.cardNumber);

    if (!isValidLuhn(v.cardNumber)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cardNumber"], message: "That card number doesn't look right — check for a typo" });
    } else if (!isPlausibleLength(v.cardNumber, network)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cardNumber"], message: `That isn't the right number of digits for a ${networkLabel(network)} card` });
    }

    const expiry = parseExpiry(v.expiryMonth, v.expiryYear);
    if (!expiry.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiryMonth"], message: expiry.error });
    }

    if (!isValidCvv(v.cvv, network)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cvv"],
        message: network === "AMEX" ? "Amex CVVs are 4 digits" : "CVV must be 3 digits",
      });
    }
  });

export const updateCreditCardSchema = z.object({ id: z.string().min(1) }).and(creditCardSchema);
