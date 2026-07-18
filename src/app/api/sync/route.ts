// Offline-sync batched drain transport (spec §5, §17 Phase 2/3). Accepts an
// ordered array of intents in one round trip, applies them sequentially
// (order matters — "batch applies in order" is a Phase 2 exit criterion),
// and returns one taxonomy result per intent. A Route Handler, not a server
// action, so it needs its own non-redirecting session check (requireUser()'s
// redirect() is a Server Component/Action mechanism and would 500 here).
//
// Phase 2 covered creates only. Phase 3 adds versioned updates/deletes of
// already-synced solo records: OK_OVERRIDE (baseVersion mismatch → solo LWW,
// applies anyway, spec §13) alongside the create-era codes: OK, VALIDATION,
// INVALID_REF_SOFT (category deleted — auto-heal to uncategorized),
// INVALID_REF_HARD (account gone — needs-attention), STALE_INTENT (>30 days).
// CONFLICT requires a shared record (Phase 4); RETRYABLE is a transport-level
// concept the client infers from a non-2xx/network failure, never a code
// this route returns.

import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { getSession } from "@/server/session";
import { NotAuthorizedError } from "@/server/services/authorization";
import {
  addExpense,
  addIncome,
  addTransfer,
  updateExpense,
  updateIncome,
  updateTransfer,
  softDeleteTransaction,
  ConflictError,
  MutationTargetGoneError,
  type ConflictSnapshot,
  type IntentMeta,
  type MutateOutcome,
} from "@/server/services/transactions";
import {
  addLoanEntry,
  updateLoanEntry,
  deleteLoanEntry,
  MutationTargetGoneError as LendingMutationTargetGoneError,
} from "@/server/services/lending";
import { expenseSchema, incomeSchema, transferSchema, loanEntrySchema } from "@/validators";

const STALE_INTENT_MS = 30 * 24 * 60 * 60 * 1000; // matches the server's Intent retention window (spec §4.2)

type Kind =
  | "expense.create"
  | "income.create"
  | "transfer.create"
  | "expense.update"
  | "income.update"
  | "transfer.update"
  | "tx.delete"
  | "loan.create"
  | "loan.update"
  | "loan.delete";

type ZodLike = { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: { message: string }[] } } };

const SCHEMAS: Partial<Record<Kind, ZodLike>> = {
  "expense.create": expenseSchema,
  "income.create": incomeSchema,
  "transfer.create": transferSchema,
  "expense.update": expenseSchema,
  "income.update": incomeSchema,
  "transfer.update": transferSchema,
  // "tx.delete" has no payload to validate
  "loan.create": loanEntrySchema,
  "loan.update": loanEntrySchema,
  // "loan.delete" has no payload to validate
};

const CREATE: Partial<Record<Kind, (userId: string, input: never, intent: IntentMeta) => Promise<string>>> = {
  "expense.create": addExpense as never,
  "income.create": addIncome as never,
  "transfer.create": addTransfer as never,
  "loan.create": addLoanEntry as never,
};

const UPDATE: Partial<Record<Kind, (userId: string, id: string, input: never, intent: IntentMeta) => Promise<MutateOutcome>>> = {
  "expense.update": updateExpense as never,
  "income.update": updateIncome as never,
  "transfer.update": updateTransfer as never,
  "loan.update": updateLoanEntry as never,
};

interface RawIntent {
  intentId: string;
  deviceId: string;
  deviceName?: string;
  clientTs: string;
  entityId: string;
  baseVersion?: number;
  kind: string;
  payload: unknown;
}

interface SyncResult {
  intentId: string;
  code:
    | "OK"
    | "OK_OVERRIDE"
    | "VALIDATION"
    | "INVALID_REF_SOFT"
    | "INVALID_REF_HARD"
    | "STALE_INTENT"
    | "CONFLICT"
    | "NOT_AUTHORIZED"
    | "GROUP_DELETED";
  error?: string;
  overriddenByDevice?: string;
  conflict?: ConflictSnapshot;
}

/** collaboration-architecture-rfc §8: a NotAuthorizedError at drain time means
 * this actor was authorized when the edit was QUEUED but isn't anymore.
 * Distinguishing "the group still exists, I was removed" from "the group
 * itself is gone" needs one extra read of the row's CURRENT groupId — the
 * transaction table itself already carries this for free (Transaction.groupId
 * has a real onDelete: SetNull FK, so a deleted group orphans the row back to
 * groupId=null the instant it's deleted, no application code required for
 * that half). A non-owner can only ever have been authorized in the first
 * place via a group that (at enqueue time) had a groupId — so seeing
 * groupId=null now, for an actor who isn't the row's own owner, can only mean
 * that group was deleted since. */
async function classifyAuthFailure(entityId: string): Promise<SyncResult["code"]> {
  const current = await prisma.transaction.findFirst({ where: { id: entityId, deletedAt: null }, select: { groupId: true } });
  if (!current) return "VALIDATION"; // gone entirely — same "deleted elsewhere" story as MutationTargetGoneError
  return current.groupId === null ? "GROUP_DELETED" : "NOT_AUTHORIZED";
}

function isFkViolation(e: unknown): e is Prisma.PrismaClientKnownRequestError {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003";
}

function fkFieldMentions(e: Prisma.PrismaClientKnownRequestError, field: string): boolean {
  const meta = e.meta as { field_name?: string; constraint?: string } | undefined;
  return String(meta?.field_name ?? meta?.constraint ?? "").toLowerCase().includes(field.toLowerCase());
}

function outcomeResult(intentId: string, outcome: MutateOutcome): SyncResult {
  return outcome.overridden
    ? { intentId, code: "OK_OVERRIDE", overriddenByDevice: outcome.overriddenByDevice }
    : { intentId, code: "OK" };
}

async function applyOne(userId: string, raw: RawIntent): Promise<SyncResult> {
  const { intentId, deviceId, deviceName, clientTs, entityId, baseVersion, kind, payload } = raw;

  if (Date.now() - new Date(clientTs).getTime() > STALE_INTENT_MS) {
    return { intentId, code: "STALE_INTENT", error: "Too old to sync automatically — review and re-add" };
  }

  const intentMeta: IntentMeta = { intentId, deviceId, deviceName, clientTs, entityId, baseVersion };

  // delete: no payload to validate, and deleting an already-gone row is
  // idempotent-OK inside softDeleteTransaction itself (spec §5 DUPLICATE
  // philosophy applied to delete)
  if (kind === "tx.delete") {
    try {
      const outcome = await softDeleteTransaction(userId, entityId, intentMeta);
      return outcomeResult(intentId, outcome);
    } catch (e) {
      if (e instanceof ConflictError) return { intentId, code: "CONFLICT", conflict: e.snapshot };
      if (e instanceof NotAuthorizedError) return { intentId, code: await classifyAuthFailure(entityId) };
      console.error(`[api/sync] tx.delete ${entityId} failed`, e);
      return { intentId, code: "VALIDATION", error: "Could not sync this delete — try again." };
    }
  }

  // Lending is personal-only — no group/authorization complexity, so this
  // branch is simpler than tx.delete's: no ConflictError/NotAuthorizedError
  // can ever be thrown by deleteLoanEntry.
  if (kind === "loan.delete") {
    try {
      const outcome = await deleteLoanEntry(userId, entityId, intentMeta);
      return outcomeResult(intentId, outcome);
    } catch (e) {
      console.error(`[api/sync] loan.delete ${entityId} failed`, e);
      return { intentId, code: "VALIDATION", error: "Could not sync this delete — try again." };
    }
  }

  const schema = SCHEMAS[kind as Kind];
  if (!schema) return { intentId, code: "VALIDATION", error: "Unknown intent kind" };
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return { intentId, code: "VALIDATION", error: parsed.error?.issues[0]?.message ?? "Invalid input" };

  const create = CREATE[kind as Kind];
  const update = UPDATE[kind as Kind];

  try {
    if (create) {
      await create(userId, parsed.data as never, intentMeta);
      return { intentId, code: "OK" };
    }
    if (update) {
      const outcome = await update(userId, entityId, parsed.data as never, intentMeta);
      return outcomeResult(intentId, outcome);
    }
    return { intentId, code: "VALIDATION", error: "Unknown intent kind" };
  } catch (e) {
    if (e instanceof ConflictError) return { intentId, code: "CONFLICT", conflict: e.snapshot };
    if (e instanceof NotAuthorizedError) return { intentId, code: await classifyAuthFailure(entityId) };
    if (e instanceof MutationTargetGoneError) {
      return { intentId, code: "VALIDATION", error: "This transaction was deleted elsewhere before your edit could sync." };
    }
    if (e instanceof LendingMutationTargetGoneError) {
      return { intentId, code: "VALIDATION", error: "This entry was deleted elsewhere before your edit could sync." };
    }
    if (isFkViolation(e)) {
      // category is soft-heal-eligible (deleted category → uncategorized); every
      // other reference (account, toAccount) is a hard fail — needs a human pick
      if (fkFieldMentions(e, "categoryId") && kind !== "transfer.create" && kind !== "transfer.update") {
        try {
          const healed = { ...(parsed.data as Record<string, unknown>), categoryId: null };
          if (create) await create(userId, healed as never, intentMeta);
          else if (update) await update(userId, entityId, healed as never, intentMeta);
          return { intentId, code: "INVALID_REF_SOFT", error: "category was deleted — synced as uncategorized" };
        } catch {
          return { intentId, code: "VALIDATION", error: "Could not sync" };
        }
      }
      return { intentId, code: "INVALID_REF_HARD", error: "An account this refers to no longer exists" };
    }
    console.error(`[api/sync] ${kind} ${entityId} failed`, e);
    return { intentId, code: "VALIDATION", error: "Something went wrong — try again or re-check this entry." };
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "AUTH_EXPIRED" }, { status: 401 });

  let intents: RawIntent[];
  try {
    const body = await req.json();
    intents = Array.isArray(body?.intents) ? body.intents : [];
  } catch {
    return NextResponse.json({ error: "VALIDATION" }, { status: 400 });
  }

  const results: SyncResult[] = [];
  let applied = 0;
  // sequential, not Promise.all — "batch applies in order" (spec §17 Phase 2 exit criteria)
  for (const raw of intents) {
    const result = await applyOne(session.user.id, raw);
    results.push(result);
    if (result.code === "OK" || result.code === "OK_OVERRIDE" || result.code === "INVALID_REF_SOFT") applied++;
  }
  if (applied > 0) revalidatePath("/", "layout");
  return NextResponse.json({ results });
}
