// Write-side of the ledger. Every mutation runs inside one DB transaction that
// updates account running balances and appends an audit row, so
// balance = openingBalance + Σ ledger always holds (PRD §4.1 AC).

import { splitByWeights, splitEqual, splitExact, type SplitShare } from "@/lib/money";
import { istNoon } from "@/lib/dates";
import type { GroupRole, Prisma, TxType } from "@prisma/client";
import { prisma } from "../db";
import { assertCanCreateInGroup, assertCanRead, assertCanWrite, resolveGroupRole, roleAtLeast } from "./authorization";
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
  groupId?: string | null; // collaboration-architecture-rfc §2/§4: creator becomes the row's own userId regardless
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
  // collaboration-architecture-rfc §2/§4: creating INTO a group needs MEMBER
  // role+; the creator becomes this row's own userId either way, so no
  // further per-field authorization applies to their own create
  if (input.groupId) await assertCanCreateInGroup(prisma, userId, input.groupId);

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
        groupId: input.groupId || null,
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
  groupId?: string | null;
}

export async function addIncome(userId: string, input: IncomeInput, intent?: IntentMeta) {
  if (input.groupId) await assertCanCreateInGroup(prisma, userId, input.groupId);
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
        groupId: input.groupId || null,
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
  groupId?: string | null;
}

export async function addTransfer(userId: string, input: TransferInput, intent?: IntentMeta) {
  if (input.fromAccountId === input.toAccountId) throw new Error("Pick two different accounts");
  if (input.groupId) await assertCanCreateInGroup(prisma, userId, input.groupId);
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
        groupId: input.groupId || null,
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
  // resolved server-side, same reasoning as participantName below — a
  // non-owning viewer has no reason to have this category in their OWN
  // refData.categories, so the client must never look it up locally
  categoryName: string | null;
  categoryIcon: string | null;
  merchant: string;
  ymd: string; // YYYY-MM-DD
  notes: string | null;
  paidByParticipantId: string | null;
  isRecurring: boolean;
  // participantName is resolved server-side, in the SAME namespace the split
  // itself lives in — never derived by the client matching against its own
  // (possibly unrelated) contact list, which is wrong the instant a
  // non-owning group member is the one viewing (collaboration-architecture-rfc §10)
  splits: { participantId: string | null; owedAmount: number; method: string; participantName: string | null }[];
  version: number; // offline-sync baseVersion for edits/deletes (spec §4.2) — Phase 3
  // collaboration-architecture-rfc §1/§2 (migration step 4) — precomputed
  // server-side from the same authorization the write path enforces, so the
  // UI never has to reimplement (or drift from) the role-rank rules
  userId: string;
  isOwner: boolean; // actingUserId === userId — the client's single source of truth for "is this mine"
  groupId: string | null;
  groupName: string | null;
  ownerName: string | null; // who this row is actually filed under — set only when the viewer isn't them
  viewerRole: GroupRole | null; // the viewer's role in the group, independent of row ownership
  canEditFields: boolean;
  canEditAccount: boolean;
  canDelete: boolean;
}

/** Full detail for the edit form — a fresh, richer read than the list's lean LedgerRow (which has just enough for display, not for reconstructing per-participant split amounts).
 *
 * collaboration-architecture-rfc §2/§10: an authorized group member who
 * doesn't own this row can read it, but never sees the owner's real account
 * name/type/balance-adjacent metadata — only a generic "{name}'s account"
 * form. An unauthorized reader gets exactly the same `null` a nonexistent
 * row would produce (never confirm existence to someone with no rights). */
export async function getTransactionDetail(actingUserId: string, id: string): Promise<TransactionDetail | null> {
  const t = await prisma.transaction.findFirst({
    where: { id, deletedAt: null },
    include: {
      account: { select: { name: true } },
      toAccount: { select: { name: true } },
      category: { select: { name: true, icon: true } },
      splits: { select: { participantId: true, owedAmount: true, method: true, participant: { select: { displayName: true } } } },
      user: { select: { name: true } },
      group: { select: { name: true } },
    },
  });
  if (!t) return null;
  try {
    await assertCanRead(prisma, actingUserId, t);
  } catch {
    return null;
  }
  const isOwner = t.userId === actingUserId;
  const viewerRole: GroupRole | null = t.groupId ? await resolveGroupRole(prisma, t.groupId, actingUserId) : null;
  const canEditFields = isOwner || roleAtLeast(viewerRole, "MEMBER");
  const canEditAccount = isOwner;
  const canDelete = isOwner || roleAtLeast(viewerRole, "ADMIN");

  const ownerFirstName = t.user.name.split(" ")[0] || t.user.name;
  const accountLabel = (realName: string | undefined | null) =>
    !realName ? null : isOwner ? realName : `${ownerFirstName}'s account`;
  return {
    id: t.id,
    type: t.type,
    amount: Number(t.amount),
    accountId: t.accountId,
    accountName: accountLabel(t.account?.name),
    toAccountId: t.toAccountId,
    toAccountName: accountLabel(t.toAccount?.name),
    categoryId: t.categoryId,
    categoryName: t.category?.name ?? null,
    categoryIcon: t.category?.icon ?? null,
    merchant: t.merchant,
    ymd: t.occurredAt.toISOString().slice(0, 10),
    notes: t.notes,
    paidByParticipantId: t.paidByParticipantId,
    isRecurring: t.isRecurring,
    splits: t.splits.map((s) => ({
      participantId: s.participantId,
      owedAmount: Number(s.owedAmount),
      method: s.method,
      participantName: s.participant?.displayName ?? null,
    })),
    version: t.version,
    userId: t.userId,
    isOwner,
    groupId: t.groupId,
    groupName: t.group?.name ?? null,
    ownerName: isOwner ? null : t.user.name,
    viewerRole,
    canEditFields,
    canEditAccount,
    canDelete,
  };
}

/**
 * Update path for all three types mirrors create: reverse the transaction's
 * old balance effect, apply the edited fields, re-apply the new balance
 * effect — all inside one DB transaction so balance = openingBalance + Σ
 * ledger holds at every commit, exactly like softDeleteTransaction/
 * restoreTransaction below already do for delete/undo.
 */
export async function updateExpense(actingUserId: string, id: string, input: ExpenseInput, intent?: IntentMeta) {
  const shares = input.split ? computeShares(input.amount, input.split) : null;
  const paidByParticipantId = input.split?.payerParticipantId ?? null;
  const newAccountId = paidByParticipantId === null ? input.accountId : null;
  let ownerUserId: string | undefined;

  const outcome = await exactlyOnceMutate(actingUserId, intent, "expense.update", async (db) => {
    const old = await db.transaction.findFirst({ where: { id, deletedAt: null }, include: { splits: true } });
    if (!old) throw new MutationTargetGoneError();
    if (old.type !== "EXPENSE") throw new Error("Not an expense");
    ownerUserId = old.userId;
    // collaboration-architecture-rfc §1: accountId is locked to the row's own
    // owner regardless of group role — only an actual change to it triggers
    // the stricter check (a resubmitted, unchanged value is not a "write")
    await assertCanWrite(db, actingUserId, old, newAccountId !== old.accountId ? "write-account" : "write");
    // NOTE: checkOverride is still scoped to a single actor's own Intent
    // history — intentionally unchanged here. Making it see a DIFFERENT
    // actor's prior edit (needed for real LWW-vs-CONFLICT resolution across
    // two people) is collaboration-architecture-rfc §6.1/§6.2, deliberately
    // deferred to the offline-sync layer step of the rollout (§12 step 5).
    const { overridden, overriddenByDevice } = await checkOverride(db, actingUserId, id, intent?.baseVersion, old.version);

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
    // clobbered version, so both land in this one audit row's before/after.
    // `old.userId` files the row under the ledger it belongs to; actingUserId
    // is recorded separately only when a group co-member did the editing
    // (collaboration-architecture-rfc §5).
    await audit(db, old.userId, "update", "Transaction", id, old, withSyncMeta(updated, intent), actingUserId);
    return { entityId: id, overridden, overriddenByDevice };
  });

  if (input.categoryId && ownerUserId) await checkBudgetThresholds(ownerUserId, input.categoryId);
  return outcome;
}

export async function updateIncome(actingUserId: string, id: string, input: IncomeInput, intent?: IntentMeta) {
  return exactlyOnceMutate(actingUserId, intent, "income.update", async (db) => {
    const old = await db.transaction.findFirst({ where: { id, deletedAt: null } });
    if (!old) throw new MutationTargetGoneError();
    if (old.type !== "INCOME") throw new Error("Not income");
    await assertCanWrite(db, actingUserId, old, input.accountId !== old.accountId ? "write-account" : "write");
    const { overridden, overriddenByDevice } = await checkOverride(db, actingUserId, id, intent?.baseVersion, old.version);

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
    await audit(db, old.userId, "update", "Transaction", id, old, withSyncMeta(updated, intent), actingUserId);
    return { entityId: id, overridden, overriddenByDevice };
  });
}

export async function updateTransfer(actingUserId: string, id: string, input: TransferInput, intent?: IntentMeta) {
  if (input.fromAccountId === input.toAccountId) throw new Error("Pick two different accounts");

  return exactlyOnceMutate(actingUserId, intent, "transfer.update", async (db) => {
    const old = await db.transaction.findFirst({ where: { id, deletedAt: null } });
    if (!old) throw new MutationTargetGoneError();
    if (old.type !== "TRANSFER") throw new Error("Not a transfer");
    const accountChanged = input.fromAccountId !== old.accountId || input.toAccountId !== old.toAccountId;
    await assertCanWrite(db, actingUserId, old, accountChanged ? "write-account" : "write");
    // resolved AFTER authorization, and against the transaction's own owner's
    // namespace (not the acting user's) — transfers move money between two
    // of the OWNER's own accounts regardless of who's editing (§1)
    const [from, to] = await Promise.all([
      db.account.findFirst({ where: { id: input.fromAccountId, userId: old.userId } }),
      db.account.findFirst({ where: { id: input.toAccountId, userId: old.userId } }),
    ]);
    if (!from || !to) throw new Error("Account not found");
    const { overridden, overriddenByDevice } = await checkOverride(db, actingUserId, id, intent?.baseVersion, old.version);

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
    await audit(db, old.userId, "update", "Transaction", id, old, withSyncMeta(updated, intent), actingUserId);
    return { entityId: id, overridden, overriddenByDevice };
  });
}

/** Soft delete with undo (PRD §4.2): balances reverse exactly; restore re-applies.
 * Deleting an already-deleted (or already-gone) row is idempotent-OK (spec §5
 * DUPLICATE philosophy applied to delete: the user's goal — "this shouldn't
 * exist" — is already satisfied), not a needs-attention failure. */
export async function softDeleteTransaction(actingUserId: string, id: string, intent?: IntentMeta) {
  return exactlyOnceMutate(actingUserId, intent, "tx.delete", async (db) => {
    // deleting an already-gone row is idempotent-OK (see the doc comment
    // above) — that check has to come before authorization, since there's no
    // row left to resolve a group role against, and "already achieved the
    // user's goal" is correct regardless of who's asking
    const t = await db.transaction.findFirst({ where: { id, deletedAt: null } });
    if (!t) return { entityId: id, overridden: false };
    await assertCanWrite(db, actingUserId, t, "delete");
    const { overridden, overriddenByDevice } = await checkOverride(db, actingUserId, id, intent?.baseVersion, t.version);
    await db.transaction.update({ where: { id }, data: { deletedAt: new Date() } });
    await applyBalances(db, t, -1);
    await audit(db, t.userId, "soft-delete", "Transaction", id, withSyncMeta(t, intent), undefined, actingUserId);
    return { entityId: id, overridden, overriddenByDevice };
  });
}

export async function restoreTransaction(actingUserId: string, id: string) {
  await prisma.$transaction(async (db) => {
    const t = await db.transaction.findFirst({ where: { id, deletedAt: { not: null } } });
    if (!t) throw new Error("Transaction not found");
    // undo-delete sits at the same permission tier as delete itself —
    // whoever could delete it can also undo their own (or another
    // authorized member's) delete
    await assertCanWrite(db, actingUserId, t, "delete");
    await db.transaction.update({ where: { id }, data: { deletedAt: null } });
    await applyBalances(db, t, 1);
    await audit(db, t.userId, "restore", "Transaction", id, undefined, t, actingUserId);
  });
}
