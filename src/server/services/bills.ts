// Bills: due-date tracking with urgency, "mark paid" creates the payment
// transaction and rolls the due date forward by the bill's cadence (PRD §4.5).

import { advance, daysFromToday, istNoon, toYMD, todayYMD, MONTH_NAMES } from "@/lib/dates";
import { MISC_META } from "@/lib/categories";
import { prisma } from "../db";
import { audit } from "./audit";
import { listCategories } from "./categories";
import { applyBalances } from "./transactions";

export interface BillView {
  id: string;
  name: string;
  amount: number; // paise
  icon: string;
  color: string;
  cadence: string | null; // "Monthly" etc.
  dueYMD: string;
  days: number; // days from today; negative = overdue
  dueLabel: string;
  urgency: "overdue" | "urgent" | "soon" | "later";
  categoryId: string | null;
  cadenceValue: "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY" | null;
  /** A recorded payment exists — deleting the bill must not disturb it. */
  hasPayment: boolean;
}

export async function listBills(userId: string, now = new Date()): Promise<BillView[]> {
  const [bills, cats] = await Promise.all([
    prisma.bill.findMany({ where: { userId, status: { not: "PAID" } }, orderBy: { dueDate: "asc" } }),
    listCategories(userId),
  ]);
  const catById = new Map(cats.map((c) => [c.id, c]));

  return bills.map((b) => {
    const days = daysFromToday(b.dueDate, now);
    const dt = toYMD(b.dueDate);
    let dueLabel: string;
    let urgency: BillView["urgency"];
    if (days < 0) [dueLabel, urgency] = ["Overdue", "overdue"];
    else if (days === 0) [dueLabel, urgency] = ["Due today", "urgent"];
    else if (days <= 3) [dueLabel, urgency] = [`Due in ${days}d`, "urgent"];
    else if (days <= 7) [dueLabel, urgency] = [`Due in ${days}d`, "soon"];
    else [dueLabel, urgency] = [`Due ${MONTH_NAMES[Number(dt.slice(5, 7)) - 1]} ${Number(dt.slice(8))}`, "later"];
    const cat = b.categoryId ? catById.get(b.categoryId) : undefined;
    return {
      id: b.id,
      name: b.name,
      amount: Number(b.amount),
      icon: cat?.icon ?? MISC_META.icon,
      color: cat?.color ?? MISC_META.color,
      cadence: b.cadence ? b.cadence.charAt(0) + b.cadence.slice(1).toLowerCase() : null,
      dueYMD: dt,
      days,
      dueLabel,
      urgency,
      categoryId: b.categoryId,
      cadenceValue: b.cadence,
      hasPayment: !!b.paidTxId,
    };
  });
}

export interface PaidBillView {
  id: string;
  name: string;
  amount: number;
  paidYMD: string | null;
  hasPayment: boolean;
}

/**
 * One-off bills already settled. They leave the active list the moment they're
 * paid, which left them with no surface at all — not even to delete. Kept
 * separate so the main list stays a to-do list rather than a history.
 */
export async function listPaidBills(userId: string): Promise<PaidBillView[]> {
  const bills = await prisma.bill.findMany({
    where: { userId, status: "PAID" },
    orderBy: { dueDate: "desc" },
  });
  if (bills.length === 0) return [];
  const txIds = bills.map((b) => b.paidTxId).filter((id): id is string => !!id);
  const txs = txIds.length
    ? await prisma.transaction.findMany({ where: { id: { in: txIds } }, select: { id: true, occurredAt: true } })
    : [];
  const paidOn = new Map(txs.map((t) => [t.id, toYMD(t.occurredAt)]));
  return bills.map((b) => ({
    id: b.id,
    name: b.name,
    amount: Number(b.amount),
    paidYMD: b.paidTxId ? paidOn.get(b.paidTxId) ?? null : null,
    hasPayment: !!b.paidTxId,
  }));
}

/** Creates the payment transaction and rolls the due date (recurring) or marks paid (one-off). */
export async function markBillPaid(userId: string, billId: string, accountId?: string, now = new Date()) {
  await prisma.$transaction(async (db) => {
    const bill = await db.bill.findFirst({ where: { id: billId, userId } });
    if (!bill) throw new Error("Bill not found");
    const account =
      (accountId ? await db.account.findFirst({ where: { id: accountId, userId } }) : null) ??
      (bill.accountId ? await db.account.findFirst({ where: { id: bill.accountId, userId } }) : null) ??
      (await db.account.findFirst({ where: { userId, isArchived: false, type: "BANK" } })) ??
      (await db.account.findFirst({ where: { userId, isArchived: false } }));
    if (!account) throw new Error("No account to pay from");

    const t = await db.transaction.create({
      data: {
        userId,
        type: "EXPENSE",
        amount: bill.amount,
        accountId: account.id,
        categoryId: bill.categoryId,
        merchant: bill.name,
        occurredAt: istNoon(todayYMD(now)),
        isRecurring: !!bill.cadence,
      },
    });
    await applyBalances(db, t, 1);

    if (bill.cadence) {
      // Anchored so a month-end bill keeps its day: without it, rolling forward
      // from an already-clamped date turns the 31st into Feb 28 and leaves it
      // there for good. Null anchor (pre-existing bills) keeps prior behaviour.
      const next = advance(toYMD(bill.dueDate), bill.cadence, 1, bill.anchorDay);
      await db.bill.update({ where: { id: billId }, data: { dueDate: istNoon(next), paidTxId: t.id, status: "UPCOMING" } });
    } else {
      await db.bill.update({ where: { id: billId }, data: { status: "PAID", paidTxId: t.id } });
    }
    // account + amount recorded so the activity timeline can show which
    // account was hit without joining live tables (the audit snapshot rule)
    await audit(db, userId, "bill-paid", "Bill", billId, bill, {
      paidTxId: t.id,
      accountId: account.id,
      accountName: account.name,
      amount: bill.amount,
      name: bill.name,
    });
  });
}

export interface BillInput {
  name: string;
  amount: number;
  categoryId: string | null;
  dueDate: string; // YYYY-MM-DD
  cadence: "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY" | null;
}

/** Month-based cadences pin to the first due date's day; day-based ones don't need it. */
export function billAnchorDay(cadence: BillInput["cadence"], dueYmd: string): number | null {
  if (!cadence || cadence === "DAILY" || cadence === "WEEKLY") return null;
  return Number(dueYmd.slice(8, 10));
}

export async function createBill(userId: string, input: BillInput) {
  await prisma.$transaction(async (db) => {
    const b = await db.bill.create({
      data: {
        userId,
        name: input.name,
        amount: input.amount,
        categoryId: input.categoryId,
        dueDate: istNoon(input.dueDate),
        cadence: input.cadence,
        anchorDay: billAnchorDay(input.cadence, input.dueDate),
      },
    });
    await audit(db, userId, "create", "Bill", b.id, undefined, b);
  });
}

/**
 * Edits the reminder, never the money. A bill's payments are ordinary
 * transactions that already happened; changing the amount or due date changes
 * what's expected NEXT and leaves every recorded payment alone.
 */
export async function updateBill(userId: string, billId: string, input: BillInput) {
  const before = await prisma.bill.findFirst({ where: { id: billId, userId } });
  if (!before) throw new Error("Bill not found");
  await prisma.$transaction(async (db) => {
    const after = await db.bill.update({
      where: { id: billId },
      data: {
        name: input.name,
        amount: input.amount,
        categoryId: input.categoryId,
        dueDate: istNoon(input.dueDate),
        cadence: input.cadence,
        // Re-derived, not carried over: the due date or cadence may have moved,
        // and a stale anchor would pin the schedule to the wrong day.
        anchorDay: billAnchorDay(input.cadence, input.dueDate),
        // Editing a settled one-off back to a future date makes it a live
        // reminder again; leaving it PAID would hide it from the list it was
        // just rescheduled into.
        status: before.status === "PAID" && input.cadence === null ? "PAID" : "UPCOMING",
      },
    });
    await audit(db, userId, "update", "Bill", billId, before, after);
  });
}

export interface BillDeleteResult {
  /** The payment left untouched, if this bill had one. */
  keptPaymentTxId: string | null;
}

/**
 * Deletes the reminder only.
 *
 * A bill is a schedule; its payment is financial history that actually happened.
 * paidTxId is a plain column with no foreign key, so removing the bill drops the
 * association and nothing else — the transaction keeps its amount, account,
 * category and date, and stays in the ledger, analytics and every balance. The
 * id is returned so the UI can say so rather than leaving the user to wonder
 * whether their payment went with it.
 */
export async function deleteBill(userId: string, billId: string): Promise<BillDeleteResult> {
  const bill = await prisma.bill.findFirst({ where: { id: billId, userId } });
  if (!bill) throw new Error("Bill not found");
  await prisma.$transaction(async (db) => {
    await db.bill.delete({ where: { id: billId } });
    await audit(db, userId, "delete", "Bill", billId, bill, { keptPaymentTxId: bill.paidTxId });
  });
  return { keptPaymentTxId: bill.paidTxId };
}
