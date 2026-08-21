// Import engine service: preview (validate + dedupe), commit (one ImportBatch
// + Transactions, in-transaction balance updates), undo (soft-delete the
// batch), and remembered per-source mappings (Architecture doc §5).

import { DuplicateIndex, normalizeMerchant } from "@/lib/import/dedupe";
import { normalizeRow } from "@/lib/import/normalize";
import { UNCATEGORIZED, type ColumnMapping, type NormalizedRow, type PreviewRow, type RowStatus } from "@/lib/import/types";
import { Prisma } from "@prisma/client";
import { istNoon, toYMD } from "@/lib/dates";
import { prisma } from "../db";
import { audit } from "./audit";
import { applyBalances } from "./transactions";

// commit/undo loop sequentially over every row (each a create + balance
// update round trip) inside one DB transaction so a partial failure never
// leaves balances or the batch half-applied. Prisma's default interactive
// transaction timeout is 5s, which a real multi-year import blows through —
// hence the generous explicit timeout here (Architecture doc's "robust
// migration engine" needs to hold for a few thousand rows, not just a demo file).
const TX_OPTIONS = { timeout: 300_000, maxWait: 15_000 };

export async function getSavedMapping(userId: string, source: string) {
  return prisma.importMapping.findUnique({ where: { userId_source: { userId, source } } });
}

export interface PreviewResult {
  rows: PreviewRow[];
  distinctCategories: string[];
  distinctAccounts: string[];
  counts: { valid: number; duplicate: number; invalid: number };
}

/** Validates + dedupes raw rows against a mapping. Pure preview — writes nothing. */
export async function previewImport(userId: string, rawRows: Record<string, unknown>[], mapping: ColumnMapping): Promise<PreviewResult> {
  const existing = await prisma.transaction.findMany({
    where: { userId, deletedAt: null },
    select: { occurredAt: true, amount: true, merchant: true },
  });
  const dupIndex = new DuplicateIndex(existing.map((t) => ({ ymd: toYMD(t.occurredAt), amountPaise: Number(t.amount), merchant: t.merchant })));

  const rows: PreviewRow[] = rawRows.map((raw, i) => {
    const n = normalizeRow(raw, i, mapping);
    const { status, reason } = validate(n);
    let final: RowStatus = status;
    if (status === "valid" && dupIndex.isDuplicate({ ymd: n.ymd!, amountPaise: n.amountPaise!, merchant: n.merchant! })) {
      final = "duplicate";
    }
    if (final === "valid") dupIndex.add({ ymd: n.ymd!, amountPaise: n.amountPaise!, merchant: n.merchant! });
    return { ...n, status: final, reason: final === "invalid" ? reason : final === "duplicate" ? "Matches an existing transaction" : null, skip: final !== "valid" };
  });

  const distinctCategories = [...new Set(rows.map((r) => r.categoryRaw).filter((v): v is string => !!v))];
  const distinctAccounts = [...new Set(rows.map((r) => r.accountRaw).filter((v): v is string => !!v))];
  const counts = {
    valid: rows.filter((r) => r.status === "valid").length,
    duplicate: rows.filter((r) => r.status === "duplicate").length,
    invalid: rows.filter((r) => r.status === "invalid").length,
  };
  return { rows, distinctCategories, distinctAccounts, counts };
}

function validate(n: NormalizedRow): { status: "valid" | "invalid"; reason: string | null } {
  const missing: string[] = [];
  if (!n.ymd) missing.push("date");
  if (!n.amountPaise) missing.push("amount");
  if (!n.type) missing.push("income/expense type");
  if (!n.merchant) missing.push("merchant");
  if (missing.length) return { status: "invalid", reason: `Couldn't read ${missing.join(", ")}` };
  return { status: "valid", reason: null };
}

export interface CommitInput {
  source: string;
  fileName: string;
  rows: PreviewRow[]; // final, user-edited rows; skip=true rows are excluded
  categoryMap: Record<string, string>; // raw category text -> categoryId ("" = auto-detect)
  accountMap: Record<string, string>; // raw account text -> accountId
  defaultAccountId: string | null; // used when a row has no account text at all
  mapping: ColumnMapping;
}

export interface CommitResult {
  batchId: string;
  imported: number;
  skipped: number;
}

export async function commitImport(userId: string, input: CommitInput): Promise<CommitResult> {
  const toImport = input.rows.filter((r) => !r.skip && r.status !== "invalid");
  const skipped = input.rows.length - toImport.length;

  const [merchantRules, categories] = await Promise.all([
    prisma.merchantRule.findMany({ where: { userId } }),
    prisma.category.findMany({ where: { userId } }),
  ]);
  const ruleByMerchant = new Map(merchantRules.map((r) => [normalizeMerchant(r.merchant), r.categoryId]));
  const categoryByName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));

  const resolveCategoryId = (row: PreviewRow): string | null => {
    if (row.categoryRaw && input.categoryMap[row.categoryRaw] === UNCATEGORIZED) return null;
    if (row.categoryRaw && input.categoryMap[row.categoryRaw]) return input.categoryMap[row.categoryRaw];
    // "auto-detect" for a source with its own category column: match that text
    // directly against the user's categories first — a stronger signal than
    // merchant guessing, and the right default for Monito-shaped exports.
    if (row.categoryRaw) {
      const direct = categoryByName.get(row.categoryRaw.toLowerCase());
      if (direct) return direct;
    }
    return ruleByMerchant.get(normalizeMerchant(row.merchant!)) ?? null;
  };

  const batch = await prisma.$transaction(async (db) => {
    const b = await db.importBatch.create({
      data: { userId, source: input.source, fileName: input.fileName, importedCount: 0, skippedCount: skipped, status: "COMMITTED" },
    });

    let imported = 0;
    for (const row of toImport) {
      const categoryId = resolveCategoryId(row);
      const accountId = (row.accountRaw ? input.accountMap[row.accountRaw] : null) || input.defaultAccountId || null;
      const notes = row.notes && row.notes !== row.merchant ? row.notes : null;

      const t = await db.transaction.create({
        data: {
          userId,
          type: row.type!,
          amount: row.amountPaise!,
          accountId,
          categoryId,
          merchant: row.merchant!,
          occurredAt: istNoon(row.ymd!),
          notes,
          paymentMethod: row.paymentMethod || null,
          importBatchId: b.id,
        },
      });
      await applyBalances(db, t, 1);
      imported++;
    }

    await db.importBatch.update({ where: { id: b.id }, data: { importedCount: imported } });
    const columnMapJson = input.mapping as unknown as Prisma.InputJsonValue;
    const categoryMapJson = input.categoryMap as unknown as Prisma.InputJsonValue;
    await db.importMapping.upsert({
      where: { userId_source: { userId, source: input.source } },
      create: { userId, source: input.source, columnMap: columnMapJson, categoryMap: categoryMapJson },
      update: { columnMap: columnMapJson, categoryMap: categoryMapJson },
    });
    await audit(db, userId, "import", "ImportBatch", b.id, undefined, { imported, skipped });
    return { batchId: b.id, imported, skipped };
  }, TX_OPTIONS);

  return batch;
}

export async function listImportBatches(userId: string) {
  return prisma.importBatch.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
}

export interface UndoResult {
  reversed: number;
  removedAccounts: number;
  removedCategories: number;
  /** Created entities kept because other data now depends on them. */
  retainedAccounts: string[];
  retainedCategories: string[];
  removedCreditCards: number;
  /** Khatabook → Lending imports: entries hard-deleted and contacts removed. */
  removedLendingEntries: number;
  removedContacts: number;
  /** Contacts kept because the user linked them to data outside this batch. */
  retainedContacts: string[];
}

/**
 * Undo: soft-delete every transaction in the batch, reverse its balance effect,
 * and drop the accounts/categories the batch itself created.
 * AC: re-import after undo produces zero duplicates.
 *
 * A backup restore can create accounts and categories (the CSV import only maps
 * onto existing ones). Those used to survive undo, so "fully undoable" wasn't
 * true — a restore permanently grew the account and category lists. They're now
 * removed, but only while nothing outside this batch references them: once the
 * user has spent from a restored account or filed a budget against a restored
 * category, deleting it would destroy data the undo was never asked to touch.
 * Anything kept for that reason is reported back so the UI can say so rather
 * than leaving the user to discover it.
 */
export async function undoImport(userId: string, batchId: string): Promise<UndoResult> {
  return prisma.$transaction(async (db) => {
    const batch = await db.importBatch.findFirst({ where: { id: batchId, userId } });
    if (!batch || batch.status !== "COMMITTED") throw new Error("Import batch not found or already undone");
    const txs = await db.transaction.findMany({ where: { importBatchId: batchId, deletedAt: null } });
    for (const t of txs) {
      await db.transaction.update({ where: { id: t.id }, data: { deletedAt: new Date() } });
      await applyBalances(db, t, -1);
    }

    const created = parseCreatedEntities(batch.createdEntities);
    // "Any transaction that isn't one of this batch's own rows." `importBatchId:
    // { not: batchId }` alone is wrong: in SQL, NULL != 'x' is NULL, not true, so
    // it silently excludes every hand-entered transaction — exactly the rows that
    // must protect a restored account from deletion.
    const notThisBatch = { OR: [{ importBatchId: null }, { importBatchId: { not: batchId } }] };
    const retainedAccounts: string[] = [];
    const retainedCategories: string[] = [];
    let removedAccounts = 0;
    let removedCategories = 0;

    // Categories first: a budget/rule on a restored category would otherwise
    // cascade-delete when the category goes, and cascades are exactly what this
    // guard exists to avoid.
    for (const id of created.categories) {
      const category = await db.category.findFirst({ where: { id, userId } });
      if (!category) continue;
      const [txRefs, budgetRefs, ruleRefs, billRefs] = await Promise.all([
        // The batch's own rows are soft-deleted but still carry categoryId, so
        // they must not count as a reference to themselves.
        db.transaction.count({ where: { categoryId: id, ...notThisBatch } }),
        db.budget.count({ where: { categoryId: id } }),
        db.merchantRule.count({ where: { categoryId: id } }),
        db.bill.count({ where: { categoryId: id } }),
      ]);
      if (txRefs + budgetRefs + ruleRefs + billRefs > 0) {
        retainedCategories.push(category.name);
        continue;
      }
      await db.category.delete({ where: { id } });
      removedCategories++;
    }

    for (const id of created.accounts) {
      const account = await db.account.findFirst({ where: { id, userId } });
      if (!account) continue;
      const [fromRefs, toRefs, budgetRefs, billRefs, loanRefs] = await Promise.all([
        db.transaction.count({ where: { accountId: id, ...notThisBatch } }),
        db.transaction.count({ where: { toAccountId: id, ...notThisBatch } }),
        db.budget.count({ where: { accountId: id } }),
        db.bill.count({ where: { accountId: id } }),
        db.loanEntry.count({ where: { accountId: id } }),
      ]);
      if (fromRefs + toRefs + budgetRefs + billRefs + loanRefs > 0) {
        retainedAccounts.push(account.name);
        continue;
      }
      // The batch's own soft-deleted rows still point here; detach them so the
      // delete can proceed without tripping the FK (they keep merchant/amount/
      // date, which is all the audit trail needs).
      await db.transaction.updateMany({ where: { importBatchId: batchId, accountId: id }, data: { accountId: null } });
      await db.transaction.updateMany({ where: { importBatchId: batchId, toAccountId: id }, data: { toAccountId: null } });
      await db.account.delete({ where: { id } });
      removedAccounts++;
    }

    // Cards restored by this batch go away outright. Unlike accounts and
    // categories there is no reference-counting to do — nothing in the schema
    // points at a CreditCard — so a card created by this restore can only be
    // this restore's, and a hard delete is both safe and what "undo" means.
    // Any the user edited since keep their new values; deleting the row is
    // still the right reversal of having created it.
    let removedCreditCards = 0;
    if (created.creditCards.length > 0) {
      const { count } = await db.creditCard.deleteMany({ where: { id: { in: created.creditCards }, userId } });
      removedCreditCards = count;
    }

    // Khatabook → Lending: the batch created participants, loan entries and
    // allocations (never transactions), tracked in createdEntities. Reverse
    // them hard — the same "undo is deletion of what the import created" rule
    // backup restore uses. Allocations first (though deleting the entries would
    // cascade them anyway), then the entries, then the contacts — but only
    // contacts nothing outside this batch has since come to depend on.
    let removedLendingEntries = 0;
    let removedContacts = 0;
    const retainedContacts: string[] = [];
    if (created.loanAllocations.length > 0) {
      await db.loanAllocation.deleteMany({ where: { id: { in: created.loanAllocations }, userId } });
    }
    if (created.loanEntries.length > 0) {
      const { count } = await db.loanEntry.deleteMany({ where: { id: { in: created.loanEntries }, userId } });
      removedLendingEntries = count;
    }
    for (const id of created.participants) {
      const participant = await db.participant.findFirst({ where: { id, ownerId: userId } });
      if (!participant) continue;
      // A contact this import created is normally referenced only by the loan
      // entries just deleted. Keep it only if the user has since linked it to
      // something else — a manual loan, a split, a settlement, a group, a paid-by.
      const [loanRefs, splitRefs, settleRefs, memberRefs, paidRefs] = await Promise.all([
        db.loanEntry.count({ where: { participantId: id } }),
        db.expenseSplit.count({ where: { participantId: id } }),
        // Either end counts: a member↔member settlement names its people in
        // fromParticipantId/toParticipantId, and deleting a contact still
        // referenced by one would orphan a real payment.
        db.settlement.count({ where: { OR: [{ participantId: id }, { fromParticipantId: id }, { toParticipantId: id }] } }),
        db.groupMember.count({ where: { participantId: id } }),
        db.transaction.count({ where: { paidByParticipantId: id } }),
      ]);
      if (loanRefs + splitRefs + settleRefs + memberRefs + paidRefs > 0) {
        retainedContacts.push(participant.displayName);
        continue;
      }
      await db.participant.delete({ where: { id } });
      removedContacts++;
    }

    await db.importBatch.update({ where: { id: batchId }, data: { status: "UNDONE", createdEntities: Prisma.DbNull } });
    const result: UndoResult = {
      reversed: txs.length,
      removedAccounts,
      removedCategories,
      retainedAccounts,
      retainedCategories,
      removedCreditCards,
      removedLendingEntries,
      removedContacts,
      retainedContacts,
    };
    await audit(db, userId, "undo-import", "ImportBatch", batchId, undefined, { ...result });
    return result;
  }, TX_OPTIONS);
}

function parseCreatedEntities(value: unknown): {
  accounts: string[];
  categories: string[];
  creditCards: string[];
  participants: string[];
  loanEntries: string[];
  loanAllocations: string[];
} {
  const empty = { accounts: [], categories: [], creditCards: [], participants: [], loanEntries: [], loanAllocations: [] };
  if (typeof value !== "object" || value === null) return empty;
  const v = value as Record<string, unknown>;
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((i): i is string => typeof i === "string") : []);
  // creditCards is absent from batches recorded before v2 backups existed, and
  // the lending keys from before v1.3.0 Khatabook imports — those batches undo
  // exactly as they always did.
  return {
    accounts: strings(v.accounts),
    categories: strings(v.categories),
    creditCards: strings(v.creditCards),
    participants: strings(v.participants),
    loanEntries: strings(v.loanEntries),
    loanAllocations: strings(v.loanAllocations),
  };
}
