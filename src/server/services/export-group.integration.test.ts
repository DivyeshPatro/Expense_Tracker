// The group statement must contain the expenses.
//
// It reported "Total expenses 7 / ₹15,157" and then listed only member balances
// and settlement history — the seven rows that produced the figure were absent.
// This is the sheet people take to the group to check the maths against, so the
// evidence has to be in it.

import { beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { exportGroupStatementXlsx } from "./export";
import { prisma } from "../db";

const EMAIL = "export-group@ledgerly.app";
const rup = (n: number) => Math.round(n * 100);
let userId: string, groupId: string, anaId: string;

/** The sheet as a grid of plain values. */
async function readSheet(buffer: Buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = book.worksheets[0];
  const rows: string[][] = [];
  sheet.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map((v) => (v == null ? "" : String(v)))));
  return rows;
}

describe("group statement export", () => {
  beforeAll(async () => {
    const ex = await prisma.user.findUnique({ where: { email: EMAIL } });
    if (ex) await prisma.user.delete({ where: { id: ex.id } });
    userId = (await prisma.user.create({ data: { name: "Owner", email: EMAIL, emailVerified: true } })).id;
    const categoryId = (await prisma.category.create({ data: { userId, name: "Food", kind: "EXPENSE", icon: "🍔", color: "#000" } })).id;
    anaId = (await prisma.participant.create({ data: { ownerId: userId, displayName: "Ana" } })).id;
    groupId = (await prisma.group.create({ data: { name: "Trip", createdById: userId, members: { create: [{ participantId: anaId }] } } })).id;
    const mk = (merchant: string, amount: number, ymd: string, paidBy: string | null, shares: [string | null, number][]) =>
      prisma.transaction.create({
        data: {
          userId, type: "EXPENSE", amount: rup(amount), categoryId, merchant,
          occurredAt: new Date(`${ymd}T06:30:00.000Z`), groupId, paidByParticipantId: paidBy,
          splits: { create: shares.map(([participantId, owed]) => ({ participantId, owedAmount: rup(owed) })) },
        },
      });
    await mk("Dinner", 300, "2026-08-10", null, [[null, 150], [anaId, 150]]);
    await mk("Taxi", 200, "2026-08-12", anaId, [[null, 100], [anaId, 100]]);
    await mk("My own snack", 65, "2026-08-14", null, []); // in the group, shared with nobody
  });

  it("lists every expense, not just the totals", async () => {
    const out = (await exportGroupStatementXlsx(userId, groupId))!;
    const rows = await readSheet(out.buffer);
    const flat = rows.map((r) => r.join("|"));
    expect(flat.some((r) => r.includes("Dinner"))).toBe(true);
    expect(flat.some((r) => r.includes("Taxi"))).toBe(true);
    expect(flat.some((r) => r.includes("My own snack"))).toBe(true);
  });

  it("has a header row for them", async () => {
    const rows = await readSheet((await exportGroupStatementXlsx(userId, groupId))!.buffer);
    const head = rows.find((r) => r[0] === "Date" && r[1] === "Description");
    expect(head).toEqual(["Date", "Description", "Category", "Amount", "Paid by", "Split", "Your share"]);
  });

  it("records who paid, the split and your share", async () => {
    const rows = await readSheet((await exportGroupStatementXlsx(userId, groupId))!.buffer);
    const taxi = rows.find((r) => r[1] === "Taxi")!;
    expect(taxi[0]).toBe("2026-08-12");
    expect(taxi[3]).toBe("200"); // amount in rupees
    expect(taxi[4]).toBe("Ana"); // a member paid this one
    expect(taxi[5]).toBe("2 ways");
    expect(taxi[6]).toBe("100"); // your share
    const dinner = rows.find((r) => r[1] === "Dinner")!;
    expect(dinner[4]).toBe("You");
  });

  it("says 'not shared' rather than '0 ways' for an unsplit row", async () => {
    const rows = await readSheet((await exportGroupStatementXlsx(userId, groupId))!.buffer);
    expect(rows.find((r) => r[1] === "My own snack")![5]).toBe("not shared");
  });

  it("lists them oldest first, as a statement reads", async () => {
    const rows = await readSheet((await exportGroupStatementXlsx(userId, groupId))!.buffer);
    const dates = rows.filter((r) => ["Dinner", "Taxi", "My own snack"].includes(r[1])).map((r) => r[0]);
    expect(dates).toEqual(["2026-08-10", "2026-08-12", "2026-08-14"]);
  });

  it("the listed amounts reconcile with the stated total", async () => {
    const rows = await readSheet((await exportGroupStatementXlsx(userId, groupId))!.buffer);
    const listed = rows.filter((r) => ["Dinner", "Taxi", "My own snack"].includes(r[1])).reduce((s, r) => s + Number(r[3]), 0);
    const totalRow = rows.find((r) => r[0] === "Total expenses")!;
    expect(listed).toBe(Number(totalRow[3]));
    expect(listed).toBe(565);
  });

  it("still carries the member balances and settlement history", async () => {
    const rows = await readSheet((await exportGroupStatementXlsx(userId, groupId))!.buffer);
    expect(rows.some((r) => r[0] === "Member" && r[1] === "Paid")).toBe(true);
    expect(rows.some((r) => r[0] === "Settlement date")).toBe(true);
  });
});
