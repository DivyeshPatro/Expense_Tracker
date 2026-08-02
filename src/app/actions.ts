"use server";

// Server actions: validate with zod, call the service layer, revalidate.
// Every action is scoped to the session user — no client-supplied user ids.

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireUser } from "@/server/session";
import {
  createAccount,
  deleteOrArchiveAccount as removeAccount,
  renameAccount,
  unarchiveAccount,
  updateAccountCardDetails,
} from "@/server/services/accounts";
import { createBill, deleteBill, markBillPaid, updateBill } from "@/server/services/bills";
import { deleteBudget, upsertBudget } from "@/server/services/budgets";
import { changeCategoryKind, createCategory, createGroupCategory, deleteCategory, listGroupCategories, renameCategory } from "@/server/services/categories";
import { queryTransactions, txTotals, type TxListFilter } from "@/server/services/ledger";
import { clearAllTransactions, deleteUserAccount } from "@/server/services/data-management";
import {
  commitImport,
  getSavedMapping,
  previewImport,
  undoImport,
  type CommitInput,
} from "@/server/services/import";
import { commitBackupRestore, previewBackupRestore } from "@/server/services/backup-restore";
import { commitLendingImport, previewLendingImport, type CommitLendingResult, type LendingPreviewResult } from "@/server/services/lending-import";
import type { LendingImportOptions } from "@/lib/import/lending/preview";
import {
  createCreditCard,
  deleteCreditCard,
  revealWithPassword,
  setDefaultCreditCard,
  updateCreditCard,
  type RevealedCreditCard,
} from "@/server/services/credit-cards";
import {
  createRecurringRule,
  deleteRecurringRule,
  setRecurringRulePaused,
  updateRecurringRule,
} from "@/server/services/recurring";
import { addParticipant, recordSettlement } from "@/server/services/shared";
import {
  addLoanEntry,
  deleteLoanEntry,
  getLoanDetail,
  lendingDashboardSummary,
  listLoanEntries,
  openLoansForContact,
  restoreLoanEntry,
  updateLoanEntry,
  updateParticipantDetails,
} from "@/server/services/lending";
import { listNotifications, markAllRead } from "@/server/services/notifications";
import {
  addGroupMember,
  createGroup,
  deleteGroup,
  removeGroupMember,
  renameGroup,
} from "@/server/services/groups";
import { acceptInvitation, createInvitation } from "@/server/services/invitations";
import {
  addExpense,
  addIncome,
  addTransfer,
  getTransactionDetail,
  restoreTransaction,
  softDeleteTransaction,
  updateExpense,
  updateIncome,
  updateTransfer,
  ConflictError,
} from "@/server/services/transactions";
import { unifiedSearch } from "@/server/services/search";
import { activityPage, entityHistory, importPreview } from "@/server/services/activity";
import { ACTIVITY_CHIPS, type ActivityChip } from "@/lib/activity";
import { parsePeriod } from "@/lib/period";
import type { ColumnMapping } from "@/lib/import/types";
import {
  accountSchema,
  billSchema,
  budgetSchema,
  categorySchema,
  changeCategoryKindSchema,
  creditCardSchema,
  updateCreditCardSchema,
  renameCategorySchema,
  deleteTransactionSchema,
  expenseWithIntentSchema,
  groupMemberSchema,
  groupSchema,
  incomeWithIntentSchema,
  participantSchema,
  participantDetailsSchema,
  settlementSchema,
  transferWithIntentSchema,
  updateExpenseWithIntentSchema,
  updateIncomeWithIntentSchema,
  updateTransferWithIntentSchema,
  loanEntryWithIntentSchema,
  updateLoanEntryWithIntentSchema,
  deleteLoanEntrySchema,
  accountCardDetailsSchema,
  recurringRuleSchema,
  updateRecurringRuleSchema,
  accountNameSchema,
  updateBillSchema,
} from "@/validators";

export type ActionResult = { ok: true } | { ok: false; error: string };

function fail(e: unknown): ActionResult {
  // production audit §1.2/§PhaseA.2: now that split-expense edits and the
  // private-browsing fallback carry real intent metadata, they can reach
  // ConflictError too — its .message is the internal code "CONFLICT", not
  // human copy, so it needs its own case (every other error type's own
  // .message is already reasonable user-facing text, including
  // NotAuthorizedError's).
  if (e instanceof ConflictError) {
    return {
      ok: false,
      error: `This changed while you were away — ${e.snapshot.serverActorName} made a different edit. Reopen it to see the latest version.`,
    };
  }
  if (e && typeof e === "object" && "issues" in e) {
    const issues = (e as { issues: { message: string }[] }).issues;
    return { ok: false, error: issues[0]?.message ?? "Invalid input" };
  }
  // Raw Prisma exceptions (constraint text, column/table names) are never
  // meant for the client — every error type above this is one we throw
  // ourselves with deliberately human-readable copy, but a
  // PrismaClientKnownRequestError/etc. reaching here means something
  // unexpected happened at the DB layer, not a curated message.
  if (
    e instanceof Prisma.PrismaClientKnownRequestError ||
    e instanceof Prisma.PrismaClientValidationError ||
    e instanceof Prisma.PrismaClientInitializationError ||
    e instanceof Prisma.PrismaClientUnknownRequestError
  ) {
    console.error("[action] unexpected database error", e);
    return { ok: false, error: "Something went wrong — please try again." };
  }
  return { ok: false, error: e instanceof Error ? e.message : "Something went wrong" };
}

function refresh() {
  revalidatePath("/", "layout");
}

export async function addExpenseAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const { intent, ...data } = expenseWithIntentSchema.parse(input);
    await addExpense(user.id, data, intent);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function addIncomeAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const { intent, ...data } = incomeWithIntentSchema.parse(input);
    await addIncome(user.id, data, intent);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function addTransferAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const { intent, ...data } = transferWithIntentSchema.parse(input);
    await addTransfer(user.id, data, intent);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteTransactionAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const { id, intent } = deleteTransactionSchema.parse(input);
    await softDeleteTransaction(user.id, id, intent);
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

export async function getTransactionDetailAction(id: string) {
  const user = await requireUser();
  return getTransactionDetail(user.id, id);
}

export type MutateActionResult = ActionResult & { overridden?: boolean; overriddenByDevice?: string };

export async function updateExpenseAction(input: unknown): Promise<MutateActionResult> {
  try {
    const user = await requireUser();
    const { id, intent, ...data } = updateExpenseWithIntentSchema.parse(input);
    const outcome = await updateExpense(user.id, id, data, intent);
    refresh();
    return { ok: true, overridden: outcome.overridden, overriddenByDevice: outcome.overriddenByDevice };
  } catch (e) {
    return fail(e);
  }
}

export async function updateIncomeAction(input: unknown): Promise<MutateActionResult> {
  try {
    const user = await requireUser();
    const { id, intent, ...data } = updateIncomeWithIntentSchema.parse(input);
    const outcome = await updateIncome(user.id, id, data, intent);
    refresh();
    return { ok: true, overridden: outcome.overridden, overriddenByDevice: outcome.overriddenByDevice };
  } catch (e) {
    return fail(e);
  }
}

export async function updateTransferAction(input: unknown): Promise<MutateActionResult> {
  try {
    const user = await requireUser();
    const { id, intent, ...data } = updateTransferWithIntentSchema.parse(input);
    const outcome = await updateTransfer(user.id, id, data, intent);
    refresh();
    return { ok: true, overridden: outcome.overridden, overriddenByDevice: outcome.overriddenByDevice };
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

/**
 * Removes the budgeting layer only. Nothing else refers to a Budget, so spending,
 * categories, accounts and analytics are untouched — the message says so, and
 * mentions any stale threshold alerts cleared along with it.
 */
export async function deleteBudgetAction(id: string): Promise<ActionResult & { message?: string }> {
  try {
    const user = await requireUser();
    const { clearedNotifications } = await deleteBudget(user.id, id);
    refresh();
    const cleared = clearedNotifications > 0
      ? ` ${clearedNotifications} budget alert${clearedNotifications === 1 ? "" : "s"} cleared.`
      : "";
    return { ok: true, message: `Budget deleted — your transactions are unchanged.${cleared}` };
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

export async function updateBillAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const { id, ...data } = updateBillSchema.parse(input);
    await updateBill(user.id, id, data);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Removes the reminder. Any recorded payment is deliberately left in the ledger,
 * and the message says so — "deleted the bill" could otherwise be read as having
 * undone the payment too.
 */
export async function deleteBillAction(id: string): Promise<ActionResult & { message?: string }> {
  try {
    const user = await requireUser();
    const { keptPaymentTxId } = await deleteBill(user.id, id);
    refresh();
    return {
      ok: true,
      message: keptPaymentTxId ? "Bill deleted — its recorded payment is still in your transactions" : "Bill deleted",
    };
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

export async function renameAccountAction(id: string, name: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const clean = accountNameSchema.parse(name);
    await renameAccount(user.id, id, clean);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Deletes an unused account outright, archives one that still has records
 * pointing at it. The message explains which happened and why — an account that
 * silently turned into an archived one would look like the delete failed.
 */
export async function removeAccountAction(id: string): Promise<ActionResult & { message?: string }> {
  try {
    const user = await requireUser();
    const res = await removeAccount(user.id, id);
    refresh();
    if (res.outcome === "deleted") return { ok: true, message: "Account deleted" };
    const paused = res.pausedRules > 0 ? ` ${res.pausedRules} recurring rule${res.pausedRules === 1 ? "" : "s"} paused.` : "";
    return { ok: true, message: `Archived instead — ${res.reason} still reference this account, so its history is kept.${paused}` };
  } catch (e) {
    return fail(e);
  }
}

export async function unarchiveAccountAction(id: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await unarchiveAccount(user.id, id);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function updateAccountCardDetailsAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const { accountId, ...data } = accountCardDetailsSchema.parse(input);
    await updateAccountCardDetails(user.id, accountId, data);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function addParticipantAction(input: unknown): Promise<ActionResult & { participantId?: string }> {
  try {
    const user = await requireUser();
    const data = participantSchema.parse(input);
    const participant = await addParticipant(user.id, data.displayName);
    refresh();
    return { ok: true, participantId: participant.id };
  } catch (e) {
    return fail(e);
  }
}

export async function updateParticipantDetailsAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const { participantId, ...data } = participantDetailsSchema.parse(input);
    await updateParticipantDetails(user.id, participantId, data);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ─────────── Lending (Phase 1) ───────────

export async function addLoanEntryAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const { intent, ...data } = loanEntryWithIntentSchema.parse(input);
    await addLoanEntry(user.id, data, intent);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function updateLoanEntryAction(input: unknown): Promise<MutateActionResult> {
  try {
    const user = await requireUser();
    const { id, intent, ...data } = updateLoanEntryWithIntentSchema.parse(input);
    const outcome = await updateLoanEntry(user.id, id, data, intent);
    refresh();
    return { ok: true, overridden: outcome.overridden, overriddenByDevice: outcome.overriddenByDevice };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteLoanEntryAction(input: unknown): Promise<MutateActionResult> {
  try {
    const user = await requireUser();
    const { id, intent } = deleteLoanEntrySchema.parse(input);
    const outcome = await deleteLoanEntry(user.id, id, intent);
    refresh();
    return { ok: true, overridden: outcome.overridden, overriddenByDevice: outcome.overriddenByDevice };
  } catch (e) {
    return fail(e);
  }
}

export async function undoDeleteLoanEntryAction(id: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await restoreLoanEntry(user.id, id);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function listLoanEntriesAction(participantId?: string) {
  const user = await requireUser();
  return listLoanEntries(user.id, { participantId });
}

export async function lendingDashboardAction() {
  const user = await requireUser();
  return lendingDashboardSummary(user.id);
}

// ─────────── Lending (Phase 2) ───────────

export async function openLoansForContactAction(participantId: string) {
  const user = await requireUser();
  return openLoansForContact(user.id, participantId);
}

export async function loanDetailAction(loanEntryId: string) {
  const user = await requireUser();
  return getLoanDetail(user.id, loanEntryId);
}

export async function queryTransactionsAction(filter: TxListFilter, page: number) {
  const user = await requireUser();
  return queryTransactions(user.id, filter, page);
}

export async function txTotalsAction(filter: TxListFilter) {
  const user = await requireUser();
  return txTotals(user.id, filter);
}

export async function activityPageAction(input: {
  chip?: string;
  entity?: string;
  period?: { p?: string; from?: string; to?: string };
  cursor?: string;
}) {
  const user = await requireUser();
  const chip = ACTIVITY_CHIPS.includes(input.chip as ActivityChip) ? (input.chip as ActivityChip) : "all";
  const { range } = parsePeriod(input.period ?? {});
  return activityPage(user.id, {
    chip,
    entityId: typeof input.entity === "string" && input.entity ? input.entity : undefined,
    start: range.start,
    end: range.end,
    cursor: typeof input.cursor === "string" && input.cursor ? input.cursor : undefined,
  });
}

export async function entityHistoryAction(entityId: string) {
  const user = await requireUser();
  if (typeof entityId !== "string" || !entityId) return { events: [], more: false };
  return entityHistory(user.id, entityId);
}

export async function importPreviewAction(batchId: string) {
  const user = await requireUser();
  if (typeof batchId !== "string" || !batchId) return { merchants: [] };
  return importPreview(user.id, batchId);
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

export async function undoImportAction(
  batchId: string
): Promise<ActionResult & { message?: string }> {
  try {
    const user = await requireUser();
    const r = await undoImport(user.id, batchId);
    refresh();
    // A restore can create accounts/categories; undo removes them unless other
    // data now depends on them. Say which, so a leftover account isn't a mystery.
    const parts = [`Removed ${r.reversed} transaction${r.reversed === 1 ? "" : "s"}`];
    const alsoRemoved = [
      r.removedAccounts > 0 ? `${r.removedAccounts} account${r.removedAccounts === 1 ? "" : "s"}` : null,
      r.removedCategories > 0 ? `${r.removedCategories} categor${r.removedCategories === 1 ? "y" : "ies"}` : null,
    ].filter(Boolean);
    if (alsoRemoved.length) parts.push(`and ${alsoRemoved.join(" and ")}`);
    // Khatabook → Lending imports remove entries and the contacts they created
    // rather than transactions — surface those too.
    if (r.removedLendingEntries > 0 || r.removedContacts > 0) {
      parts.length = 0;
      parts.push(`Removed ${r.removedLendingEntries} lending entr${r.removedLendingEntries === 1 ? "y" : "ies"}`);
      if (r.removedContacts > 0) parts.push(`and ${r.removedContacts} contact${r.removedContacts === 1 ? "" : "s"}`);
      if (r.retainedContacts.length) parts.push(`· kept ${r.retainedContacts.join(", ")} (still in use elsewhere)`);
      return { ok: true, message: parts.join(" ") };
    }
    const retained = [...r.retainedAccounts, ...r.retainedCategories];
    if (retained.length) parts.push(`· kept ${retained.join(", ")} (still in use elsewhere)`);
    return { ok: true, message: parts.join(" ") };
  } catch (e) {
    return fail(e);
  }
}

// ─────────── Khatabook → Lending import ───────────

export async function previewLendingImportAction(
  rows: Record<string, unknown>[],
  adapterId: string,
  options?: LendingImportOptions
): Promise<LendingPreviewResult> {
  const user = await requireUser();
  return previewLendingImport(user.id, rows, adapterId, options ?? {});
}

export async function commitLendingImportAction(input: {
  rows: Record<string, unknown>[];
  adapterId: string;
  fileName: string;
  options?: LendingImportOptions;
}): Promise<ActionResult & { result?: CommitLendingResult }> {
  try {
    const user = await requireUser();
    const result = await commitLendingImport(user.id, {
      rawRows: input.rows,
      adapterId: input.adapterId,
      fileName: input.fileName,
      options: input.options,
    });
    refresh();
    return { ok: true, result };
  } catch (e) {
    return fail(e);
  }
}

// ─────────── Backup (JSON) restore ───────────

export async function previewBackupRestoreAction(json: unknown) {
  const user = await requireUser();
  return previewBackupRestore(user.id, json);
}

export async function commitBackupRestoreAction(json: unknown): Promise<ActionResult & { batchId?: string; imported?: number; skipped?: number }> {
  try {
    const user = await requireUser();
    const result = await commitBackupRestore(user.id, json);
    refresh();
    return { ok: true, batchId: result.batchId, imported: result.imported, skipped: result.skipped };
  } catch (e) {
    return fail(e);
  }
}

// ─────────── Credit Cards ───────────

export async function createCreditCardAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const data = creditCardSchema.parse(input);
    await createCreditCard(user.id, data);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function updateCreditCardAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const { id, ...data } = updateCreditCardSchema.parse(input);
    await updateCreditCard(user.id, id, data);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteCreditCardAction(id: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await deleteCreditCard(user.id, id);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function setDefaultCreditCardAction(id: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await setDefaultCreditCard(user.id, id);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Reveals a card's details, behind the account password.
 *
 * A valid session deliberately isn't enough: a borrowed unlocked laptop is
 * exactly what this guards against, and it's the one place in Ledgerly where
 * being signed in shouldn't be sufficient on its own.
 *
 * The result is returned to the caller and never rendered into a page. That
 * matters because next.config.ts sets staleTimes.dynamic to 30s — anything
 * embedded in an RSC payload would sit in the client router cache afterwards,
 * which is not where a card number should live.
 */
export async function revealCreditCardAction(
  cardId: string,
  password: string
): Promise<{ ok: true; card: RevealedCreditCard } | { ok: false; error: string }> {
  try {
    const user = await requireUser();
    const result = await revealWithPassword(user.id, cardId, password);
    if (result.ok) return { ok: true, card: result.card };
    return {
      ok: false,
      error:
        result.reason === "too-many-attempts"
          ? "Too many incorrect attempts — wait a few minutes before trying again"
          : "That password isn't right",
    };
  } catch (e) {
    // fail() is typed as the shared ActionResult union, which can't narrow to
    // this action's richer success shape — unwrap it rather than widen the
    // return type and lose `card` from the signature.
    const failure = fail(e);
    return { ok: false, error: failure.ok ? "Something went wrong" : failure.error };
  }
}

// ─────────── Recurring rules ───────────
// Config, not a ledger mutation, so these go straight to the server rather than
// through the offline outbox: there is nothing to replay optimistically, and a
// rule only takes effect when the nightly cron next runs anyway.

export async function createRecurringRuleAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const d = recurringRuleSchema.parse(input);
    await createRecurringRule(user.id, {
      type: d.type,
      amountPaise: d.amount,
      accountId: d.accountId,
      categoryId: d.categoryId,
      merchant: d.merchant,
      cadence: d.cadence,
      interval: d.interval,
      startYmd: d.startDate,
      endYmd: d.endDate ?? null,
    });
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function updateRecurringRuleAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const d = updateRecurringRuleSchema.parse(input);
    await updateRecurringRule(user.id, d.id, {
      type: d.type,
      amountPaise: d.amount,
      accountId: d.accountId,
      categoryId: d.categoryId,
      merchant: d.merchant,
      cadence: d.cadence,
      interval: d.interval,
      startYmd: d.startDate,
      endYmd: d.endDate ?? null,
    });
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteRecurringRuleAction(ruleId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await deleteRecurringRule(user.id, ruleId);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function setRecurringRulePausedAction(ruleId: string, paused: boolean): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await setRecurringRulePaused(user.id, ruleId, paused);
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

// collaboration-architecture-rfc §10/§15 (migration step 4): a group member
// labeling a shared expense sees only categories already used within that
// group, never a co-member's full private list. Authorization (MEMBER role+)
// is enforced inside listGroupCategories itself — an unauthorized caller
// gets a thrown NotAuthorizedError, same as every other collaborative read.
export async function listGroupCategoriesAction(groupId: string) {
  const user = await requireUser();
  return listGroupCategories(user.id, groupId);
}

// group-expenses-sprint: "+ Create New Category" inside a group's category
// dropdown — scoped to that group only (createGroupCategory), never the
// caller's personal list.
export async function createGroupCategoryAction(
  groupId: string,
  name: string
): Promise<ActionResult & { category?: { id: string; name: string; icon: string } }> {
  try {
    const user = await requireUser();
    const category = await createGroupCategory(user.id, groupId, name);
    refresh();
    return { ok: true, category: { id: category.id, name: category.name, icon: category.icon ?? "📦" } };
  } catch (e) {
    return fail(e);
  }
}

export async function unifiedSearchAction(query: string) {
  const user = await requireUser();
  return unifiedSearch(user.id, query);
}

// ─────────── Notifications ───────────

export async function listNotificationsAction() {
  const user = await requireUser();
  return listNotifications(user.id);
}

export async function markNotificationsReadAction(): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await markAllRead(user.id);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ─────────── Groups ───────────

export async function createGroupAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const data = groupSchema.parse(input);
    await createGroup(user.id, data.name, data.participantIds);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function renameGroupAction(groupId: string, name: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await renameGroup(user.id, groupId, name);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function addGroupMemberAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const data = groupMemberSchema.parse(input);
    await addGroupMember(user.id, data.groupId, data.participantId);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function removeGroupMemberAction(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const data = groupMemberSchema.parse(input);
    await removeGroupMember(user.id, data.groupId, data.participantId);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteGroupAction(groupId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await deleteGroup(user.id, groupId);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ─────────── Invitations ───────────

export async function createInvitationAction(participantId: string, email: string): Promise<ActionResult & { token?: string }> {
  try {
    const user = await requireUser();
    const { token } = await createInvitation(user.id, participantId, email);
    return { ok: true, token };
  } catch (e) {
    return fail(e);
  }
}

export async function acceptInvitationAction(token: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await acceptInvitation(token, user.id, user.email);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
