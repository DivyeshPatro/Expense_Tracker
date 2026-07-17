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

/** Offline-sync intent metadata (offline-sync-spec §4.3). When present, the
 * mutation becomes exactly-once: an Intent row is inserted inside the same
 * $transaction; a unique-violation on (userId, intentId) means this intent
 * already applied, and the recorded outcome is returned without touching the
 * ledger. `entityId` lets the client pre-assign the transaction id. */
export interface IntentMeta {
  intentId: string;
  deviceId: string;
  deviceName?: string; // Phase 3: OK_OVERRIDE copy needs to name the device whose edit this replaced (spec §13)
  clientTs: string; // ISO — when the human acted
  entityId?: string; // create only: client pre-assigns the id
  baseVersion?: number; // update/delete only: entity version last seen locally (spec §4.2)
}

/** Outcome of a versioned update/delete: whether it landed cleanly or, for a
 * solo record, silently overrode a version it hadn't seen (LWW, spec §13 —
 * no prompt, both versions land in the audit log via the existing before/after). */
export interface MutateOutcome {
  overridden: boolean;
  overriddenByDevice?: string;
}

/** A queued edit/delete arriving after the entity itself was removed (by
 * another device, or genuinely gone) — distinct from a plain "not found" so
 * callers can map it to the right taxonomy code instead of a generic error. */
export class MutationTargetGoneError extends Error {
  constructor() {
    super("Transaction not found");
  }
}

/** Run a create inside one $transaction with the intent row as the last
 * write; on replay (P2002 + a recorded prior intent) return the original
 * outcome without touching the ledger. The single implementation every
 * intent-capable create shares. */
async function exactlyOnce(
  userId: string,
  intent: IntentMeta | undefined,
  kind: string,
  body: (db: Db) => Promise<{ id: string }>
): Promise<string> {
  try {
    const created = await prisma.$transaction(async (db) => {
      const t = await body(db);
      if (intent) {
        await db.intent.create({
          data: {
            id: intent.intentId,
            userId,
            deviceId: intent.deviceId,
            kind,
            entityId: t.id,
            status: "applied",
            clientTs: new Date(intent.clientTs),
          },
        });
      }
      return t;
    });
    return created.id;
  } catch (e) {
    // P2002 has two possible sources; the intent lookup disambiguates: a
    // recorded prior intent means replay (return its outcome), none means a
    // genuine conflict (rethrow).
    if (intent && typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002") {
      const prior = await prisma.intent.findUnique({ where: { userId_id: { userId, id: intent.intentId } } });
      if (prior) return prior.entityId;
    }
    throw e;
  }
}

/** bitemporal-lite (spec §4.2): audit records when the human acted too */
const withSyncMeta = <T extends object>(t: T, intent: IntentMeta | undefined) =>
  intent ? { ...t, _sync: { intentId: intent.intentId, deviceId: intent.deviceId, clientTs: intent.clientTs } } : t;

/** Update/delete counterpart to exactlyOnce(): there's no new row whose
 * unique constraint can catch a replay after the fact, so the Intent row is
 * checked BEFORE mutating — a duplicate delivery is a no-op that returns the
 * originally recorded outcome instead of re-applying (which would
 * double-reverse balances). The P2002 catch below covers the residual race
 * where two redeliveries of the same intent both pass the pre-check. */
async function exactlyOnceMutate(
  userId: string,
  intent: IntentMeta | undefined,
  kind: string,
  body: (db: Db) => Promise<{ entityId: string } & MutateOutcome>
): Promise<MutateOutcome> {
  if (intent) {
    const prior = await prisma.intent.findUnique({ where: { userId_id: { userId, id: intent.intentId } } });
    if (prior) return { overridden: prior.status === "overridden" };
  }
  try {
    return await prisma.$transaction(async (db) => {
      const r = await body(db);
      if (intent) {
        await db.intent.create({
          data: {
            id: intent.intentId,
            userId,
            deviceId: intent.deviceId,
            deviceName: intent.deviceName,
            kind,
            entityId: r.entityId,
            status: r.overridden ? "overridden" : "applied",
            clientTs: new Date(intent.clientTs),
          },
        });
      }
      return { overridden: r.overridden, overriddenByDevice: r.overriddenByDevice };
    });
  } catch (e) {
    if (intent && typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002") {
      const prior = await prisma.intent.findUnique({ where: { userId_id: { userId, id: intent.intentId } } });
      if (prior) return { overridden: prior.status === "overridden" };
    }
    throw e;
  }
}

/** Solo LWW check (spec §13, locked §19): no baseVersion means the caller
 * isn't intent-tracked (a plain online edit) — skip the check entirely, same
 * as always. A mismatch never blocks — it applies anyway and reports
 * `overridden: true` so the caller can log/notify, never prompt. */
async function checkOverride(
  db: Db,
  userId: string,
  entityId: string,
  baseVersion: number | undefined,
  serverVersion: number
): Promise<{ overridden: boolean; overriddenByDevice?: string }> {
  if (baseVersion === undefined || baseVersion === serverVersion) return { overridden: false };
  const priorIntent = await db.intent.findFirst({ where: { userId, entityId }, orderBy: { appliedAt: "desc" } });
  return { overridden: true, overriddenByDevice: priorIntent?.deviceName ?? undefined };
}

export async function addExpense(userId: string, input: ExpenseInput, intent?: IntentMeta) {
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

  const txId = await exactlyOnce(userId, intent, "expense.create", async (db) => {
    const t = await db.transaction.create({
      data: {
        // offline clients pre-assign the id so a replayed create is
        // structurally incapable of double-inserting (spec §5)
        ...(intent?.entityId ? { id: intent.entityId } : {}),
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
      // splits in the audit after-image — snapshots must be complete because
      // they can never be backfilled
      include: { splits: true },
    });
    await applyBalances(db, t, 1);
    await audit(db, userId, "create", "Transaction", t.id, undefined, withSyncMeta(t, intent));
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
  return txId;
}

export interface IncomeInput {
  amount: number;
  accountId: string;
  categoryId: string | null;
  merchant: string; // description, e.g. "Salary · Acme Corp"
  date: string;
  notes?: string;
}

export async function addIncome(userId: string, input: IncomeInput, intent?: IntentMeta) {
  return exactlyOnce(userId, intent, "income.create", async (db) => {
    const t = await db.transaction.create({
      data: {
        ...(intent?.entityId ? { id: intent.entityId } : {}),
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
    await audit(db, userId, "create", "Transaction", t.id, undefined, withSyncMeta(t, intent));
    return t;
  });
}

export interface TransferInput {
  amount: number;
  fromAccountId: string;
  toAccountId: string;
  date: string;
  notes?: string;
}

export async function addTransfer(userId: string, input: TransferInput, intent?: IntentMeta) {
  if (input.fromAccountId === input.toAccountId) throw new Error("Pick two different accounts");
  const [from, to] = await Promise.all([
    prisma.account.findFirst({ where: { id: input.fromAccountId, userId } }),
    prisma.account.findFirst({ where: { id: input.toAccountId, userId } }),
  ]);
  if (!from || !to) throw new Error("Account not found");
  return exactlyOnce(userId, intent, "transfer.create", async (db) => {
    const t = await db.transaction.create({
      data: {
        ...(intent?.entityId ? { id: intent.entityId } : {}),
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
    await audit(db, userId, "create", "Transaction", t.id, undefined, withSyncMeta(t, intent));
    return t;
  });
}

export interface TransactionDetail {
  id: string;
  type: TxType;
  amount: number; // paise
  accountId: string | null;
  accountName: string | null;
  toAccountId: string | null;
  toAccountName: string | null;
  categoryId: string | null;
  merchant: string;
  ymd: string; // YYYY-MM-DD
  notes: string | null;
  paidByParticipantId: string | null;
  isRecurring: boolean;
  splits: { participantId: string | null; owedAmount: number; method: string }[];
  version: number; // offline-sync baseVersion for edits/deletes (spec §4.2) — Phase 3
}

/** Full detail for the edit form — a fresh, richer read than the list's lean LedgerRow (which has just enough for display, not for reconstructing per-participant split amounts). */
export async function getTransactionDetail(userId: string, id: string): Promise<TransactionDetail | null> {
  const t = await prisma.transaction.findFirst({
    where: { id, userId, deletedAt: null },
    include: {
      account: { select: { name: true } },
      toAccount: { select: { name: true } },
      splits: { select: { participantId: true, owedAmount: true, method: true } },
    },
  });
  if (!t) return null;
  return {
    id: t.id,
    type: t.type,
    amount: Number(t.amount),
    accountId: t.accountId,
    accountName: t.account?.name ?? null,
    toAccountId: t.toAccountId,
    toAccountName: t.toAccount?.name ?? null,
    categoryId: t.categoryId,
    merchant: t.merchant,
    ymd: t.occurredAt.toISOString().slice(0, 10),
    notes: t.notes,
    paidByParticipantId: t.paidByParticipantId,
    isRecurring: t.isRecurring,
    splits: t.splits.map((s) => ({ participantId: s.participantId, owedAmount: Number(s.owedAmount), method: s.method })),
    version: t.version,
  };
}

/**
 * Update path for all three types mirrors create: reverse the transaction's
 * old balance effect, apply the edited fields, re-apply the new balance
 * effect — all inside one DB transaction so balance = openingBalance + Σ
 * ledger holds at every commit, exactly like softDeleteTransaction/
 * restoreTransaction below already do for delete/undo.
 */
export async function updateExpense(userId: string, id: string, input: ExpenseInput, intent?: IntentMeta) {
  const shares = input.split ? computeShares(input.amount, input.split) : null;
  const paidByParticipantId = input.split?.payerParticipantId ?? null;
  const newAccountId = paidByParticipantId === null ? input.accountId : null;

  const outcome = await exactlyOnceMutate(userId, intent, "expense.update", async (db) => {
    const old = await db.transaction.findFirst({ where: { id, userId, deletedAt: null }, include: { splits: true } });
    if (!old) throw new MutationTargetGoneError();
    if (old.type !== "EXPENSE") throw new Error("Not an expense");
    const { overridden, overriddenByDevice } = await checkOverride(db, userId, id, intent?.baseVersion, old.version);

    await applyBalances(db, old, -1);
    if (old.splits.length) await db.expenseSplit.deleteMany({ where: { txId: id } });

    const updated = await db.transaction.update({
      where: { id },
      data: {
        amount: input.amount,
        accountId: newAccountId,
        categoryId: input.categoryId,
        merchant: input.merchant,
        occurredAt: istNoon(input.date),
        notes: input.notes || null,
        paidByParticipantId,
        version: { increment: 1 }, // offline-sync conflict check (spec §4.2)
        splits: shares
          ? { create: shares.map((s) => ({ participantId: s.participantId, owedAmount: s.owedAmount, method: input.split!.mode })) }
          : undefined,
      },
      // splits included so the audit snapshot stays complete — `old` carries
      // them, and an after-image without them would be permanently blind for
      // history views (audit rows can't be backfilled)
      include: { splits: true },
    });
    await applyBalances(db, updated, 1);
    // solo LWW (spec §13): the override is never hidden — `old` is still the
    // clobbered version, so both land in this one audit row's before/after
    await audit(db, userId, "update", "Transaction", id, old, withSyncMeta(updated, intent));
    return { entityId: id, overridden, overriddenByDevice };
  });

  if (input.categoryId) await checkBudgetThresholds(userId, input.categoryId);
  return outcome;
}

export async function updateIncome(userId: string, id: string, input: IncomeInput, intent?: IntentMeta) {
  return exactlyOnceMutate(userId, intent, "income.update", async (db) => {
    const old = await db.transaction.findFirst({ where: { id, userId, deletedAt: null } });
    if (!old) throw new MutationTargetGoneError();
    if (old.type !== "INCOME") throw new Error("Not income");
    const { overridden, overriddenByDevice } = await checkOverride(db, userId, id, intent?.baseVersion, old.version);

    await applyBalances(db, old, -1);
    const updated = await db.transaction.update({
      where: { id },
      data: {
        amount: input.amount,
        accountId: input.accountId,
        categoryId: input.categoryId,
        merchant: input.merchant,
        occurredAt: istNoon(input.date),
        notes: input.notes || null,
        version: { increment: 1 }, // offline-sync conflict check (spec §4.2)
      },
    });
    await applyBalances(db, updated, 1);
    await audit(db, userId, "update", "Transaction", id, old, withSyncMeta(updated, intent));
    return { entityId: id, overridden, overriddenByDevice };
  });
}

export async function updateTransfer(userId: string, id: string, input: TransferInput, intent?: IntentMeta) {
  if (input.fromAccountId === input.toAccountId) throw new Error("Pick two different accounts");
  const [from, to] = await Promise.all([
    prisma.account.findFirst({ where: { id: input.fromAccountId, userId } }),
    prisma.account.findFirst({ where: { id: input.toAccountId, userId } }),
  ]);
  if (!from || !to) throw new Error("Account not found");

  return exactlyOnceMutate(userId, intent, "transfer.update", async (db) => {
    const old = await db.transaction.findFirst({ where: { id, userId, deletedAt: null } });
    if (!old) throw new MutationTargetGoneError();
    if (old.type !== "TRANSFER") throw new Error("Not a transfer");
    const { overridden, overriddenByDevice } = await checkOverride(db, userId, id, intent?.baseVersion, old.version);

    await applyBalances(db, old, -1);
    const updated = await db.transaction.update({
      where: { id },
      data: {
        amount: input.amount,
        accountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        merchant: `${from.name} → ${to.name}`,
        occurredAt: istNoon(input.date),
        notes: input.notes || null,
        version: { increment: 1 }, // offline-sync conflict check (spec §4.2)
      },
    });
    await applyBalances(db, updated, 1);
    await audit(db, userId, "update", "Transaction", id, old, withSyncMeta(updated, intent));
    return { entityId: id, overridden, overriddenByDevice };
  });
}

/** Soft delete with undo (PRD §4.2): balances reverse exactly; restore re-applies.
 * Deleting an already-deleted (or already-gone) row is idempotent-OK (spec §5
 * DUPLICATE philosophy applied to delete: the user's goal — "this shouldn't
 * exist" — is already satisfied), not a needs-attention failure. */
export async function softDeleteTransaction(userId: string, id: string, intent?: IntentMeta) {
  return exactlyOnceMutate(userId, intent, "tx.delete", async (db) => {
    const t = await db.transaction.findFirst({ where: { id, userId, deletedAt: null } });
    if (!t) return { entityId: id, overridden: false };
    const { overridden, overriddenByDevice } = await checkOverride(db, userId, id, intent?.baseVersion, t.version);
    await db.transaction.update({ where: { id }, data: { deletedAt: new Date() } });
    await applyBalances(db, t, -1);
    await audit(db, userId, "soft-delete", "Transaction", id, withSyncMeta(t, intent), undefined);
    return { entityId: id, overridden, overriddenByDevice };
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
