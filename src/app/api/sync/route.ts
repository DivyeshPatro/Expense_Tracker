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
import { getSession } from "@/server/session";
import {
  addExpense,
  addIncome,
  addTransfer,
  updateExpense,
  updateIncome,
  updateTransfer,
  softDeleteTransaction,
  MutationTargetGoneError,
  type IntentMeta,
  type MutateOutcome,
} from "@/server/services/transactions";
import { expenseSchema, incomeSchema, transferSchema } from "@/validators";

const STALE_INTENT_MS = 30 * 24 * 60 * 60 * 1000; // matches the server's Intent retention window (spec §4.2)

type Kind = "expense.create" | "income.create" | "transfer.create" | "expense.update" | "income.update" | "transfer.update" | "tx.delete";

type ZodLike = { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: { message: string }[] } } };

const SCHEMAS: Partial<Record<Kind, ZodLike>> = {
  "expense.create": expenseSchema,
  "income.create": incomeSchema,
  "transfer.create": transferSchema,
  "expense.update": expenseSchema,
  "income.update": incomeSchema,
  "transfer.update": transferSchema,
  // "tx.delete" has no payload to validate
};

const CREATE: Partial<Record<Kind, (userId: string, input: never, intent: IntentMeta) => Promise<string>>> = {
  "expense.create": addExpense as never,
  "income.create": addIncome as never,
  "transfer.create": addTransfer as never,
};

const UPDATE: Partial<Record<Kind, (userId: string, id: string, input: never, intent: IntentMeta) => Promise<MutateOutcome>>> = {
  "expense.update": updateExpense as never,
  "income.update": updateIncome as never,
  "transfer.update": updateTransfer as never,
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
  code: "OK" | "OK_OVERRIDE" | "VALIDATION" | "INVALID_REF_SOFT" | "INVALID_REF_HARD" | "STALE_INTENT";
  error?: string;
  overriddenByDevice?: string;
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
      return { intentId, code: "VALIDATION", error: e instanceof Error ? e.message : "Something went wrong" };
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
    if (e instanceof MutationTargetGoneError) {
      return { intentId, code: "VALIDATION", error: "This transaction was deleted elsewhere before your edit could sync." };
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
    return { intentId, code: "VALIDATION", error: e instanceof Error ? e.message : "Something went wrong" };
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
