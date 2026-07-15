// Write-side of the ledger. Every mutation runs inside one DB transaction that
// updates account running balances and appends an audit row, so
// balance = openingBalance + Σ ledger always holds (PRD §4.1 AC).

import { splitByWeights, splitEqual, splitExact, type SplitShare } from "@/lib/money";
import { istNoon } from "@/lib/dates";
import type { Prisma, TxType } from "@prisma/client";
import { prisma } from "../db";
import { audit } from "./audit";
import { checkBudgetThresholds } from "./budgets";

type Db = Prisma.TransactionClient;

/** Balance effect of a transaction; sign=+1 applies, sign=−1 reverses (delete/undo). */
export async function applyBalances(
  db: Db,
  t: { type: TxType; amount: bigint | number; accountId: string | null; toAccountId: string | null },
  sign: 1 | -1
) {
  const amt = BigInt(Math.round(Number(t.amount))) * BigInt(sign);
  if (t.type === "EXPENSE" && t.accountId) {
    await db.account.update({ where: { id: t.accountId }, data: { balance: { decrement: amt } } });
  } else if (t.type === "INCOME" && t.accountId) {
    await db.account.update({ where: { id: t.accountId }, data: { balance: { increment: amt } } });
  } else if (t.type === "TRANSFER") {
    if (t.accountId) await db.account.update({ where: { id: t.accountId }, data: { balance: { decrement: amt } } });
    if (t.toAccountId) await db.account.update({ where: { id: t.toAccountId }, data: { balance: { increment: amt } } });
  }
}

export interface SplitInput {
  mode: "EQUAL" | "EXACT" | "PERCENT" | "RATIO";
  participantIds: string[]; // friends included in the split (owner is always included)
  payerParticipantId: string | null; // null ⇒ paid by owner
  exactAmounts?: Record<string, number>; // participantId → paise (EXACT mode, friends only)
  weights?: Record<string, number>; // participantId → weight, plus "me" for the owner (PERCENT/RATIO)
}

export interface ExpenseInput {
  amount: number; // paise
  accountId: string | null;
  categoryId: string | null;
  merchant: string;
  date: string; // YYYY-MM-DD
  notes?: string;
  paymentMethod?: string;
  isRecurring?: boolean;
  split?: SplitInput;
}

function computeShares(amount: number, split: SplitInput): SplitShare[] {
  const ids: (string | null)[] = [null, ...split.participantIds];
  if (split.mode === "EXACT") {
    const others = split.participantIds.map((id) => ({ participantId: id as string | null, owedAmount: split.exactAmounts?.[id] ?? 0 }));
    // payer absorbs remainder; when a friend paid, the owner's share is stated too
    if (split.payerParticipantId === null) return splitExact(amount, others, null);
    const withoutPayer = others.filter((o) => o.participantId !== split.payerParticipantId);
    return splitExact(amount, withoutPayer, split.payerParticipantId);
  }
  if (split.mode === "PERCENT" || split.mode === "RATIO") {
    const parts = [
      { participantId: null as string | null, weight: split.weights?.["me"] ?? 0 },
      ...split.participantIds.map((id) => ({ participantId: id as string | null, weight: split.weights?.[id] ?? 0 })),
    ];
    return splitByWeights(amount, parts, split.payerParticipantId);
  }
  return splitEqual(amount, ids, split.payerParticipantId);
}

export async function addExpense(userId: string, input: ExpenseInput) {
  // rule-based auto-categorization when no category picked
  let categoryId = input.categoryId;
  if (!categoryId && input.merchant) {
    const rule = await prisma.merchantRule.findUnique({
      where: { userId_merchant: { userId, merchant: input.merchant.toLowerCase().trim() } },
    });
    categoryId = rule?.categoryId ?? null;
  }

  const shares = input.split ? computeShares(input.amount, input.split) : null;
  const paidByParticipantId = input.split?.payerParticipantId ?? null;

  const tx = await prisma.$transaction(async (db) => {
    const t = await db.transaction.create({
      data: {
        userId,
        type: "EXPENSE",
        amount: input.amount,
        // when a friend paid, no money left the owner's accounts
        accountId: paidByParticipantId === null ? input.accountId : null,
        categoryId,
        merchant: input.merchant,
        occurredAt: istNoon(input.date),
        notes: input.notes || null,
        paymentMethod: input.paymentMethod || null,
        isRecurring: input.isRecurring ?? false,
        paidByParticipantId,
        splits: shares
          ? { create: shares.map((s) => ({ participantId: s.participantId, owedAmount: s.owedAmount, method: input.split!.mode })) }
          : undefined,
      },
    });
    await applyBalances(db, t, 1);
    await audit(db, userId, "create", "Transaction", t.id, undefined, t);
    return t;
  });

  // self-improving merchant rule when the user picked the category explicitly
  if (input.categoryId && input.merchant) {
    await prisma.merchantRule.upsert({
      where: { userId_merchant: { userId, merchant: input.merchant.toLowerCase().trim() } },
      create: { userId, merchant: input.merchant.toLowerCase().trim(), categoryId: input.categoryId },
      update: { categoryId: input.categoryId, hits: { increment: 1 } },
    });
  }

  if (categoryId) await checkBudgetThresholds(userId, categoryId);
  return tx.id;
}

export interface IncomeInput {
  amount: number;
  accountId: string;
  categoryId: string | null;
  merchant: string; // description, e.g. "Salary · Acme Corp"
  date: string;
  notes?: string;
}

export async function addIncome(userId: string, input: IncomeInput) {
  const tx = await prisma.$transaction(async (db) => {
    const t = await db.transaction.create({
      data: {
        userId,
        type: "INCOME",
        amount: input.amount,
        accountId: input.accountId,
        categoryId: input.categoryId,
        merchant: input.merchant,
        occurredAt: istNoon(input.date),
        notes: input.notes || null,
      },
    });
    await applyBalances(db, t, 1);
    await audit(db, userId, "create", "Transaction", t.id, undefined, t);
    return t;
  });
  return tx.id;
}

export interface TransferInput {
  amount: number;
  fromAccountId: string;
  toAccountId: string;
  date: string;
  notes?: string;
}

export async function addTransfer(userId: string, input: TransferInput) {
  if (input.fromAccountId === input.toAccountId) throw new Error("Pick two different accounts");
  const [from, to] = await Promise.all([
    prisma.account.findFirst({ where: { id: input.fromAccountId, userId } }),
    prisma.account.findFirst({ where: { id: input.toAccountId, userId } }),
  ]);
  if (!from || !to) throw new Error("Account not found");
  const tx = await prisma.$transaction(async (db) => {
    const t = await db.transaction.create({
      data: {
        userId,
        type: "TRANSFER",
        amount: input.amount,
        accountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        merchant: `${from.name} → ${to.name}`,
        occurredAt: istNoon(input.date),
        notes: input.notes || null,
      },
    });
    await applyBalances(db, t, 1);
    await audit(db, userId, "create", "Transaction", t.id, undefined, t);
    return t;
  });
  return tx.id;
}

/** Soft delete with undo (PRD §4.2): balances reverse exactly; restore re-applies. */
export async function softDeleteTransaction(userId: string, id: string) {
  await prisma.$transaction(async (db) => {
    const t = await db.transaction.findFirst({ where: { id, userId, deletedAt: null } });
    if (!t) throw new Error("Transaction not found");
    await db.transaction.update({ where: { id }, data: { deletedAt: new Date() } });
    await applyBalances(db, t, -1);
    await audit(db, userId, "soft-delete", "Transaction", id, t, undefined);
  });
}

export async function restoreTransaction(userId: string, id: string) {
  await prisma.$transaction(async (db) => {
    const t = await db.transaction.findFirst({ where: { id, userId, deletedAt: { not: null } } });
    if (!t) throw new Error("Transaction not found");
    await db.transaction.update({ where: { id }, data: { deletedAt: null } });
    await applyBalances(db, t, 1);
    await audit(db, userId, "restore", "Transaction", id, undefined, t);
  });
}
