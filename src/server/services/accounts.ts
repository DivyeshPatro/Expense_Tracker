import { ACCOUNT_TYPE_LABELS } from "@/lib/categories";
import { currentMonthKey, monthRange } from "@/lib/dates";
import type { AccountType } from "@prisma/client";
import { prisma } from "../db";
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
}

/** range defaults to the current month when omitted — matches the shared period picker's own default, and keeps callers that don't need periodNet (dashboard, analytics) from scanning all-time history for a number they never read. */
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
  input: { name: string; type: AccountType; openingBalance: number; bankName?: string; color?: string }
) {
  await prisma.account.create({
    data: {
      userId,
      name: input.name,
      type: input.type,
      bankName: input.bankName || null,
      openingBalance: input.openingBalance,
      balance: input.openingBalance,
      icon: TYPE_ICONS[input.type],
      color: input.color ?? "#2a63f6",
    },
  });
}

export async function archiveAccount(userId: string, id: string) {
  await prisma.account.updateMany({ where: { id, userId }, data: { isArchived: true } });
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
