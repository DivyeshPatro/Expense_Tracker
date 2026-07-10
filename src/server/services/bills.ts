// Bills: due-date tracking with urgency, "mark paid" creates the payment
// transaction and rolls the due date forward by the bill's cadence (PRD §4.5).

import { advance, daysFromToday, istNoon, toYMD, todayYMD, MONTH_NAMES } from "@/lib/dates";
import { MISC_META } from "@/lib/categories";
import { prisma } from "../db";
import { audit } from "./audit";
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
}

export async function listBills(userId: string, now = new Date()): Promise<BillView[]> {
  const bills = await prisma.bill.findMany({
    where: { userId, status: { not: "PAID" } },
    orderBy: { dueDate: "asc" },
  });
  const cats = await prisma.category.findMany({ where: { userId } });
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
    };
  });
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
      const next = advance(toYMD(bill.dueDate), bill.cadence, 1);
      await db.bill.update({ where: { id: billId }, data: { dueDate: istNoon(next), paidTxId: t.id, status: "UPCOMING" } });
    } else {
      await db.bill.update({ where: { id: billId }, data: { status: "PAID", paidTxId: t.id } });
    }
    await audit(db, userId, "bill-paid", "Bill", billId, bill, { paidTxId: t.id });
  });
}

export interface BillInput {
  name: string;
  amount: number;
  categoryId: string | null;
  dueDate: string; // YYYY-MM-DD
  cadence: "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY" | null;
}

export async function createBill(userId: string, input: BillInput) {
  await prisma.bill.create({
    data: {
      userId,
      name: input.name,
      amount: input.amount,
      categoryId: input.categoryId,
      dueDate: istNoon(input.dueDate),
      cadence: input.cadence,
    },
  });
}
