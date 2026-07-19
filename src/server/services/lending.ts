// Lending module (Phase 1): a personal, non-collaborative ledger of GAVE/GOT
// entries per contact — reuses Participant rather than a second person
// model. Running balance = Σ GAVE − Σ GOT, the same sign convention
// netBalances() already uses (positive ⇒ they owe you, negative ⇒ you owe
// them): "You Gave" always means money moved from the owner to the contact
// (a fresh loan OR repaying money the owner borrowed); "You Got" always
// means money moved from the contact to the owner (a repayment received OR
// money the owner borrowed). No separate direction concept needed.
//
// Offline-sync tier matches Transactions (exactlyOnce/exactlyOnceMutate),
// not the lighter Settlement tier, since the spec requires entries to be
// editable/deletable offline. Unlike transactions.ts's checkOverride,
// there's no group multi-actor branch here — Lending is personal-only, so
// every LoanEntry has exactly one legitimate actor and any version mismatch
// is always the same real person on a different device (silent LWW).

import { cache } from "react";
import { Prisma } from "@prisma/client";
import { currentMonthKey, istNoon, monthRange, shiftMonthKey } from "@/lib/dates";
import { computeLoanBalances } from "@/lib/lending";
import { allocateFifo, computeLoanStatus, validateManualAllocation, type LoanStatus, type OpenLoan } from "@/lib/loan-settlement";
import {
  cardExposure,
  computeCardRecovery,
  monthlyLending,
  monthlyRecoveries,
  outstandingTrend,
  overdueLoans as computeOverdueLoans,
  receivableVsPayable,
  topBorrowers,
  type CardExposureRow,
  type CardLoanForRecovery,
  type CardRecoverySummary,
  type LoanEntryForTrend,
  type OverdueLoanRow,
  type TopBorrowerRow,
} from "@/lib/lending-reports";
import { generateReminders, type LoanForReminder, type ReminderCandidate } from "@/lib/lending-reminders";
import { prisma } from "../db";
import { audit } from "./audit";

type Db = Prisma.TransactionClient;
type Queryable = Pick<Db, "loanEntry" | "loanAllocation">;

export interface LoanEntryIntentMeta {
  intentId: string;
  deviceId: string;
  deviceName?: string;
  clientTs: string;
  entityId?: string; // create only: client pre-assigns the id
  baseVersion?: number; // update/delete only
}

export interface MutateOutcome {
  overridden: boolean;
  overriddenByDevice?: string;
}

export class MutationTargetGoneError extends Error {
  constructor() {
    super("Loan entry not found");
  }
}

/** Mirrors transactions.ts's exactlyOnce, with one addition: runs Serializable
 * (via `serializable()` below), not a plain transaction — lending-module-
 * phase2: a GOT create reads "which loans are still open" and writes
 * allocations against them in the same transaction, and READ COMMITTED
 * would let two concurrent creates for the same contact both see the same
 * stale remaining-balance and over-allocate. GAVE creates pay the same
 * (harmless, negligible-contention) cost for a uniform code path. */
async function exactlyOnce(
  userId: string,
  intent: LoanEntryIntentMeta | undefined,
  kind: string,
  body: (db: Db) => Promise<{ id: string }>
): Promise<string> {
  try {
    const created = await serializable(async (db) => {
      const e = await body(db);
      if (intent) {
        await db.intent.create({
          data: { id: intent.intentId, userId, deviceId: intent.deviceId, kind, entityId: e.id, status: "applied", clientTs: new Date(intent.clientTs) },
        });
      }
      return e;
    });
    return created.id;
  } catch (e) {
    if (intent && typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002") {
      const prior = await prisma.intent.findUnique({ where: { userId_id: { userId, id: intent.intentId } } });
      if (prior) return prior.entityId;
    }
    throw e;
  }
}

const withSyncMeta = <T extends object>(t: T, intent: LoanEntryIntentMeta | undefined) =>
  intent ? { ...t, _sync: { intentId: intent.intentId, deviceId: intent.deviceId, clientTs: intent.clientTs } } : t;

const SERIALIZABLE_RETRY_LIMIT = 3;

function isSerializationFailure(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2034";
}

async function serializable<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (e) {
      if (isSerializationFailure(e) && attempt < SERIALIZABLE_RETRY_LIMIT) continue;
      throw e;
    }
  }
}

/** Mirrors transactions.ts's exactlyOnceMutate exactly. */
async function exactlyOnceMutate(
  userId: string,
  intent: LoanEntryIntentMeta | undefined,
  kind: string,
  body: (db: Db) => Promise<{ entityId: string } & MutateOutcome>
): Promise<MutateOutcome> {
  if (intent) {
    const prior = await prisma.intent.findUnique({ where: { userId_id: { userId, id: intent.intentId } } });
    if (prior) return { overridden: prior.status === "overridden" };
  }
  try {
    return await serializable(async (db) => {
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

/** Solo LWW only — see the file-level comment for why no ConflictError branch is needed. */
async function checkOverride(db: Db, entityId: string, version: number, baseVersion: number | undefined): Promise<MutateOutcome> {
  if (baseVersion === undefined || baseVersion === version) return { overridden: false };
  const priorIntent = await db.intent.findFirst({ where: { entityId }, orderBy: { appliedAt: "desc" } });
  return { overridden: true, overriddenByDevice: priorIntent?.deviceName ?? undefined };
}

export interface LoanEntryInput {
  participantId: string;
  kind: "GAVE" | "GOT";
  amount: number; // paise
  accountId: string | null;
  reason?: string;
  notes?: string;
  date: string; // YYYY-MM-DD
  dueDate?: string | null; // YYYY-MM-DD — meaningful for GAVE entries
  // lending-module-phase2: meaningful for GOT entries only. Omitted ⇒ FIFO
  // auto-allocation against the contact's open GAVE entries; provided ⇒
  // manual override, validated against each loan's own remaining balance.
  allocations?: { gaveEntryId: string; amount: number }[];
}

async function assertOwnedRefs(userId: string, input: Pick<LoanEntryInput, "participantId" | "accountId">) {
  const participant = await prisma.participant.findFirst({ where: { id: input.participantId, ownerId: userId } });
  if (!participant) throw new Error("Contact not found");
  if (input.accountId) {
    const account = await prisma.account.findFirst({ where: { id: input.accountId, userId } });
    if (!account) throw new Error("Account not found");
  }
}

/** Every still-live GAVE entry for a contact, with how much of each has
 * already been settled — a superset of the shape loan-settlement.ts's pure
 * functions expect (OpenLoan), plus reason/dueDate so openLoansForContact
 * (the allocation-picker UI's data source) doesn't need a second,
 * near-identical query just to get those two columns. Allocations are only
 * ever summed through a live (non-deleted) GOT entry, same
 * read-time-filters-through-soft-delete precedent as everywhere else in
 * this codebase — no cascade needed when a repayment is deleted. */
async function loadOpenLoans(
  db: Queryable,
  userId: string,
  participantId: string
): Promise<(OpenLoan & { reason: string | null; dueDate: Date | null })[]> {
  const [gaveEntries, allocations] = await Promise.all([
    db.loanEntry.findMany({
      where: { userId, participantId, kind: "GAVE", deletedAt: null },
      select: { id: true, amount: true, occurredAt: true, reason: true, dueDate: true },
    }),
    db.loanAllocation.findMany({
      where: { userId, gaveEntry: { participantId, deletedAt: null }, gotEntry: { deletedAt: null } },
      select: { gaveEntryId: true, amount: true },
    }),
  ]);
  const settledByLoan = new Map<string, number>();
  for (const a of allocations) settledByLoan.set(a.gaveEntryId, (settledByLoan.get(a.gaveEntryId) ?? 0) + Number(a.amount));
  return gaveEntries.map((g) => ({
    id: g.id,
    amount: Number(g.amount),
    settledAmount: settledByLoan.get(g.id) ?? 0,
    occurredAt: g.occurredAt.toISOString().slice(0, 10),
    reason: g.reason,
    dueDate: g.dueDate,
  }));
}

/** Computes (FIFO or manual) and persists the LoanAllocation rows for a GOT
 * entry against its contact's currently-open GAVE entries. Caller is
 * responsible for having already removed any prior allocations for this GOT
 * entry (see replaceAllocations) so loadOpenLoans reflects reality. */
async function applyAllocations(
  db: Queryable,
  userId: string,
  gotEntryId: string,
  participantId: string,
  repaymentAmount: number,
  manual: { gaveEntryId: string; amount: number }[] | undefined
): Promise<void> {
  const openLoans = await loadOpenLoans(db, userId, participantId);
  let toApply: { gaveEntryId: string; amount: number }[];
  if (manual && manual.length > 0) {
    const byId = new Map(openLoans.map((l) => [l.id, { amount: l.amount, settledAmount: l.settledAmount }]));
    const err = validateManualAllocation(repaymentAmount, manual, byId);
    if (err) throw new Error(err);
    toApply = manual;
  } else {
    toApply = allocateFifo(repaymentAmount, openLoans);
  }
  if (toApply.length > 0) {
    await db.loanAllocation.createMany({
      data: toApply.map((a) => ({ userId, gaveEntryId: a.gaveEntryId, gotEntryId, amount: a.amount })),
    });
  }
}

/** Update path: replace-all rather than a diff — simpler and always
 * consistent, whether the caller changed the amount, supplied a new manual
 * split, or neither (in which case this just re-runs FIFO against the same
 * open loans and typically reproduces the same allocation). */
async function replaceAllocations(
  db: Queryable,
  userId: string,
  gotEntryId: string,
  participantId: string,
  repaymentAmount: number,
  manual: { gaveEntryId: string; amount: number }[] | undefined
): Promise<void> {
  await db.loanAllocation.deleteMany({ where: { gotEntryId } });
  await applyAllocations(db, userId, gotEntryId, participantId, repaymentAmount, manual);
}

async function settledAmountForGave(db: Queryable, gaveEntryId: string): Promise<number> {
  const rows = await db.loanAllocation.findMany({ where: { gaveEntryId, gotEntry: { deletedAt: null } }, select: { amount: true } });
  return rows.reduce((s, r) => s + Number(r.amount), 0);
}

async function hasAnyAllocations(db: Queryable, loanEntryId: string): Promise<boolean> {
  const count = await db.loanAllocation.count({ where: { OR: [{ gaveEntryId: loanEntryId }, { gotEntryId: loanEntryId }] } });
  return count > 0;
}

export async function addLoanEntry(userId: string, input: LoanEntryInput, intent?: LoanEntryIntentMeta): Promise<string> {
  await assertOwnedRefs(userId, input);
  return exactlyOnce(userId, intent, "loan.create", async (db) => {
    const e = await db.loanEntry.create({
      data: {
        ...(intent?.entityId ? { id: intent.entityId } : {}),
        userId,
        participantId: input.participantId,
        kind: input.kind,
        amount: input.amount,
        accountId: input.accountId,
        reason: input.reason || null,
        notes: input.notes || null,
        dueDate: input.dueDate ? istNoon(input.dueDate) : null,
        occurredAt: istNoon(input.date),
      },
    });
    if (input.kind === "GOT") {
      await applyAllocations(db, userId, e.id, input.participantId, input.amount, input.allocations);
    }
    await audit(db, userId, "create", "LoanEntry", e.id, undefined, withSyncMeta(e, intent));
    return e;
  });
}

export async function updateLoanEntry(userId: string, id: string, input: LoanEntryInput, intent?: LoanEntryIntentMeta): Promise<MutateOutcome> {
  await assertOwnedRefs(userId, input);
  return exactlyOnceMutate(userId, intent, "loan.update", async (db) => {
    const old = await db.loanEntry.findFirst({ where: { id, userId, deletedAt: null } });
    if (!old) throw new MutationTargetGoneError();

    if (old.kind !== input.kind && (await hasAnyAllocations(db, id))) {
      throw new Error("Cannot change a loan's type once a repayment has been allocated to or from it");
    }
    if (input.kind === "GAVE") {
      const settled = await settledAmountForGave(db, id);
      if (input.amount < settled) {
        throw new Error("Cannot reduce this loan below its already-settled amount");
      }
    }

    const { overridden, overriddenByDevice } = await checkOverride(db, id, old.version, intent?.baseVersion);
    const updated = await db.loanEntry.update({
      where: { id },
      data: {
        participantId: input.participantId,
        kind: input.kind,
        amount: input.amount,
        accountId: input.accountId,
        reason: input.reason || null,
        notes: input.notes || null,
        dueDate: input.dueDate ? istNoon(input.dueDate) : null,
        occurredAt: istNoon(input.date),
        version: { increment: 1 },
      },
    });
    if (input.kind === "GOT") {
      await replaceAllocations(db, userId, id, input.participantId, input.amount, input.allocations);
    }
    await audit(db, userId, "update", "LoanEntry", id, old, withSyncMeta(updated, intent));
    return { entityId: id, overridden, overriddenByDevice };
  });
}

/** Idempotent-OK on an already-gone row, same reasoning as
 * softDeleteTransaction: "this shouldn't exist" is already satisfied. */
export async function deleteLoanEntry(userId: string, id: string, intent?: LoanEntryIntentMeta): Promise<MutateOutcome> {
  return exactlyOnceMutate(userId, intent, "loan.delete", async (db) => {
    const e = await db.loanEntry.findFirst({ where: { id, userId, deletedAt: null } });
    if (!e) return { entityId: id, overridden: false };
    const { overridden, overriddenByDevice } = await checkOverride(db, id, e.version, intent?.baseVersion);
    await db.loanEntry.update({ where: { id }, data: { deletedAt: new Date() } });
    await audit(db, userId, "soft-delete", "LoanEntry", id, withSyncMeta(e, intent), undefined);
    return { entityId: id, overridden, overriddenByDevice };
  });
}

export async function restoreLoanEntry(userId: string, id: string): Promise<void> {
  await serializable(async (db) => {
    const e = await db.loanEntry.findFirst({ where: { id, userId, deletedAt: { not: null } } });
    if (!e) throw new Error("Loan entry not found");
    await db.loanEntry.update({ where: { id }, data: { deletedAt: null } });
    await audit(db, userId, "restore", "LoanEntry", id, undefined, e);
  });
}

export interface LoanEntryRow {
  id: string;
  participantId: string;
  participantName: string;
  kind: "GAVE" | "GOT";
  amount: number; // paise
  accountId: string | null;
  accountName: string | null;
  reason: string | null;
  notes: string | null;
  dueDate: string | null; // YYYY-MM-DD
  ymd: string;
  version: number;
}

export async function listLoanEntries(userId: string, opts: { participantId?: string; limit?: number } = {}): Promise<LoanEntryRow[]> {
  const rows = await prisma.loanEntry.findMany({
    where: { userId, deletedAt: null, participantId: opts.participantId },
    include: { participant: { select: { displayName: true } }, account: { select: { name: true } } },
    orderBy: { occurredAt: "desc" },
    take: opts.limit ?? 100,
  });
  return rows.map((e) => ({
    id: e.id,
    participantId: e.participantId,
    participantName: e.participant.displayName,
    kind: e.kind,
    amount: Number(e.amount),
    accountId: e.accountId,
    accountName: e.account?.name ?? null,
    reason: e.reason,
    notes: e.notes,
    dueDate: e.dueDate ? e.dueDate.toISOString().slice(0, 10) : null,
    ymd: e.occurredAt.toISOString().slice(0, 10),
    version: e.version,
  }));
}

const AVATAR_COLORS = ["#6d5ae6", "#0f766e", "#d1497e", "#b97d10", "#1d4ed8", "#dc2626"];

export interface LendingParticipantView {
  id: string;
  name: string;
  initial: string;
  color: string;
  net: number; // paise: positive ⇒ they owe you, negative ⇒ you owe them
  linkedUserId: string | null;
  photo: string | null;
  phone: string | null;
  notes: string | null;
  overdueCount: number;
  entryCount: number;
  lastTransactionYmd: string | null;
}

// Wrapped in React's per-request cache: the Dashboard summary and the
// Contacts list both need this in the same request — dedupes the second
// fetch instead of hitting Postgres twice, same reasoning as netBalances().
export const lendingBalances = cache(async (userId: string): Promise<LendingParticipantView[]> => {
  const [participants, entries] = await Promise.all([
    prisma.participant.findMany({ where: { ownerId: userId }, orderBy: { displayName: "asc" } }),
    prisma.loanEntry.findMany({
      where: { userId, deletedAt: null },
      select: { participantId: true, kind: true, amount: true, dueDate: true, occurredAt: true },
    }),
  ]);

  const balances = computeLoanBalances(
    entries.map((e) => ({
      participantId: e.participantId,
      kind: e.kind,
      amount: Number(e.amount),
      dueDate: e.dueDate,
      ymd: e.occurredAt.toISOString().slice(0, 10),
    }))
  );

  return participants
    .filter((p) => balances.has(p.id))
    .map((p) => {
      const b = balances.get(p.id)!;
      return {
        id: p.id,
        name: p.displayName,
        initial: p.displayName.charAt(0).toUpperCase(),
        color: p.color ?? AVATAR_COLORS[0],
        net: b.net,
        linkedUserId: p.linkedUserId,
        photo: p.photo,
        phone: p.phone,
        notes: p.notes,
        overdueCount: b.overdueCount,
        entryCount: b.entryCount,
        lastTransactionYmd: b.lastTransactionYmd,
      };
    });
});

export interface LendingDashboardSummary {
  youAreOwed: number;
  youOwe: number;
  net: number;
  overdueCount: number;
  contacts: LendingParticipantView[];
}

export async function lendingDashboardSummary(userId: string): Promise<LendingDashboardSummary> {
  const contacts = await lendingBalances(userId);
  const youAreOwed = contacts.filter((c) => c.net > 0).reduce((s, c) => s + c.net, 0);
  const youOwe = contacts.filter((c) => c.net < 0).reduce((s, c) => s - c.net, 0);
  const overdueCount = contacts.reduce((s, c) => s + c.overdueCount, 0);
  // sorted by |balance| desc, largest outstanding first (Contacts screen requirement)
  const sorted = [...contacts].sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  return { youAreOwed, youOwe, net: youAreOwed - youOwe, overdueCount, contacts: sorted };
}

/** No participant-edit function exists today (addParticipant in shared.ts is
 * create-only) — Contacts screen needs one for photo/phone/notes. Undefined
 * fields leave the existing value untouched; pass null explicitly to clear. */
export async function updateParticipantDetails(
  userId: string,
  participantId: string,
  data: { displayName?: string; photo?: string | null; phone?: string | null; notes?: string | null }
) {
  const p = await prisma.participant.findFirst({ where: { id: participantId, ownerId: userId } });
  if (!p) throw new Error("Contact not found");
  // displayName is shared with Shared Expenses (same Participant row) — a
  // rename here updates everywhere that reads it, by construction, never a
  // second copy of the name.
  return prisma.participant.update({
    where: { id: participantId },
    data: {
      displayName: data.displayName === undefined ? p.displayName : data.displayName,
      photo: data.photo === undefined ? p.photo : data.photo,
      phone: data.phone === undefined ? p.phone : data.phone,
      notes: data.notes === undefined ? p.notes : data.notes,
    },
  });
}

// ─────────────────────── Lending module (Phase 2) ───────────────────────

export interface OpenLoanRow {
  id: string;
  amount: number;
  settledAmount: number;
  remainingAmount: number;
  occurredAt: string; // YYYY-MM-DD
  reason: string | null;
  dueDate: string | null;
  status: LoanStatus;
}

/** Open/partial GAVE entries for a contact, oldest-first — the allocation UI's
 * data source (both the FIFO preview and the manual-override loan picker). */
export async function openLoansForContact(userId: string, participantId: string): Promise<OpenLoanRow[]> {
  const openLoans = await loadOpenLoans(prisma, userId, participantId);
  const now = new Date();
  return openLoans
    .map((l) => {
      const { remainingAmount, status } = computeLoanStatus(l.amount, l.settledAmount, l.dueDate, now);
      return {
        id: l.id,
        amount: l.amount,
        settledAmount: l.settledAmount,
        remainingAmount,
        occurredAt: l.occurredAt,
        reason: l.reason,
        dueDate: l.dueDate ? l.dueDate.toISOString().slice(0, 10) : null,
        status,
      };
    })
    .filter((l) => l.remainingAmount > 0)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

export interface RelatedAllocationRow {
  loanEntryId: string; // GAVE detail: the GOT entry that paid it; GOT detail: the GAVE entry it paid
  amount: number;
  ymd: string;
  reason: string | null;
}

export interface LoanDetailView {
  id: string;
  participantId: string;
  participantName: string;
  kind: "GAVE" | "GOT";
  amount: number; // original amount (GAVE) or repayment amount (GOT)
  accountId: string | null;
  accountName: string | null;
  reason: string | null;
  notes: string | null;
  dueDate: string | null; // GAVE only
  occurredAt: string;
  createdAt: string;
  version: number;
  settledAmount: number; // GAVE only, 0 for GOT
  remainingAmount: number; // GAVE only, 0 for GOT
  status: LoanStatus | null; // null for GOT — repayments aren't themselves "statused"
  relatedAllocations: RelatedAllocationRow[];
}

/** Priority 2 (Loan Detail Experience) — full drill-down for a single loan
 * (GAVE) or repayment (GOT). Two shapes behind one function since the UI
 * shows a "repayment detail" mode for GOT entries (which loan(s) it paid)
 * rather than duplicating this query shape per-kind. */
export async function getLoanDetail(userId: string, loanEntryId: string): Promise<LoanDetailView> {
  const entry = await prisma.loanEntry.findFirst({
    where: { id: loanEntryId, userId, deletedAt: null },
    include: { participant: { select: { displayName: true } }, account: { select: { name: true } } },
  });
  if (!entry) throw new Error("Loan entry not found");

  const base = {
    id: entry.id,
    participantId: entry.participantId,
    participantName: entry.participant.displayName,
    amount: Number(entry.amount),
    accountId: entry.accountId,
    accountName: entry.account?.name ?? null,
    reason: entry.reason,
    notes: entry.notes,
    occurredAt: entry.occurredAt.toISOString().slice(0, 10),
    createdAt: entry.createdAt.toISOString(),
    version: entry.version,
  };

  if (entry.kind === "GAVE") {
    const allocations = await prisma.loanAllocation.findMany({
      where: { gaveEntryId: entry.id, gotEntry: { deletedAt: null } },
      include: { gotEntry: { select: { id: true, occurredAt: true, reason: true } } },
      orderBy: { createdAt: "asc" },
    });
    const settledAmount = allocations.reduce((s, a) => s + Number(a.amount), 0);
    const { remainingAmount, status } = computeLoanStatus(base.amount, settledAmount, entry.dueDate, new Date());
    return {
      ...base,
      kind: "GAVE",
      dueDate: entry.dueDate ? entry.dueDate.toISOString().slice(0, 10) : null,
      settledAmount,
      remainingAmount,
      status,
      relatedAllocations: allocations.map((a) => ({
        loanEntryId: a.gotEntry.id,
        amount: Number(a.amount),
        ymd: a.gotEntry.occurredAt.toISOString().slice(0, 10),
        reason: a.gotEntry.reason,
      })),
    };
  }

  const allocations = await prisma.loanAllocation.findMany({
    where: { gotEntryId: entry.id, gaveEntry: { deletedAt: null } },
    include: { gaveEntry: { select: { id: true, occurredAt: true, reason: true } } },
    orderBy: { createdAt: "asc" },
  });
  return {
    ...base,
    kind: "GOT",
    dueDate: null,
    settledAmount: 0,
    remainingAmount: 0,
    status: null,
    relatedAllocations: allocations.map((a) => ({
      loanEntryId: a.gaveEntry.id,
      amount: Number(a.amount),
      ymd: a.gaveEntry.occurredAt.toISOString().slice(0, 10),
      reason: a.gaveEntry.reason,
    })),
  };
}

interface GaveEntryWithSettlement {
  loanEntryId: string;
  participantId: string;
  participantName: string;
  amount: number;
  settledAmount: number;
  remainingAmount: number;
  dueDate: string | null;
  occurredAt: string;
  accountId: string | null;
  accountName: string | null;
  accountIcon: string | null;
  isCreditCard: boolean; // funded by a CREDIT_CARD account, regardless of whether billing is configured
  hasBillingConfig: boolean; // isCreditCard AND statementDay/dueDay both set — cycle math needs both
  cardNetwork: string | null;
  cardLast4: string | null;
  statementDay: number | null;
  dueDay: number | null;
}

/** Every still-live GAVE entry across the whole ledger, with settlement and
 * funding-source detail attached — the single shared source for Card
 * Recovery (Priority 4), Reminders (Priority 6), and two of Reports' facets
 * (cardExposure, overdueLoans; Priority 7). Those three together render on
 * every /lending page load (all three tabs are fetched up front), and
 * before this consolidation each ran its own near-identical "GAVE entries +
 * allocations" query — cache()-wrapped, this now hits Postgres exactly
 * once (plus its own allocations query) no matter how many of the three
 * consumers a given request needs. */
const allGaveEntriesData = cache(async (userId: string): Promise<GaveEntryWithSettlement[]> => {
  const gaveEntries = await prisma.loanEntry.findMany({
    where: { userId, kind: "GAVE", deletedAt: null },
    include: {
      participant: { select: { displayName: true } },
      account: { select: { id: true, name: true, icon: true, type: true, cardNetwork: true, cardLast4: true, statementDay: true, dueDay: true } },
    },
  });
  if (gaveEntries.length === 0) return [];

  const gaveIds = gaveEntries.map((g) => g.id);
  const allocations = await prisma.loanAllocation.findMany({
    where: { gaveEntryId: { in: gaveIds }, gotEntry: { deletedAt: null } },
    select: { gaveEntryId: true, amount: true },
  });
  const settledByLoan = new Map<string, number>();
  for (const a of allocations) settledByLoan.set(a.gaveEntryId, (settledByLoan.get(a.gaveEntryId) ?? 0) + Number(a.amount));

  return gaveEntries.map((g) => {
    const amount = Number(g.amount);
    const settledAmount = settledByLoan.get(g.id) ?? 0;
    const isCreditCard = g.account?.type === "CREDIT_CARD";
    return {
      loanEntryId: g.id,
      participantId: g.participantId,
      participantName: g.participant.displayName,
      amount,
      settledAmount,
      remainingAmount: Math.max(0, amount - settledAmount),
      dueDate: g.dueDate ? g.dueDate.toISOString().slice(0, 10) : null,
      occurredAt: g.occurredAt.toISOString().slice(0, 10),
      accountId: g.accountId,
      accountName: g.account?.name ?? null,
      accountIcon: g.account?.icon ?? null,
      isCreditCard,
      hasBillingConfig: isCreditCard && g.account?.statementDay != null && g.account?.dueDay != null,
      cardNetwork: g.account?.cardNetwork ?? null,
      cardLast4: g.account?.cardLast4 ?? null,
      statementDay: g.account?.statementDay ?? null,
      dueDay: g.account?.dueDay ?? null,
    };
  });
});

/** Priority 4 (Card Recovery Dashboard) — computeCardRecovery over the
 * shared GAVE-entry data, scoped to cards with billing details actually
 * configured (cycle math needs statementDay/dueDay). */
export async function cardRecoveryDashboard(userId: string): Promise<CardRecoverySummary[]> {
  const cardFunded = (await allGaveEntriesData(userId)).filter((g) => g.hasBillingConfig);
  if (cardFunded.length === 0) return [];

  const accountsById = new Map<string, { id: string; name: string; icon: string; cardNetwork: string | null; cardLast4: string | null; statementDay: number; dueDay: number }>();
  for (const g of cardFunded) {
    if (!accountsById.has(g.accountId!)) {
      accountsById.set(g.accountId!, {
        id: g.accountId!,
        name: g.accountName ?? "Card",
        icon: g.accountIcon ?? "💳",
        cardNetwork: g.cardNetwork,
        cardLast4: g.cardLast4,
        statementDay: g.statementDay!,
        dueDay: g.dueDay!,
      });
    }
  }
  const loans: CardLoanForRecovery[] = cardFunded.map((g) => ({
    accountId: g.accountId!,
    loanEntryId: g.loanEntryId,
    participantId: g.participantId,
    participantName: g.participantName,
    amount: g.amount,
    remainingAmount: g.remainingAmount,
    occurredAt: g.occurredAt,
  }));
  return computeCardRecovery([...accountsById.values()], loans);
}

/** Priority 6 (Reminder Data Engine) — generateReminders over the same
 * shared GAVE-entry data. Data-layer only, per spec — no notification
 * delivery here, just the structured candidates a future system would
 * consume. */
export async function lendingReminders(userId: string): Promise<ReminderCandidate[]> {
  const loans: LoanForReminder[] = (await allGaveEntriesData(userId)).map((g) => ({
    loanEntryId: g.loanEntryId,
    participantId: g.participantId,
    participantName: g.participantName,
    remainingAmount: g.remainingAmount,
    dueDate: g.dueDate,
    cardStatementDay: g.hasBillingConfig ? g.statementDay : null,
    cardDueDay: g.hasBillingConfig ? g.dueDay : null,
    occurredAt: g.occurredAt,
  }));
  return generateReminders(loans);
}

export interface LendingReportsData {
  monthKeys: string[]; // ascending, "YYYY-MM"
  monthlyLending: number[];
  monthlyRecoveries: number[];
  outstandingTrend: number[];
  receivable: number;
  payable: number;
  recoveryRatePercent: number;
  cardExposure: CardExposureRow[];
  overdueLoans: OverdueLoanRow[];
  topBorrowers: TopBorrowerRow[];
}

/** Priority 7 (Lending Reports) — reuses lendingBalances and
 * allGaveEntriesData (both cache()'d, shared with Card Recovery and
 * Reminders) so a page rendering all three tabs in one request never
 * re-fetches the same rows.
 *
 * Its own query used to be "every GAVE+GOT entry, ever" — correct, since
 * recoveryRatePercent is explicitly an all-time stat, but wasteful: the
 * monthly/trend charts only look at the last `months` months, so a
 * long-lived account was paying to pull years of rows into Node just to sum
 * them in JS. Now it's three cheap DB-side aggregates instead: an all-time
 * GAVE/GOT groupBy (for recoveryRatePercent — O(2) rows back, not O(all
 * entries)), a pre-window groupBy (the running-balance carry-in
 * outstandingTrend needs to seed its first month correctly), and a findMany
 * bounded to the window itself (for the per-month chart math). */
export async function lendingReportsData(userId: string, months = 6): Promise<LendingReportsData> {
  const now = new Date();
  const key = currentMonthKey(now);
  const monthKeys = Array.from({ length: months }, (_, i) => shiftMonthKey(key, i - (months - 1)));
  const windowStart = monthRange(monthKeys[0]).start;

  const [allTimeTotals, carryInTotals, windowEntries, contacts, gaveData] = await Promise.all([
    prisma.loanEntry.groupBy({ by: ["kind"], where: { userId, deletedAt: null }, _sum: { amount: true } }),
    prisma.loanEntry.groupBy({ by: ["kind"], where: { userId, deletedAt: null, occurredAt: { lt: windowStart } }, _sum: { amount: true } }),
    prisma.loanEntry.findMany({ where: { userId, deletedAt: null, occurredAt: { gte: windowStart } }, select: { kind: true, amount: true, occurredAt: true } }),
    lendingBalances(userId),
    allGaveEntriesData(userId),
  ]);

  const sumByKind = (rows: { kind: string; _sum: { amount: bigint | null } }[], kind: "GAVE" | "GOT") => Number(rows.find((r) => r.kind === kind)?._sum.amount ?? 0);
  const totalLent = sumByKind(allTimeTotals, "GAVE");
  const totalRecovered = sumByKind(allTimeTotals, "GOT");
  const carryIn = sumByKind(carryInTotals, "GAVE") - sumByKind(carryInTotals, "GOT");

  const entries: LoanEntryForTrend[] = windowEntries.map((e) => ({ kind: e.kind, amount: Number(e.amount), ymd: e.occurredAt.toISOString().slice(0, 10) }));

  const cardAccountsSeen = new Map<string, { id: string; name: string; icon: string }>();
  for (const g of gaveData) {
    if (g.isCreditCard && g.accountId && !cardAccountsSeen.has(g.accountId)) {
      cardAccountsSeen.set(g.accountId, { id: g.accountId, name: g.accountName ?? "Card", icon: g.accountIcon ?? "💳" });
    }
  }
  const cardLoansForExposure = gaveData.filter((g) => g.isCreditCard).map((g) => ({ accountId: g.accountId!, remainingAmount: g.remainingAmount }));

  const overdueInput = gaveData
    .filter((g): g is GaveEntryWithSettlement & { dueDate: string } => g.dueDate !== null)
    .map((g) => ({
      loanEntryId: g.loanEntryId,
      participantId: g.participantId,
      participantName: g.participantName,
      remainingAmount: g.remainingAmount,
      dueDate: g.dueDate,
    }));

  const { receivable, payable } = receivableVsPayable(contacts.map((c) => ({ participantId: c.id, net: c.net })));

  return {
    monthKeys,
    monthlyLending: monthlyLending(entries, monthKeys),
    monthlyRecoveries: monthlyRecoveries(entries, monthKeys),
    outstandingTrend: outstandingTrend(entries, monthKeys, carryIn),
    receivable,
    payable,
    recoveryRatePercent: totalLent > 0 ? Math.round((totalRecovered / totalLent) * 100) : 0,
    cardExposure: cardExposure([...cardAccountsSeen.values()], cardLoansForExposure),
    overdueLoans: computeOverdueLoans(overdueInput, now),
    topBorrowers: topBorrowers(contacts.map((c) => ({ participantId: c.id, participantName: c.name, net: c.net }))),
  };
}
