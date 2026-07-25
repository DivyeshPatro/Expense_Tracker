// Database-backed tests for bills: due-date roll-forward on payment, and the
// month-end anchor. Run with `npm run test:integration`.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { istNoon, toYMD } from "@/lib/dates";
import { billAnchorDay, createBill, deleteBill, listBills, listPaidBills, markBillPaid, updateBill } from "./bills";
import { prisma } from "../db";

const EMAIL = "bills-test@ledgerly.app";
let userId: string;
let accountId: string;

describe("bills", () => {
  beforeAll(async () => {
    const existing = await prisma.user.findUnique({ where: { email: EMAIL } });
    if (existing) await prisma.user.delete({ where: { id: existing.id } });
    const user = await prisma.user.create({ data: { name: "Bills", email: EMAIL, emailVerified: true } });
    userId = user.id;
    const acc = await prisma.account.create({
      data: { userId, name: "Bills Bank", type: "BANK", balance: 100_000, openingBalance: 100_000 },
    });
    accountId = acc.id;
  });

  beforeEach(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.bill.deleteMany({ where: { userId } });
    await prisma.account.update({ where: { id: accountId }, data: { balance: 100_000 } });
  });

  describe("billAnchorDay", () => {
    it("anchors month-based cadences to the due day and leaves the rest null", () => {
      expect(billAnchorDay("MONTHLY", "2026-01-31")).toBe(31);
      expect(billAnchorDay("QUARTERLY", "2026-01-31")).toBe(31);
      expect(billAnchorDay("YEARLY", "2026-02-29")).toBe(29);
      expect(billAnchorDay("WEEKLY", "2026-01-31")).toBeNull();
      expect(billAnchorDay("DAILY", "2026-01-31")).toBeNull();
      expect(billAnchorDay(null, "2026-01-31")).toBeNull();
    });
  });

  it("creates a recurring bill with its anchor set", async () => {
    await createBill(userId, { name: "Rent", amount: 50_000, categoryId: null, dueDate: "2026-01-31", cadence: "MONTHLY" });
    const bill = await prisma.bill.findFirstOrThrow({ where: { userId } });
    expect(bill.anchorDay).toBe(31);
  });

  it("rolls a recurring bill's due date forward on payment and records the payment", async () => {
    await createBill(userId, { name: "Broadband", amount: 99_900, categoryId: null, dueDate: "2026-07-05", cadence: "MONTHLY" });
    const bill = await prisma.bill.findFirstOrThrow({ where: { userId } });

    await markBillPaid(userId, bill.id, accountId, istNoon("2026-07-05"));

    const after = await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(toYMD(after.dueDate)).toBe("2026-08-05");
    expect(after.status).toBe("UPCOMING"); // recurring bills stay live
    expect(after.paidTxId).toBeTruthy();

    const tx = await prisma.transaction.findFirstOrThrow({ where: { userId } });
    expect(tx.merchant).toBe("Broadband");
    expect(Number(tx.amount)).toBe(99_900);
    const acct = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(Number(acct.balance)).toBe(100_000 - 99_900);
  });

  it("marks a one-off bill paid instead of rolling it", async () => {
    await createBill(userId, { name: "Passport fee", amount: 1_500, categoryId: null, dueDate: "2026-07-05", cadence: null });
    const bill = await prisma.bill.findFirstOrThrow({ where: { userId } });

    await markBillPaid(userId, bill.id, accountId, istNoon("2026-07-05"));

    const after = await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(after.status).toBe("PAID");
    expect(toYMD(after.dueDate)).toBe("2026-07-05"); // unchanged
    // Paid one-off bills drop out of the active list.
    expect(await listBills(userId, istNoon("2026-07-06"))).toEqual([]);
  });

  // Regression: rolling forward from an already-clamped date walked a month-end
  // bill down to the 28th and left it there for every subsequent month.
  it("keeps a month-end bill on its day across a short month", async () => {
    await createBill(userId, { name: "Rent", amount: 50_000, categoryId: null, dueDate: "2026-01-31", cadence: "MONTHLY" });
    const bill = await prisma.bill.findFirstOrThrow({ where: { userId } });

    const seen: string[] = [];
    for (const payDay of ["2026-01-31", "2026-02-28", "2026-03-31"]) {
      await markBillPaid(userId, bill.id, accountId, istNoon(payDay));
      seen.push(toYMD((await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } })).dueDate));
    }

    // February clamps, then March gets the 31st back rather than sticking at 28.
    expect(seen).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("leaves pre-existing bills with no anchor on their current behaviour", async () => {
    const bill = await prisma.bill.create({
      data: { userId, name: "Legacy", amount: 10_000, dueDate: istNoon("2026-01-31"), cadence: "MONTHLY", anchorDay: null },
    });

    await markBillPaid(userId, bill.id, accountId, istNoon("2026-01-31"));
    expect(toYMD((await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } })).dueDate)).toBe("2026-02-28");
    await markBillPaid(userId, bill.id, accountId, istNoon("2026-02-28"));
    expect(toYMD((await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } })).dueDate)).toBe("2026-03-28");
  });

  // markBillPaid falls back through candidate accounts; archived ones must never
  // be picked up as a default payment source.
  it("never falls back to an archived account when paying a bill", async () => {
    await prisma.account.update({ where: { id: accountId }, data: { isArchived: true } });
    const live = await prisma.account.create({
      data: { userId, name: "Live Bank", type: "BANK", balance: 20_000, openingBalance: 20_000 },
    });
    await createBill(userId, { name: "Electricity", amount: 5_000, categoryId: null, dueDate: "2026-07-05", cadence: null });
    const bill = await prisma.bill.findFirstOrThrow({ where: { userId } });

    await markBillPaid(userId, bill.id, undefined, istNoon("2026-07-05"));

    const tx = await prisma.transaction.findFirstOrThrow({ where: { userId } });
    expect(tx.accountId).toBe(live.id);

    await prisma.account.update({ where: { id: accountId }, data: { isArchived: false } });
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.account.delete({ where: { id: live.id } });
  });

  describe("edit", () => {
    it("updates the reminder and re-derives the anchor", async () => {
      await createBill(userId, { name: "Rent", amount: 50_000, categoryId: null, dueDate: "2026-07-05", cadence: "MONTHLY" });
      const bill = await prisma.bill.findFirstOrThrow({ where: { userId } });

      await updateBill(userId, bill.id, { name: "Rent (new flat)", amount: 65_000, categoryId: null, dueDate: "2026-08-31", cadence: "MONTHLY" });

      const after = await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } });
      expect(after.name).toBe("Rent (new flat)");
      expect(Number(after.amount)).toBe(65_000);
      expect(toYMD(after.dueDate)).toBe("2026-08-31");
      expect(after.anchorDay).toBe(31); // re-derived from the new due date
    });

    it("clears the anchor when a recurring bill becomes one-off", async () => {
      await createBill(userId, { name: "Rent", amount: 50_000, categoryId: null, dueDate: "2026-01-31", cadence: "MONTHLY" });
      const bill = await prisma.bill.findFirstOrThrow({ where: { userId } });
      await updateBill(userId, bill.id, { name: "Rent", amount: 50_000, categoryId: null, dueDate: "2026-01-31", cadence: null });
      expect((await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } })).anchorDay).toBeNull();
    });

    it("never disturbs a payment already recorded against the bill", async () => {
      await createBill(userId, { name: "Broadband", amount: 99_900, categoryId: null, dueDate: "2026-07-05", cadence: "MONTHLY" });
      const bill = await prisma.bill.findFirstOrThrow({ where: { userId } });
      await markBillPaid(userId, bill.id, accountId, istNoon("2026-07-05"));
      const paidTx = await prisma.transaction.findFirstOrThrow({ where: { userId } });
      const balanceAfterPayment = Number((await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).balance);

      await updateBill(userId, bill.id, { name: "Broadband", amount: 120_000, categoryId: null, dueDate: "2026-09-05", cadence: "MONTHLY" });

      const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: paidTx.id } });
      expect(Number(tx.amount)).toBe(99_900); // the old price, as it was paid
      expect(Number((await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).balance)).toBe(balanceAfterPayment);
    });

    it("brings a settled one-off back into the active list when rescheduled as recurring", async () => {
      await createBill(userId, { name: "Passport fee", amount: 1_500, categoryId: null, dueDate: "2026-07-05", cadence: null });
      const bill = await prisma.bill.findFirstOrThrow({ where: { userId } });
      await markBillPaid(userId, bill.id, accountId, istNoon("2026-07-05"));
      expect(await listBills(userId, istNoon("2026-07-06"))).toEqual([]);

      await updateBill(userId, bill.id, { name: "Passport fee", amount: 1_500, categoryId: null, dueDate: "2026-09-01", cadence: "YEARLY" });

      const active = await listBills(userId, istNoon("2026-07-06"));
      expect(active.map((b) => b.name)).toEqual(["Passport fee"]);
    });
  });

  describe("delete", () => {
    it("deletes an unpaid bill", async () => {
      await createBill(userId, { name: "Gym", amount: 2_000, categoryId: null, dueDate: "2026-08-01", cadence: null });
      const bill = await prisma.bill.findFirstOrThrow({ where: { userId } });

      const res = await deleteBill(userId, bill.id);

      expect(res.keptPaymentTxId).toBeNull();
      expect(await prisma.bill.count({ where: { userId } })).toBe(0);
    });

    // The whole point: the reminder is a schedule, the payment is money that moved.
    it("deletes a paid bill but leaves its payment transaction untouched", async () => {
      await createBill(userId, { name: "Broadband", amount: 99_900, categoryId: null, dueDate: "2026-07-05", cadence: null });
      const bill = await prisma.bill.findFirstOrThrow({ where: { userId } });
      await markBillPaid(userId, bill.id, accountId, istNoon("2026-07-05"));
      const paidTx = await prisma.transaction.findFirstOrThrow({ where: { userId } });
      const balance = Number((await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).balance);

      const res = await deleteBill(userId, bill.id);

      expect(res.keptPaymentTxId).toBe(paidTx.id);
      expect(await prisma.bill.count({ where: { userId } })).toBe(0);

      const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: paidTx.id } });
      expect(tx.deletedAt).toBeNull();
      expect(Number(tx.amount)).toBe(99_900);
      expect(tx.accountId).toBe(accountId);
      expect(tx.merchant).toBe("Broadband");
      // Balances and therefore analytics are unaffected.
      expect(Number((await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).balance)).toBe(balance);
    });

    it("lists settled one-off bills so they remain reachable", async () => {
      await createBill(userId, { name: "Passport fee", amount: 1_500, categoryId: null, dueDate: "2026-07-05", cadence: null });
      const bill = await prisma.bill.findFirstOrThrow({ where: { userId } });
      await markBillPaid(userId, bill.id, accountId, istNoon("2026-07-05"));

      const paid = await listPaidBills(userId);
      expect(paid.map((b) => b.name)).toEqual(["Passport fee"]);
      expect(paid[0].hasPayment).toBe(true);
      expect(paid[0].paidYMD).toBe("2026-07-05");
    });

    it("will not touch another user's bill", async () => {
      const other = await prisma.user.create({ data: { name: "Other", email: "other-bills@ledgerly.app", emailVerified: true } });
      const theirs = await prisma.bill.create({
        data: { userId: other.id, name: "Theirs", amount: 100, dueDate: istNoon("2026-08-01") },
      });

      await expect(deleteBill(userId, theirs.id)).rejects.toThrow(/not found/);
      await expect(
        updateBill(userId, theirs.id, { name: "Mine", amount: 1, categoryId: null, dueDate: "2026-08-01", cadence: null })
      ).rejects.toThrow(/not found/);
      expect(await prisma.bill.count({ where: { id: theirs.id } })).toBe(1);

      await prisma.user.delete({ where: { id: other.id } });
    });
  });
});
