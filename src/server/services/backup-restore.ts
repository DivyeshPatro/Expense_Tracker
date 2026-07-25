// Ledgerly Backup (.json) restore — additive-only: every restored row becomes
// a NEW row with a fresh id, relations are remapped to either a name-matched
// existing entity or a freshly created one, and the batch reuses the existing
// ImportBatch + Transaction.importBatchId undo mechanism (soft-delete by batch,
// same as the CSV import engine). No schema change required.
//
// Scope (this version): Accounts, Categories, Transactions — the core ledger.
// Lending, budgets, bills, settlements, recurring rules, tags and splits are
// exported into the backup for forward-completeness but are NOT yet restored
// here; restoring them safely needs either importBatchId parity on those tables
// or a different undo strategy, and that's deliberately deferred to keep this
// first cut low-risk and fully undoable with the infrastructure already in hand.

import type { Prisma } from "@prisma/client";
import { istNoon, toYMD } from "@/lib/dates";
import { DuplicateIndex } from "@/lib/import/dedupe";
import { prisma } from "../db";
import { audit } from "./audit";
import { applyBalances } from "./transactions";

export const BACKUP_FORMAT_VERSION = 1;
const TX_OPTIONS = { timeout: 300_000, maxWait: 15_000 };

interface BackupAccount {
  id?: string;
  name?: string;
  type?: string;
  bankName?: string | null;
  openingBalance?: number | string | null;
  balance?: number | string | null;
  color?: string | null;
  icon?: string | null;
  isArchived?: boolean | null;
  cardNetwork?: string | null;
  cardLast4?: string | null;
  statementDay?: number | null;
  dueDay?: number | null;
}

interface BackupCategory {
  id?: string;
  name?: string;
  kind?: string;
  icon?: string | null;
  color?: string | null;
}

interface BackupTransaction {
  id?: string;
  type?: string;
  amount?: number | string | null;
  accountId?: string | null;
  toAccountId?: string | null;
  categoryId?: string | null;
  merchant?: string;
  occurredAt?: string | null;
  notes?: string | null;
  location?: string | null;
  paymentMethod?: string | null;
  // importBatchId from the source is intentionally dropped — restored rows
  // belong to the NEW batch we create here, never the original.
}

export interface BackupPreview {
  formatVersion: number | null;
  transactions: number;
  validTransactions: number;
  duplicateTransactions: number;
  invalidTransactions: number;
  invalidBreakdown: Record<string, number>;
  newAccounts: number;
  matchedAccounts: number;
  newCategories: number;
  matchedCategories: number;
  /** Backup rows too incomplete to restore (no name, or no type/kind). */
  unusableAccounts: number;
  unusableCategories: number;
  earliest?: string | null;
  latest?: string | null;
  unsupported: string[];
  sample: { date: string | null; merchant: string | null; amount: number | null; type: string | null }[];
}

interface ClassifiedTransaction {
  ok: true;
  ymd: string;
  amountPaise: number;
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  merchant: string;
  data: BackupTransaction;
}

interface RejectedTransaction {
  ok: false;
  reason: string;
  data: BackupTransaction;
}

type Classified = ClassifiedTransaction | RejectedTransaction;

const VALID_TYPES = new Set(["EXPENSE", "INCOME", "TRANSFER"]);

export interface BackupCommitResult {
  batchId: string;
  imported: number;
  skipped: number;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNumber(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function paiseFrom(v: unknown): number | null {
  const n = asNumber(v);
  if (n === null) return null;
  const p = Math.round(n);
  // Ledgerly's Transaction.amount is stored as positive paise only. Zero or
  // negative values can't be imported without breaking balance invariants.
  return p > 0 ? p : null;
}

// Balances are NOT amounts: zero is legitimate and negative is meaningful
// (a credit card carrying a debt). paiseFrom would collapse both to null and
// silently zero out a restored card's opening position.
function balancePaise(v: unknown): number | null {
  const n = asNumber(v);
  return n === null ? null : Math.round(n);
}

export function classifyTransactions(
  transactions: BackupTransaction[],
  accountIdMap: Map<string, string>,
  categoryIdMap: Map<string, string>,
  dupIndex: DuplicateIndex
): Classified[] {
  const result: Classified[] = [];
  for (const t of transactions) {
    const type = asString(t.type)?.toUpperCase();
    if (!type || !VALID_TYPES.has(type)) {
      result.push({ ok: false, reason: "missing or unsupported type", data: t });
      continue;
    }
    const amountPaise = paiseFrom(t.amount);
    if (amountPaise === null) {
      result.push({ ok: false, reason: "amount missing or not a positive number", data: t });
      continue;
    }
    if (!t.merchant || asString(t.merchant)?.trim() === "") {
      result.push({ ok: false, reason: "merchant missing", data: t });
      continue;
    }
    const ymd = t.occurredAt ? toYMD(new Date(t.occurredAt)) : null;
    if (!ymd) {
      result.push({ ok: false, reason: "date missing or invalid", data: t });
      continue;
    }

    const accountId = resolveId(t.accountId, accountIdMap);
    if (t.accountId && accountId === null) {
      result.push({ ok: false, reason: "referenced account missing", data: t });
      continue;
    }

    let toAccountId: string | null = null;
    if (type === "TRANSFER") {
      toAccountId = resolveId(t.toAccountId, accountIdMap);
      if (t.toAccountId && toAccountId === null) {
        result.push({ ok: false, reason: "transfer destination account missing", data: t });
        continue;
      }
      // A transfer needs both sides to be meaningful relationship data.
      if (!t.accountId || !t.toAccountId) {
        result.push({ ok: false, reason: "transfer needs source and destination accounts", data: t });
        continue;
      }
    }

    if (dupIndex.isDuplicate({ ymd, amountPaise, merchant: t.merchant })) {
      result.push({ ok: false, reason: "duplicate", data: t });
      continue;
    }
    dupIndex.add({ ymd, amountPaise, merchant: t.merchant });

    result.push({
      ok: true,
      ymd,
      amountPaise,
      accountId,
      toAccountId,
      categoryId: resolveId(t.categoryId, categoryIdMap),
      merchant: t.merchant,
      data: t,
    });
  }
  return result;
}

function resolveId(id: string | null | undefined, map: Map<string, string>): string | null {
  if (!id) return null;
  return map.get(id) ?? null;
}

// ── Entity resolution plan ───────────────────────────────────────────────────
// Preview and commit MUST agree on exactly which backup ids are resolvable,
// otherwise the preview promises a row count the commit won't deliver. They
// used to build their id maps independently — preview mapped every account
// carrying an id, commit skipped the ones missing name/type — so a name/type-less
// account made preview count a row valid that commit then rejected as
// "referenced account missing".
//
// Both paths now derive their maps from this single planner, so the resolvable
// key set is identical by construction. Entries for entities that don't exist
// yet are seeded with the backup's own id as a placeholder; commit overwrites
// each one with the real id as it creates the row.

export interface RestorePlan {
  accountIdMap: Map<string, string>;
  categoryIdMap: Map<string, string>;
  /** Backup rows that have no counterpart yet and will be created on commit. */
  accountsToCreate: BackupAccount[];
  categoriesToCreate: BackupCategory[];
  matchedAccounts: number;
  matchedCategories: number;
  /** Rows too incomplete to match or create (missing name/type|kind). */
  unusableAccounts: number;
  unusableCategories: number;
}

export function planRestore(
  accounts: BackupAccount[],
  categories: BackupCategory[],
  existingAccounts: { id: string; name: string; type: string }[],
  existingCategories: { id: string; name: string; kind: string }[]
): RestorePlan {
  const accountKey = new Map(existingAccounts.map((a) => [`${a.name.toLowerCase()}|${a.type}`, a.id]));
  const categoryKey = new Map(existingCategories.map((c) => [`${c.name.toLowerCase()}|${c.kind}`, c.id]));

  const accountIdMap = new Map<string, string>();
  const accountsToCreate: BackupAccount[] = [];
  let matchedAccounts = 0;
  let unusableAccounts = 0;
  for (const a of accounts) {
    if (!a.name || !a.type) {
      unusableAccounts++;
      continue;
    }
    const key = `${a.name.toLowerCase()}|${a.type}`;
    const existingId = accountKey.get(key);
    if (existingId) {
      matchedAccounts++;
      if (a.id) accountIdMap.set(a.id, existingId);
      continue;
    }
    // Deduplicate within the backup itself: two rows with the same (name, type)
    // resolve to one created account, not two.
    const pending = accountsToCreate.find((p) => `${p.name!.toLowerCase()}|${p.type}` === key);
    if (pending) {
      if (a.id && pending.id) accountIdMap.set(a.id, pending.id);
      continue;
    }
    accountsToCreate.push(a);
    if (a.id) accountIdMap.set(a.id, a.id);
  }

  const categoryIdMap = new Map<string, string>();
  const categoriesToCreate: BackupCategory[] = [];
  let matchedCategories = 0;
  let unusableCategories = 0;
  for (const c of categories) {
    if (!c.name || !c.kind) {
      unusableCategories++;
      continue;
    }
    const key = `${c.name.toLowerCase()}|${c.kind}`;
    const existingId = categoryKey.get(key);
    if (existingId) {
      matchedCategories++;
      if (c.id) categoryIdMap.set(c.id, existingId);
      continue;
    }
    const pending = categoriesToCreate.find((p) => `${p.name!.toLowerCase()}|${p.kind}` === key);
    if (pending) {
      if (c.id && pending.id) categoryIdMap.set(c.id, pending.id);
      continue;
    }
    categoriesToCreate.push(c);
    if (c.id) categoryIdMap.set(c.id, c.id);
  }

  return {
    accountIdMap,
    categoryIdMap,
    accountsToCreate,
    categoriesToCreate,
    matchedAccounts,
    matchedCategories,
    unusableAccounts,
    unusableCategories,
  };
}

export function parseBackup(json: unknown): {
  formatVersion: number | null;
  accounts: BackupAccount[];
  categories: BackupCategory[];
  transactions: BackupTransaction[];
  unsupported: string[];
} {
  if (typeof json !== "object" || json === null) throw new Error("Not a valid Ledgerly backup file");
  const obj = json as Record<string, unknown>;
  const formatVersion = typeof obj.formatVersion === "number" ? obj.formatVersion : null;
  const accounts = Array.isArray(obj.accounts) ? (obj.accounts as BackupAccount[]) : [];
  const categories = Array.isArray(obj.categories) ? (obj.categories as BackupCategory[]) : [];
  const transactions = Array.isArray(obj.transactions) ? (obj.transactions as BackupTransaction[]) : [];
  const unsupported = Object.keys(obj).filter(
    (k) =>
      !["exportedAt", "formatVersion", "user", "accounts", "categories", "transactions"].includes(k)
  );
  return { formatVersion, accounts, categories, transactions, unsupported };
}

export async function previewBackupRestore(userId: string, json: unknown): Promise<BackupPreview> {
  const parsed = parseBackup(json);
  const [existingAccounts, existingCategories, existingTx] = await Promise.all([
    prisma.account.findMany({ where: { userId }, select: { id: true, name: true, type: true } }),
    prisma.category.findMany({ where: { userId }, select: { id: true, name: true, kind: true } }),
    prisma.transaction.findMany({
      where: { userId, deletedAt: null },
      select: { occurredAt: true, amount: true, merchant: true },
    }),
  ]);
  const plan = planRestore(parsed.accounts, parsed.categories, existingAccounts, existingCategories);
  const dupIndex = new DuplicateIndex(
    existingTx.map((t) => ({ ymd: toYMD(t.occurredAt), amountPaise: Number(t.amount), merchant: t.merchant }))
  );
  const classified = classifyTransactions(parsed.transactions, plan.accountIdMap, plan.categoryIdMap, dupIndex);

  const breakdown: Record<string, number> = {};
  let valid = 0, duplicate = 0;
  let earliest: string | null = null, latest: string | null = null;
  const sample: BackupPreview["sample"] = [];
  for (const c of classified) {
    if (!c.ok) {
      if (c.reason === "duplicate") {
        duplicate++;
      } else {
        breakdown[c.reason] = (breakdown[c.reason] || 0) + 1;
      }
      continue;
    }
    valid++;
    if (!earliest || c.ymd < earliest) earliest = c.ymd;
    if (!latest || c.ymd > latest) latest = c.ymd;
    if (sample.length < 5) sample.push({ date: c.ymd, merchant: c.merchant, amount: c.amountPaise, type: c.data.type! });
  }

  return {
    formatVersion: parsed.formatVersion,
    transactions: parsed.transactions.length,
    validTransactions: valid,
    duplicateTransactions: duplicate,
    invalidTransactions: Object.values(breakdown).reduce((a, b) => a + b, 0),
    invalidBreakdown: breakdown,
    newAccounts: plan.accountsToCreate.length,
    matchedAccounts: plan.matchedAccounts,
    newCategories: plan.categoriesToCreate.length,
    matchedCategories: plan.matchedCategories,
    unusableAccounts: plan.unusableAccounts,
    unusableCategories: plan.unusableCategories,
    earliest,
    latest,
    unsupported: parsed.unsupported,
    sample,
  };
}

export async function commitBackupRestore(userId: string, json: unknown): Promise<BackupCommitResult> {
  const parsed = parseBackup(json);
  const [existingAccounts, existingCategories, existingTx] = await Promise.all([
    prisma.account.findMany({ where: { userId } }),
    prisma.category.findMany({ where: { userId } }),
    prisma.transaction.findMany({
      where: { userId, deletedAt: null },
      select: { occurredAt: true, amount: true, merchant: true },
    }),
  ]);
  const plan = planRestore(parsed.accounts, parsed.categories, existingAccounts, existingCategories);
  const dupIndex = new DuplicateIndex(
    existingTx.map((t) => ({ ymd: toYMD(t.occurredAt), amountPaise: Number(t.amount), merchant: t.merchant }))
  );

  return prisma.$transaction(async (db) => {
    const b = await db.importBatch.create({
      data: { userId, source: "Ledgerly Backup", fileName: "ledgerly-backup.json", importedCount: 0, skippedCount: 0, status: "COMMITTED" },
    });

    // Accounts/categories the plan says don't exist yet. Creating them here and
    // overwriting the placeholder id keeps the resolvable key set identical to
    // what preview reported.
    const { accountIdMap, categoryIdMap } = plan;
    for (const a of plan.accountsToCreate) {
      const created = await db.account.create({
        data: {
          userId,
          name: a.name!,
          type: a.type as Prisma.AccountCreateInput["type"],
          bankName: asString(a.bankName ?? undefined) ?? null,
          // Seed at the account's OPENING position, never its exported closing
          // balance: applyBalances below replays every restored transaction onto
          // this account, so seeding with the closing balance (which already
          // reflects those transactions) counted each one twice and silently
          // corrupted the restored balance. schema.prisma states the invariant
          // this restores: balance = openingBalance + Σ ledger.
          openingBalance: balancePaise(a.openingBalance) ?? 0,
          balance: balancePaise(a.openingBalance) ?? 0,
          color: asString(a.color ?? undefined) ?? null,
          icon: asString(a.icon ?? undefined) ?? null,
          isArchived: !!a.isArchived,
          cardNetwork: asString(a.cardNetwork ?? undefined) ?? null,
          cardLast4: asString(a.cardLast4 ?? undefined) ?? null,
          statementDay: a.statementDay ?? null,
          dueDay: a.dueDay ?? null,
        },
      });
      if (a.id) accountIdMap.set(a.id, created.id);
    }

    for (const c of plan.categoriesToCreate) {
      const created = await db.category.create({
        data: {
          userId,
          name: c.name!,
          kind: c.kind as Prisma.CategoryCreateInput["kind"],
          icon: asString(c.icon ?? undefined) ?? null,
          color: asString(c.color ?? undefined) ?? null,
        },
      });
      if (c.id) categoryIdMap.set(c.id, created.id);
    }

    const classified = classifyTransactions(parsed.transactions, accountIdMap, categoryIdMap, dupIndex);
    let imported = 0, skipped = 0;
    for (const c of classified) {
      if (!c.ok) { skipped++; continue; }

      const created = await db.transaction.create({
        data: {
          userId,
          type: c.data.type as Prisma.TransactionCreateInput["type"],
          amount: c.amountPaise,
          accountId: c.accountId,
          toAccountId: c.toAccountId,
          categoryId: c.categoryId,
          merchant: c.merchant,
          occurredAt: istNoon(c.ymd),
          notes: asString(c.data.notes ?? undefined) ?? null,
          location: asString(c.data.location ?? undefined) ?? null,
          paymentMethod: asString(c.data.paymentMethod ?? undefined) ?? null,
          isRecurring: false,
          recurringRuleId: null,
          groupId: null,
          paidByParticipantId: null,
          importBatchId: b.id,
        },
      });
      await applyBalances(db, created, 1);
      imported++;
    }

    await db.importBatch.update({ where: { id: b.id }, data: { importedCount: imported, skippedCount: skipped } });
    await audit(db, userId, "backup-restore", "ImportBatch", b.id, undefined, { imported, skipped });
    return { batchId: b.id, imported, skipped };
  }, TX_OPTIONS);
}
