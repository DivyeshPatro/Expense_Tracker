import { cache } from "react";
import { ACCOUNT_TYPE_LABELS } from "@/lib/categories";
import { currentMonthKey, monthRange } from "@/lib/dates";
import type { AccountType } from "@prisma/client";
import { prisma } from "../db";
import { audit } from "./audit";
import { loadLedgerAggRange } from "./ledger";

export interface AccountView {
  id: string;
  name: string;
  type: AccountType;
  typeLabel: string;
  icon: string;
  color: string;
  balance: number; // paise, negative for credit-card debt
  periodNet: number; // paise net movement within the requested window (defaults to this month)
  // lending-module-phase2: Card Vault — populated only for CREDIT_CARD accounts
  cardNetwork: string | null;
  cardLast4: string | null;
  statementDay: number | null;
  dueDay: number | null;
}

export interface AccountRow {
  id: string;
  name: string;
  icon: string;
  color: string;
  balance: number; // paise, negative for credit-card debt
  // lending-module-phase2: Card Vault — populated only for CREDIT_CARD rows.
  // Free to include: the underlying query already fetches every column.
  type: AccountType;
  cardNetwork: string | null;
  cardLast4: string | null;
  statementDay: number | null;
  dueDay: number | null;
}

/**
 * Bare account rows — id/name/icon/color/balance only, no periodNet. cache()-wrapped:
 * the layout (sidebar/palette account list) and Dashboard (accounts card, which
 * never reads type/typeLabel/periodNet) both just need this shape, so they share
 * one fetch instead of two, and Dashboard skips the ledger scan listAccounts()
 * below would otherwise run to compute a periodNet nothing reads.
 */
export const listAccountRows = cache(async (userId: string): Promise<AccountRow[]> => {
  const accounts = await prisma.account.findMany({ where: { userId, isArchived: false }, orderBy: { createdAt: "asc" } });
  return accounts.map((a) => ({
    id: a.id,
    name: a.name,
    icon: a.icon ?? "🏦",
    color: a.color ?? "#2a63f6",
    balance: Number(a.balance),
    type: a.type,
    cardNetwork: a.cardNetwork,
    cardLast4: a.cardLast4,
    statementDay: a.statementDay,
    dueDay: a.dueDay,
  }));
});

/** range defaults to the current month when omitted — matches the shared period picker's own default. Use listAccountRows instead when the caller doesn't need type/typeLabel/periodNet (e.g. Dashboard). */
export async function listAccounts(userId: string, range?: { start?: Date; end?: Date }, now = new Date()): Promise<AccountView[]> {
  const defaultRange = monthRange(currentMonthKey(now));
  const effective = range ?? defaultRange;
  const [accounts, rows] = await Promise.all([
    prisma.account.findMany({ where: { userId, isArchived: false }, orderBy: { createdAt: "asc" } }),
    loadLedgerAggRange(userId, effective.start, effective.end),
  ]);
  return accounts.map((a) => {
    let net = 0;
    for (const r of rows) {
      if (r.accountId === a.id) {
        if (r.type === "EXPENSE" || r.type === "TRANSFER") net -= r.amount;
        if (r.type === "INCOME") net += r.amount;
      }
      if (r.type === "TRANSFER" && r.toAccountId === a.id) net += r.amount;
    }
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      typeLabel: ACCOUNT_TYPE_LABELS[a.type] ?? a.type,
      icon: a.icon ?? "🏦",
      color: a.color ?? "#2a63f6",
      balance: Number(a.balance),
      periodNet: net,
      cardNetwork: a.cardNetwork,
      cardLast4: a.cardLast4,
      statementDay: a.statementDay,
      dueDay: a.dueDay,
    };
  });
}

const TYPE_ICONS: Record<AccountType, string> = {
  BANK: "🏦",
  CASH: "💵",
  WALLET: "📱",
  CREDIT_CARD: "💳",
  INVESTMENT: "📈",
};

export async function createAccount(
  userId: string,
  input: {
    name: string;
    type: AccountType;
    openingBalance: number;
    bankName?: string;
    color?: string;
    // lending-module-phase2: Card Vault — only meaningful for CREDIT_CARD
    cardNetwork?: string;
    cardLast4?: string;
    statementDay?: number;
    dueDay?: number;
  }
) {
  await prisma.$transaction(async (db) => {
    const a = await db.account.create({
      data: {
        userId,
        name: input.name,
        type: input.type,
        bankName: input.bankName || null,
        openingBalance: input.openingBalance,
        balance: input.openingBalance,
        icon: TYPE_ICONS[input.type],
        color: input.color ?? "#2a63f6",
        cardNetwork: input.type === "CREDIT_CARD" ? input.cardNetwork || null : null,
        cardLast4: input.type === "CREDIT_CARD" ? input.cardLast4 || null : null,
        statementDay: input.type === "CREDIT_CARD" ? (input.statementDay ?? null) : null,
        dueDay: input.type === "CREDIT_CARD" ? (input.dueDay ?? null) : null,
      },
    });
    await audit(db, userId, "create", "Account", a.id, undefined, a);
  });
}

export interface ArchivedAccountView {
  id: string;
  name: string;
  type: AccountType;
  typeLabel: string;
  icon: string;
  color: string;
  balance: number;
  /** Live transactions still referencing it — what the archive is protecting. */
  transactionCount: number;
}

/** Archived accounts, for the restore/history surface. Everything else in the app
 * reads listAccounts/listAccountRows, which exclude them. */
export async function listArchivedAccounts(userId: string): Promise<ArchivedAccountView[]> {
  const accounts = await prisma.account.findMany({
    where: { userId, isArchived: true },
    orderBy: { createdAt: "asc" },
  });
  if (accounts.length === 0) return [];
  const counts = await prisma.transaction.groupBy({
    by: ["accountId"],
    where: { userId, deletedAt: null, accountId: { in: accounts.map((a) => a.id) } },
    _count: { _all: true },
  });
  const byId = new Map(counts.map((c) => [c.accountId, c._count._all]));
  return accounts.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    typeLabel: ACCOUNT_TYPE_LABELS[a.type] ?? a.type,
    icon: a.icon ?? "🏦",
    color: a.color ?? "#2a63f6",
    balance: Number(a.balance),
    transactionCount: byId.get(a.id) ?? 0,
  }));
}

/**
 * Ids of accounts that something still points at, in a handful of queries rather
 * than a per-account check. The Accounts page uses it to label the remove button
 * "Archive" or "Delete" up front — the server still decides for real in
 * deleteOrArchiveAccount, but the button should say what's about to happen.
 */
export async function referencedAccountIds(userId: string): Promise<Set<string>> {
  const [fromTx, toTx, budgets, bills, loans, rules] = await Promise.all([
    prisma.transaction.groupBy({ by: ["accountId"], where: { userId } }),
    prisma.transaction.groupBy({ by: ["toAccountId"], where: { userId } }),
    prisma.budget.findMany({ where: { userId }, select: { accountId: true } }),
    prisma.bill.findMany({ where: { userId }, select: { accountId: true } }),
    prisma.loanEntry.findMany({ where: { userId }, select: { accountId: true } }),
    prisma.recurringRule.findMany({ where: { userId }, select: { template: true } }),
  ]);
  const ids = new Set<string>();
  for (const r of fromTx) if (r.accountId) ids.add(r.accountId);
  for (const r of toTx) if (r.toAccountId) ids.add(r.toAccountId);
  for (const rows of [budgets, bills, loans]) {
    for (const r of rows) if (r.accountId) ids.add(r.accountId);
  }
  for (const r of rules) {
    const a = (r.template as { accountId?: string } | null)?.accountId;
    if (a) ids.add(a);
  }
  return ids;
}

/**
 * Rename only. Type and opening balance are deliberately not editable: both feed
 * the balance invariant (balance = openingBalance + Σ ledger) and changing either
 * after transactions exist would silently invalidate every reported figure.
 * Card Vault fields have their own editor, updateAccountCardDetails.
 */
export async function renameAccount(userId: string, id: string, name: string) {
  const before = await prisma.account.findFirst({ where: { id, userId } });
  if (!before) throw new Error("Account not found");
  const after = await prisma.account.update({ where: { id }, data: { name } });
  await audit(prisma, userId, "rename", "Account", id, { name: before.name }, { name: after.name });
}

/** Recurring rules whose template funds from this account. */
async function rulesFundedBy(userId: string, accountId: string) {
  const rules = await prisma.recurringRule.findMany({ where: { userId } });
  return rules.filter((r) => (r.template as { accountId?: string } | null)?.accountId === accountId);
}

/**
 * Archiving pauses any recurring rule funded by this account. Continuing to
 * auto-create transactions against an account the user has just put away is
 * exactly what they were trying to stop — and unlike deletion it stays
 * reversible, since the rules are only paused, never removed.
 */
export async function archiveAccount(userId: string, id: string): Promise<{ pausedRules: number }> {
  const account = await prisma.account.findFirst({ where: { id, userId } });
  if (!account) throw new Error("Account not found");

  const funded = (await rulesFundedBy(userId, id)).filter((r) => !r.isPaused);
  await prisma.$transaction(async (db) => {
    await db.account.update({ where: { id }, data: { isArchived: true } });
    for (const r of funded) {
      await db.recurringRule.update({ where: { id: r.id }, data: { isPaused: true } });
    }
    await audit(db, userId, "archive", "Account", id, { isArchived: false }, { isArchived: true, pausedRules: funded.length });
  });
  return { pausedRules: funded.length };
}

/**
 * Restore. Recurring rules paused by archiving are deliberately NOT resumed:
 * nothing records why a rule was paused, so auto-resuming would also restart
 * rules the user had paused for their own reasons. The UI says they stay paused.
 */
export async function unarchiveAccount(userId: string, id: string) {
  const account = await prisma.account.findFirst({ where: { id, userId } });
  if (!account) throw new Error("Account not found");
  await prisma.account.update({ where: { id }, data: { isArchived: false } });
  await audit(prisma, userId, "unarchive", "Account", id, { isArchived: true }, { isArchived: false });
}

export interface AccountRemovalResult {
  outcome: "deleted" | "archived";
  /** Present when archived — what was still pointing at the account. */
  reason?: string;
  pausedRules: number;
}

/**
 * Delete when the account is genuinely unused; archive when anything still
 * refers to it.
 *
 * "Unused" is stricter than "no transactions". Budget and Bill cascade on
 * account deletion, and a soft-deleted transaction is still restorable history —
 * so a hard delete is only safe when nothing at all points here. Anything else
 * archives, and says which kind of record stopped it, rather than quietly
 * destroying a budget along with the account.
 */
export async function deleteOrArchiveAccount(userId: string, id: string): Promise<AccountRemovalResult> {
  const account = await prisma.account.findFirst({ where: { id, userId } });
  if (!account) throw new Error("Account not found");

  const [fromTx, toTx, budgets, bills, loans, rules] = await Promise.all([
    // Soft-deleted rows count: they can be restored, and they'd come back
    // pointing at an account that no longer exists.
    prisma.transaction.count({ where: { accountId: id } }),
    prisma.transaction.count({ where: { toAccountId: id } }),
    prisma.budget.count({ where: { accountId: id } }),
    prisma.bill.count({ where: { accountId: id } }),
    prisma.loanEntry.count({ where: { accountId: id } }),
    rulesFundedBy(userId, id),
  ]);

  const blockers: string[] = [];
  if (fromTx + toTx > 0) blockers.push(`${fromTx + toTx} transaction${fromTx + toTx === 1 ? "" : "s"}`);
  if (budgets > 0) blockers.push(`${budgets} budget${budgets === 1 ? "" : "s"}`);
  if (bills > 0) blockers.push(`${bills} bill${bills === 1 ? "" : "s"}`);
  if (loans > 0) blockers.push(`${loans} lending entr${loans === 1 ? "y" : "ies"}`);
  if (rules.length > 0) blockers.push(`${rules.length} recurring rule${rules.length === 1 ? "" : "s"}`);

  if (blockers.length > 0) {
    const { pausedRules } = await archiveAccount(userId, id);
    return { outcome: "archived", reason: blockers.join(", "), pausedRules };
  }

  await prisma.$transaction(async (db) => {
    await db.account.delete({ where: { id } });
    await audit(db, userId, "delete", "Account", id, account, undefined);
  });
  return { outcome: "deleted", pausedRules: 0 };
}

/** Card Vault editing (lending-module-phase2) — the one way to set
 * statementDay/dueDay on a credit-card account created before this sprint,
 * since account creation is otherwise the only entry point. Undefined
 * fields leave the existing value untouched; pass null explicitly to clear
 * — same semantics as updateParticipantDetails. Direct server action, not
 * outbox-routed: a metadata edit, not a financial-ledger write, same
 * precedent as contact-details editing. */
export async function updateAccountCardDetails(
  userId: string,
  accountId: string,
  data: { cardNetwork?: string | null; cardLast4?: string | null; statementDay?: number | null; dueDay?: number | null }
) {
  const a = await prisma.account.findFirst({ where: { id: accountId, userId } });
  if (!a) throw new Error("Account not found");
  if (a.type !== "CREDIT_CARD") throw new Error("Card details only apply to credit-card accounts");
  return prisma.account.update({
    where: { id: accountId },
    data: {
      cardNetwork: data.cardNetwork === undefined ? a.cardNetwork : data.cardNetwork,
      cardLast4: data.cardLast4 === undefined ? a.cardLast4 : data.cardLast4,
      statementDay: data.statementDay === undefined ? a.statementDay : data.statementDay,
      dueDay: data.dueDay === undefined ? a.dueDay : data.dueDay,
    },
  });
}

/** Rebuild check: balance − (openingBalance + Σ ledger) per account; all zeros ⇒ ledger reconciles. */
export async function reconcile(userId: string): Promise<{ accountId: string; drift: number }[]> {
  const accounts = await prisma.account.findMany({ where: { userId } });
  const txs = await prisma.transaction.findMany({
    where: { userId, deletedAt: null },
    select: { type: true, amount: true, accountId: true, toAccountId: true },
  });
  return accounts.map((a) => {
    let sum = 0;
    for (const t of txs) {
      const amt = Number(t.amount);
      if (t.type === "EXPENSE" && t.accountId === a.id) sum -= amt;
      if (t.type === "INCOME" && t.accountId === a.id) sum += amt;
      if (t.type === "TRANSFER") {
        if (t.accountId === a.id) sum -= amt;
        if (t.toAccountId === a.id) sum += amt;
      }
    }
    return { accountId: a.id, drift: Number(a.balance) - (Number(a.openingBalance) + sum) };
  });
}

/** Runs reconcile() for every user with at least one account; returns only the accounts that drifted. Called by the daily cron since nothing else invokes reconcile(). */
export async function reconcileAll(): Promise<{ userId: string; accountId: string; drift: number }[]> {
  const users = await prisma.account.findMany({ select: { userId: true }, distinct: ["userId"] });
  const out: { userId: string; accountId: string; drift: number }[] = [];
  for (const { userId } of users) {
    const rows = await reconcile(userId);
    for (const r of rows) if (r.drift !== 0) out.push({ userId, ...r });
  }
  return out;
}
