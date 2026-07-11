"use server";

// Server actions: validate with zod, call the service layer, revalidate.
// Every action is scoped to the session user — no client-supplied user ids.

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/session";
import { createAccount } from "@/server/services/accounts";
import { createBill, markBillPaid } from "@/server/services/bills";
import { upsertBudget } from "@/server/services/budgets";
import { changeCategoryKind, createCategory, deleteCategory, renameCategory } from "@/server/services/categories";
import { queryTransactions, type TxListFilter } from "@/server/services/ledger";
import { clearAllTransactions, deleteUserAccount } from "@/server/services/data-management";
import {
  commitImport,
  getSavedMapping,
  previewImport,
  undoImport,
  type CommitInput,
} from "@/server/services/import";
import { addParticipant, recordSettlement } from "@/server/services/shared";
import {
  addExpense,
  addIncome,
  addTransfer,
  restoreTransaction,
  softDeleteTransaction,
} from "@/server/services/transactions";
import { askLedgerly, searchMerchants } from "@/server/services/search";
import type { ColumnMapping } from "@/lib/import/types";
import {
  accountSchema,
  billSchema,
  budgetSchema,
  categorySchema,
  changeCategoryKindSchema,
  renameCategorySchema,
  expenseSchema,
  incomeSchema,
  participantSchema,
  settlementSchema,
  transferSchema,
} from "@/validators";

export type ActionResult = { ok: true } | { ok: false; error: string };

function fail(e: unknown): ActionResult {
  if (e && typeof e === "object" && "issues" in e) {
    const issues = (e as { issues: { message: string }[] }).issues;
    return { ok: false, error: issues[0]?.message ?? "Invalid input" };
  }
  return { ok: false, error: e instanceof Error ? e.message : "Something went wrong" };
}

function refresh() {
  revalidatePath("/", "layout");
}

export async function addExpenseAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const data = expenseSchema.parse(input);
    await addExpense(user.id, data);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function addIncomeAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const data = incomeSchema.parse(input);
    await addIncome(user.id, data);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function addTransferAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const data = transferSchema.parse(input);
    await addTransfer(user.id, data);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteTransactionAction(id: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await softDeleteTransaction(user.id, id);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function undoDeleteAction(id: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await restoreTransaction(user.id, id);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function settleAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const data = settlementSchema.parse(input);
    await recordSettlement(user.id, data.participantId, data.direction, data.amount, data.method, data.note);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function saveBudgetAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const data = budgetSchema.parse(input);
    await upsertBudget(user.id, data.categoryId, data.limit);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function payBillAction(billId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await markBillPaid(user.id, billId);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function createBillAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const data = billSchema.parse(input);
    await createBill(user.id, data);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function createAccountAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const data = accountSchema.parse(input);
    await createAccount(user.id, data);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function addParticipantAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const data = participantSchema.parse(input);
    await addParticipant(user.id, data.displayName);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function askLedgerlyAction(query: string) {
  const user = await requireUser();
  return askLedgerly(user.id, query);
}

export async function queryTransactionsAction(filter: TxListFilter, page: number) {
  const user = await requireUser();
  return queryTransactions(user.id, filter, page);
}

// ─────────── Import wizard ───────────

export async function getSavedMappingAction(source: string) {
  const user = await requireUser();
  if (!source.trim()) return null;
  return getSavedMapping(user.id, source.trim());
}

export async function previewImportAction(rows: Record<string, unknown>[], mapping: ColumnMapping) {
  const user = await requireUser();
  return previewImport(user.id, rows, mapping);
}

export async function commitImportAction(input: CommitInput): Promise<ActionResult & { batchId?: string; imported?: number }> {
  try {
    const user = await requireUser();
    const result = await commitImport(user.id, input);
    refresh();
    return { ok: true, batchId: result.batchId, imported: result.imported };
  } catch (e) {
    return fail(e);
  }
}

export async function undoImportAction(batchId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await undoImport(user.id, batchId);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ─────────── Data management ───────────

export async function clearTransactionsAction(): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await clearAllTransactions(user.id);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteMyAccountAction(): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await deleteUserAccount(user.id);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ─────────── Categories ───────────

export async function createCategoryAction(
  input: unknown
): Promise<(ActionResult & { category?: { id: string; name: string; icon: string; kind: string } })> {
  try {
    const user = await requireUser();
    const data = categorySchema.parse(input);
    const category = await createCategory(user.id, data.name, data.kind);
    refresh();
    return { ok: true, category: { id: category.id, name: category.name, icon: category.icon ?? "📦", kind: category.kind } };
  } catch (e) {
    return fail(e);
  }
}

export async function renameCategoryAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const data = renameCategorySchema.parse(input);
    await renameCategory(user.id, data.categoryId, data.name);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function changeCategoryKindAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const data = changeCategoryKindSchema.parse(input);
    await changeCategoryKind(user.id, data.categoryId, data.kind);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteCategoryAction(categoryId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await deleteCategory(user.id, categoryId);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function searchMerchantsAction(query: string): Promise<string[]> {
  const user = await requireUser();
  return searchMerchants(user.id, query);
}
