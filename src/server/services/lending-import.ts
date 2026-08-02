// Khatabook → Lending import (v1.3.0).
//
// This is NOT a new lending engine. It maps a ledger export onto the existing
// Lending stack: rows become `LoanEntry` rows against `Participant` contacts,
// GOT repayments are settled with the same `allocateFifo` engine manual entry
// uses, and undo reuses `ImportBatch.createdEntities` exactly like backup
// restore. The Khatabook-specific knowledge lives entirely in the lib adapter;
// everything here is source-agnostic and would serve an OkCredit/Vyapar adapter
// unchanged.
//
// Performance: one contact lookup pass, one existing-ledger read, then bulk
// createMany for participants, entries and allocations inside a single
// transaction. No per-row queries — a 10k-row import is a handful of statements.

import { toYMD } from "@/lib/dates";
import { allocateFifo, type OpenLoan } from "@/lib/loan-settlement";
import { computeLoanBalances, type LoanEntryForBalance } from "@/lib/lending";
import { LENDING_ADAPTERS, lendingAdapterById } from "@/lib/import/lending/adapters";
import { resolveColumns } from "@/lib/import/lending/detect";
import { mapLendingRows, normalizeContactName } from "@/lib/import/lending/map";
import {
  assembleLendingPreview,
  dedupeKey,
  type ExistingContact,
  type LendingImportOptions,
  type LendingImportPreview,
} from "@/lib/import/lending/preview";
import { prisma } from "../db";
import type { Db } from "./audit";
import { audit } from "./audit";

/** Same id shape offline entity creation uses (offline-context `newEntityId`). */
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 24);

export interface LendingPreviewResult extends LendingImportPreview {
  adapterId: string;
  adapterLabel: string;
}

/** Reads the current ledger and assembles the shared plan/preview. No writes. */
export async function previewLendingImport(
  userId: string,
  rawRows: Record<string, unknown>[],
  adapterId: string,
  options: LendingImportOptions = {}
): Promise<LendingPreviewResult> {
  const adapter = lendingAdapterById(adapterId);
  if (!adapter) throw new Error("Unknown import source");

  const headers = rawRows.length ? Object.keys(rawRows[0]) : [];
  const cols = resolveColumns(headers, adapter);
  if (!cols) throw new Error(`This file doesn't have the columns a ${adapter.label} needs`);

  const mapped = mapLendingRows(rawRows, cols);

  const [participants, loanEntries] = await Promise.all([
    prisma.participant.findMany({ where: { ownerId: userId }, select: { id: true, displayName: true } }),
    prisma.loanEntry.findMany({
      where: { userId, deletedAt: null },
      select: { participantId: true, kind: true, amount: true, occurredAt: true },
    }),
  ]);

  const keyByPid = new Map(participants.map((p) => [p.id, normalizeContactName(p.displayName)]));
  const netByPid = new Map<string, number>();
  const existingEntryKeys = new Set<string>();
  for (const e of loanEntries) {
    const delta = e.kind === "GAVE" ? Number(e.amount) : -Number(e.amount);
    netByPid.set(e.participantId, (netByPid.get(e.participantId) ?? 0) + delta);
    const key = keyByPid.get(e.participantId);
    if (key) existingEntryKeys.add(dedupeKey(key, toYMD(e.occurredAt), e.kind, Number(e.amount)));
  }

  // One ExistingContact per normalized key (first participant wins if two
  // existing contacts already collide on case/spacing — a pre-existing dup).
  const existing: ExistingContact[] = [];
  const seenKeys = new Set<string>();
  for (const p of participants) {
    const key = normalizeContactName(p.displayName);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    existing.push({ id: p.id, key, displayName: p.displayName, netPaise: netByPid.get(p.id) ?? 0 });
  }

  const preview = assembleLendingPreview(mapped, existing, existingEntryKeys, options);
  return { ...preview, adapterId: adapter.id, adapterLabel: adapter.label };
}

export interface CommitLendingInput {
  rawRows: Record<string, unknown>[];
  adapterId: string;
  fileName: string;
  options?: LendingImportOptions;
}

export interface CommitLendingResult {
  batchId: string;
  contactsCreated: number;
  contactsMerged: number;
  contactsSkipped: number;
  entriesImported: number;
  duplicatesSkipped: number;
  invalidSkipped: number;
  totalGavePaise: number;
  totalGotPaise: number;
  netOutstandingPaise: number;
}

/**
 * Commits the whole import atomically. Re-derives the plan server-side (never
 * trusts a client-supplied one), bulk-writes, settles each contact with FIFO,
 * verifies the resulting balances against the plan to the paise, and rolls the
 * entire transaction back on any mismatch — there is no partial import.
 */
export async function commitLendingImport(userId: string, input: CommitLendingInput): Promise<CommitLendingResult> {
  const preview = await previewLendingImport(userId, input.rawRows, input.adapterId, input.options);

  return prisma.$transaction(async (db) => {
    const createdParticipants: string[] = [];
    const createdEntries: string[] = [];
    const createdAllocations: string[] = [];

    // ── Contacts: create the new ones, resolve merges to their existing id ──
    const pidByKey = new Map<string, string>();
    const participantRows: { id: string; ownerId: string; displayName: string }[] = [];
    for (const c of preview.contacts) {
      if (c.resolution === "skip") continue;
      if (c.resolution === "merge" && c.existingId) {
        pidByKey.set(c.key, c.existingId);
      } else {
        const id = newId();
        // Photo left null on purpose — never invent a placeholder avatar.
        participantRows.push({ id, ownerId: userId, displayName: c.displayName });
        createdParticipants.push(id);
        pidByKey.set(c.key, id);
      }
    }
    if (participantRows.length) await db.participant.createMany({ data: participantRows });

    // ── Entries: bulk insert with pre-generated ids so allocations can point at them ──
    interface PlannedInsert { id: string; kind: "GAVE" | "GOT"; amountPaise: number; ymd: string }
    const perContact = new Map<string, { existingId: string | null; entries: PlannedInsert[] }>();
    const entryRows: {
      id: string; userId: string; participantId: string; kind: "GAVE" | "GOT";
      amount: bigint; accountId: null; notes: string | null; occurredAt: Date;
    }[] = [];
    for (const c of preview.contacts) {
      if (c.resolution === "skip") continue;
      const pid = pidByKey.get(c.key)!;
      const entries: PlannedInsert[] = [];
      for (const e of c.entries) {
        if (!e.willImport) continue;
        const id = newId();
        entryRows.push({
          id,
          userId,
          participantId: pid,
          kind: e.kind,
          amount: BigInt(e.amountPaise),
          accountId: null, // funding source defaults to cash/unknown — never prompt during import
          notes: e.note, // Khatabook description preserved verbatim
          occurredAt: new Date(`${e.ymd}T00:00:00.000Z`),
        });
        createdEntries.push(id);
        entries.push({ id, kind: e.kind, amountPaise: e.amountPaise, ymd: e.ymd });
      }
      perContact.set(c.key, { existingId: c.resolution === "merge" ? c.existingId : null, entries });
    }
    if (entryRows.length) await db.loanEntry.createMany({ data: entryRows });

    // ── Settlement: FIFO per contact, over existing open loans + new GAVE, in
    //    chronological order — identical to entering each GOT by hand, but bulk.
    const allocationRows: { id: string; userId: string; gaveEntryId: string; gotEntryId: string; amount: bigint }[] = [];
    for (const [, { existingId, entries }] of perContact) {
      const openLoans: OpenLoan[] = existingId ? await loadOpenLoans(db, userId, existingId) : [];
      for (const e of entries) {
        if (e.kind === "GAVE") {
          openLoans.push({ id: e.id, amount: e.amountPaise, settledAmount: 0, occurredAt: e.ymd });
          continue;
        }
        for (const a of allocateFifo(e.amountPaise, openLoans)) {
          const id = newId();
          allocationRows.push({ id, userId, gaveEntryId: a.gaveEntryId, gotEntryId: e.id, amount: BigInt(a.amount) });
          createdAllocations.push(id);
          const loan = openLoans.find((l) => l.id === a.gaveEntryId);
          if (loan) loan.settledAmount += a.amount;
        }
      }
    }
    if (allocationRows.length) await db.loanAllocation.createMany({ data: allocationRows });

    const batch = await db.importBatch.create({
      data: {
        userId,
        source: input.adapterId,
        fileName: input.fileName,
        importedCount: createdEntries.length,
        skippedCount: preview.counts.skippedRows,
        errors: preview.invalid.length ? preview.invalid : undefined,
        createdEntities: { participants: createdParticipants, loanEntries: createdEntries, loanAllocations: createdAllocations },
        status: "COMMITTED",
      },
    });

    await verifyImportedBalances(db, userId, preview, pidByKey, createdEntries);

    // One activity/audit event — the timeline renders this as "Imported N
    // lending entries from Khatabook", linking to Import History.
    await audit(db, userId, "import", "ImportBatch", batch.id, undefined, {
      source: input.adapterId,
      lendingEntries: createdEntries.length,
      contacts: createdParticipants.length,
    });

    return {
      batchId: batch.id,
      contactsCreated: createdParticipants.length,
      contactsMerged: preview.contactsToMerge,
      contactsSkipped: preview.contactsToSkip,
      entriesImported: createdEntries.length,
      duplicatesSkipped: preview.counts.duplicateRows,
      invalidSkipped: preview.counts.invalidRows,
      totalGavePaise: preview.totals.gavePaise,
      totalGotPaise: preview.totals.gotPaise,
      netOutstandingPaise: preview.totals.netPaise,
    };
  });
}

/**
 * Contacts created by a still-committed lending import, mapped to a short
 * source label ("Khatabook"). Derived entirely from ImportBatch.createdEntities
 * — no schema change, no new column. The Contacts UI pairs this with the
 * contact's own emptiness (no photo/phone/notes) to show a "freshly migrated"
 * badge that clears the moment the user fills in any detail. Undone imports
 * drop out (status filter), and so do the contacts themselves.
 */
export async function importedContactSources(userId: string): Promise<Record<string, string>> {
  const ids = LENDING_ADAPTERS.map((a) => a.id);
  const batches = await prisma.importBatch.findMany({
    where: { userId, status: "COMMITTED", source: { in: ids } },
    select: { source: true, createdEntities: true },
  });
  const out: Record<string, string> = {};
  for (const b of batches) {
    const ce = b.createdEntities as { participants?: unknown } | null;
    const list = ce && Array.isArray(ce.participants) ? ce.participants : [];
    const label = b.source.charAt(0).toUpperCase() + b.source.slice(1);
    for (const pid of list) if (typeof pid === "string") out[pid] = label;
  }
  return out;
}

/** Existing open GAVE loans for a contact — the same shape/logic the manual path loads. */
async function loadOpenLoans(db: Db, userId: string, participantId: string): Promise<OpenLoan[]> {
  const [gave, allocations] = await Promise.all([
    db.loanEntry.findMany({
      where: { userId, participantId, kind: "GAVE", deletedAt: null },
      select: { id: true, amount: true, occurredAt: true },
    }),
    db.loanAllocation.findMany({
      where: { userId, gaveEntry: { participantId, deletedAt: null }, gotEntry: { deletedAt: null } },
      select: { gaveEntryId: true, amount: true },
    }),
  ]);
  const settled = new Map<string, number>();
  for (const a of allocations) settled.set(a.gaveEntryId, (settled.get(a.gaveEntryId) ?? 0) + Number(a.amount));
  return gave.map((g) => ({ id: g.id, amount: Number(g.amount), settledAmount: settled.get(g.id) ?? 0, occurredAt: toYMD(g.occurredAt) }));
}

/**
 * Balance verification (spec: "compare both totals; if they differ by even ₹1,
 * abort"). Confirms every imported row landed with its exact amount and
 * direction, and that each affected contact's post-import net equals the plan.
 * Any discrepancy throws, rolling back the whole transaction.
 */
async function verifyImportedBalances(
  db: Db,
  userId: string,
  preview: LendingImportPreview,
  pidByKey: Map<string, string>,
  createdEntryIds: string[]
): Promise<void> {
  // 1. Every planned row is in the database with the right amount/kind.
  const created = await db.loanEntry.findMany({
    where: { id: { in: createdEntryIds } },
    select: { kind: true, amount: true },
  });
  if (created.length !== createdEntryIds.length) {
    throw new Error("Import verification failed: not every entry was written");
  }
  let gave = 0;
  let got = 0;
  for (const e of created) {
    if (e.kind === "GAVE") gave += Number(e.amount);
    else got += Number(e.amount);
  }
  if (gave !== preview.totals.gavePaise || got !== preview.totals.gotPaise) {
    throw new Error("Import verification failed: imported totals don't match the preview");
  }

  // 2. Each affected contact's net, recomputed by the lending engine, matches the plan.
  const affected = preview.contacts.filter((c) => c.resolution !== "skip");
  const pids = [...new Set(affected.map((c) => pidByKey.get(c.key)!))];
  const entries = await db.loanEntry.findMany({
    where: { userId, participantId: { in: pids }, deletedAt: null },
    select: { participantId: true, kind: true, amount: true, dueDate: true },
  });
  const balances = computeLoanBalances(
    entries.map((e): LoanEntryForBalance => ({ participantId: e.participantId, kind: e.kind, amount: Number(e.amount), dueDate: e.dueDate }))
  );
  for (const c of affected) {
    const pid = pidByKey.get(c.key)!;
    const net = balances.get(pid)?.net ?? 0;
    if (net !== c.outstandingPaise) {
      throw new Error(`Import verification failed: ${c.displayName}'s balance doesn't reconcile`);
    }
  }
}
