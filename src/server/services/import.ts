// Import engine service: preview (validate + dedupe), commit (one ImportBatch
// + Transactions, in-transaction balance updates), undo (soft-delete the
// batch), and remembered per-source mappings (Architecture doc §5).

import { DuplicateIndex, normalizeMerchant } from "@/lib/import/dedupe";
import { normalizeRow } from "@/lib/import/normalize";
import { UNCATEGORIZED, type ColumnMapping, type NormalizedRow, type PreviewRow, type RowStatus } from "@/lib/import/types";
import type { Prisma } from "@prisma/client";
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

export async function listSources(userId: string): Promise<string[]> {
  const rows = await prisma.importMapping.findMany({ where: { userId }, select: { source: true } });
  return rows.map((r) => r.source);
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

/** Undo: soft-delete every transaction in the batch and reverse its balance effect. AC: re-import after undo produces zero duplicates. */
export async function undoImport(userId: string, batchId: string): Promise<void> {
  await prisma.$transaction(async (db) => {
    const batch = await db.importBatch.findFirst({ where: { id: batchId, userId } });
    if (!batch || batch.status !== "COMMITTED") throw new Error("Import batch not found or already undone");
    const txs = await db.transaction.findMany({ where: { importBatchId: batchId, deletedAt: null } });
    for (const t of txs) {
      await db.transaction.update({ where: { id: t.id }, data: { deletedAt: new Date() } });
      await applyBalances(db, t, -1);
    }
    await db.importBatch.update({ where: { id: batchId }, data: { status: "UNDONE" } });
    await audit(db, userId, "undo-import", "ImportBatch", batchId, undefined, { reversed: txs.length });
  }, TX_OPTIONS);
}
