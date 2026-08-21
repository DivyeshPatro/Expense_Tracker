// P1-1 — the Group statement's audit trail.
//
// The summary sheet says "3 ways" and prints only YOUR share. That is a
// summary, not evidence: an unequal split is indistinguishable from an equal
// one, and no other member can check their own number against it. The second
// sheet lists the stored records — one row per ExpenseSplit, one per Settlement
// — so the maths can be checked line by line.
//
// The case this sheet exists to get right is a payment between two members. It
// is between THOSE two members: re-pointing either end at the owner would be a
// false record of who paid whom.

import { beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { exportGroupStatementXlsx } from "./export";
import { prisma } from "../db";

const EMAIL = "export-audit@ledgerly.app";
const rup = (n: number) => Math.round(n * 100);

/** Column positions, named once. */
const C = { date: 0, time: 1, type: 2, from: 3, to: 4, amount: 5, group: 6, details: 7, category: 8, total: 9, paidBy: 10, basis: 11, account: 12 };

async function readNamed(buffer: Buffer, name: string) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = book.getWorksheet(name)!;
  const rows: string[][] = [];
  sheet.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map((v) => (v == null ? "" : String(v)))));
  return rows;
}

describe("group statement — audit trail sheet", () => {
  let uid: string, gid: string, ana: string, ben: string, cara: string;

  beforeAll(async () => {
    const ex = await prisma.user.findUnique({ where: { email: EMAIL } });
    if (ex) await prisma.user.delete({ where: { id: ex.id } });
    uid = (await prisma.user.create({ data: { name: "Owner", email: EMAIL, emailVerified: true } })).id;
    const categoryId = (await prisma.category.create({ data: { userId: uid, name: "Travel", kind: "EXPENSE", icon: "🧳", color: "#000" } })).id;
    const accountId = (await prisma.account.create({ data: { userId: uid, name: "HDFC", type: "BANK" } })).id;
    const mkP = async (displayName: string) => (await prisma.participant.create({ data: { ownerId: uid, displayName } })).id;
    ana = await mkP("Ana");
    ben = await mkP("Ben");
    cara = await mkP("Cara");
    gid = (
      await prisma.group.create({
        data: { name: "Audit", createdById: uid, members: { create: [{ participantId: ana }, { participantId: ben }, { participantId: cara }] } },
      })
    ).id;

    const mk = (merchant: string, amount: number, ymd: string, paidBy: string | null, shares: [string | null, number, "EQUAL" | "EXACT"][]) =>
      prisma.transaction.create({
        data: {
          userId: uid,
          type: "EXPENSE",
          amount: rup(amount),
          categoryId,
          merchant,
          occurredAt: new Date(`${ymd}T06:30:00.000Z`),
          groupId: gid,
          paidByParticipantId: paidBy,
          splits: { create: shares.map(([participantId, owed, method]) => ({ participantId, owedAmount: rup(owed), method })) },
        },
      });
    // Equal, paid by the owner.
    await mk("Hotel", 900, "2026-08-01", null, [
      [null, 300, "EQUAL"],
      [ana, 300, "EQUAL"],
      [ben, 300, "EQUAL"],
    ]);
    // Deliberately UNEQUAL and paid by a member — the case the summary sheet
    // cannot express at all.
    await mk("Cab", 500, "2026-08-02", ana, [
      [ana, 200, "EXACT"],
      [ben, 150, "EXACT"],
      [null, 150, "EXACT"],
    ]);

    // A settlement with a real cash leg, so the account it moved through can be
    // named. Not attached to the group, exactly as recordSettlement writes it.
    const cash = await prisma.transaction.create({
      data: { userId: uid, type: "INCOME", amount: rup(300), accountId, merchant: "Settled up — Ana paid you", occurredAt: new Date("2026-08-03T06:30:00.000Z") },
    });
    await prisma.settlement.create({
      data: { userId: uid, participantId: ana, direction: "TO_OWNER", amount: rup(300), method: "UPI", groupId: gid, transactionId: cash.id, settledAt: new Date("2026-08-03T06:30:00.000Z") },
    });
    await prisma.settlement.create({
      data: { userId: uid, participantId: ben, direction: "FROM_OWNER", amount: rup(100), method: "CASH", groupId: gid, note: "kept it simple", settledAt: new Date("2026-08-04T06:30:00.000Z") },
    });
    // Ben → Cara. The owner is not a party and no cash leg exists.
    await prisma.settlement.create({
      data: { userId: uid, participantId: null, direction: null, fromParticipantId: ben, toParticipantId: cara, amount: rup(250), method: "CASH", groupId: gid, settledAt: new Date("2026-08-05T06:30:00.000Z") },
    });
  });

  const body = async () => (await readNamed((await exportGroupStatementXlsx(uid, gid))!.buffer, "Audit trail")).filter((r) => r[C.date] !== "Date");

  it("is a second sheet — the summary sheet is left as it was", async () => {
    const out = (await exportGroupStatementXlsx(uid, gid))!;
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(out.buffer as unknown as ArrayBuffer);
    expect(book.worksheets.map((w) => w.name)).toEqual(["Group", "Audit trail"]);
    // the summary sheet still carries its own sections
    const first = book.worksheets[0];
    const rows: string[][] = [];
    first.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map((v) => (v == null ? "" : String(v)))));
    expect(rows.some((r) => r[0] === "Member" && r[1] === "Paid")).toBe(true);
    expect(rows.some((r) => r[0] === "Settlement date")).toBe(true);
    expect(rows.some((r) => r[1] === "Cab" && r[5] === "3 ways")).toBe(true);
  });

  it("has one row per stored split and per stored settlement", async () => {
    const splits = await prisma.expenseSplit.count({ where: { tx: { groupId: gid } } });
    const settlements = await prisma.settlement.count({ where: { groupId: gid } });
    expect(splits).toBe(6);
    expect(settlements).toBe(3);
    expect((await body()).length).toBe(splits + settlements);
  });

  it("names every share, so each member can check their own number", async () => {
    const cab = (await body()).filter((r) => r[C.details] === "Cab");
    expect(cab.map((r) => [r[C.from], r[C.amount]])).toEqual([
      ["Ana", "200"],
      ["Ben", "150"],
      ["You", "150"],
    ]);
  });

  it("shows an unequal split as unequal, which '3 ways' cannot", async () => {
    const cab = (await body()).filter((r) => r[C.details] === "Cab");
    expect(new Set(cab.map((r) => r[C.amount])).size).toBeGreaterThan(1);
    expect(cab.every((r) => r[C.basis] === "Exact")).toBe(true);
    expect(cab.every((r) => r[C.total] === "500")).toBe(true);
  });

  it("points a share at whoever paid the bill, not at the owner", async () => {
    const ben = (await body()).find((r) => r[C.details] === "Cab" && r[C.from] === "Ben")!;
    expect(ben[C.to]).toBe("Ana"); // Ana paid, so Ben owes Ana
    expect(ben[C.type]).toBe("Expense share");
    expect(ben[C.paidBy]).toBe("Ana");
  });

  it("labels the payer's own share so it is never summed as a debt", async () => {
    const own = (await body()).find((r) => r[C.details] === "Cab" && r[C.from] === "Ana")!;
    expect(own[C.type]).toBe("Own share");
    expect(own[C.to]).toBe("Ana");
  });

  it("the shares of an expense add up to its total", async () => {
    const rows = await body();
    for (const [merchant, total] of [
      ["Hotel", 900],
      ["Cab", 500],
    ] as const) {
      const sum = rows.filter((r) => r[C.details] === merchant).reduce((s, r) => s + Number(r[C.amount]), 0);
      expect(sum).toBe(total);
    }
  });

  it("records a member → owner settlement with both ends named", async () => {
    const r = (await body()).find((x) => x[C.type] === "Settlement" && x[C.amount] === "300")!;
    expect(r[C.from]).toBe("Ana");
    expect(r[C.to]).toBe("You");
    expect(r[C.basis]).toBe("UPI");
  });

  it("records an owner → member settlement in that direction", async () => {
    const r = (await body()).find((x) => x[C.type] === "Settlement" && x[C.amount] === "100")!;
    expect(r[C.from]).toBe("You");
    expect(r[C.to]).toBe("Ben");
    expect(r[C.details]).toBe("kept it simple");
  });

  it("records a member → member settlement as A → B, never through the owner", async () => {
    const rows = await body();
    const r = rows.find((x) => x[C.type] === "Settlement" && x[C.amount] === "250")!;
    expect(r[C.from]).toBe("Ben");
    expect(r[C.to]).toBe("Cara");
    expect(r[C.from]).not.toBe("You");
    expect(r[C.to]).not.toBe("You");
    // and no second, owner-facing row was invented for it
    expect(rows.filter((x) => x[C.amount] === "250").length).toBe(1);
  });

  it("names the account a settlement moved through, and leaves it blank when none", async () => {
    const rows = await body();
    expect(rows.find((r) => r[C.type] === "Settlement" && r[C.amount] === "300")![C.account]).toBe("HDFC");
    // Between two members no cash leg exists at all — the owner's money did not move.
    expect(rows.find((r) => r[C.amount] === "250")![C.account]).toBe("");
  });

  it("times only what carries a time — settlements, not expense dates", async () => {
    const rows = await body();
    // occurredAt is written as istNoon(date), so a clock time on an expense row
    // would be invented precision.
    expect(rows.filter((r) => r[C.type] !== "Settlement").every((r) => r[C.time] === "")).toBe(true);
    expect(rows.find((r) => r[C.amount] === "250")![C.time]).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });

  it("reads chronologically", async () => {
    const dates = (await body()).map((r) => r[C.date]);
    expect([...dates].sort()).toEqual(dates);
  });

  it("carries the group on every row, so rows survive being pasted together", async () => {
    expect((await body()).every((r) => r[C.group] === "Audit")).toBe(true);
  });

  it("matches the stored settlement amounts exactly", async () => {
    const stored = await prisma.settlement.findMany({ where: { groupId: gid }, orderBy: { settledAt: "asc" } });
    const exported = (await body()).filter((r) => r[C.type] === "Settlement").map((r) => Math.round(Number(r[C.amount]) * 100));
    expect(exported).toEqual(stored.map((s) => Number(s.amount)));
  });

  it("matches the stored split amounts exactly", async () => {
    const stored = await prisma.expenseSplit.findMany({ where: { tx: { groupId: gid } } });
    const exported = (await body()).filter((r) => r[C.type] !== "Settlement").map((r) => Math.round(Number(r[C.amount]) * 100));
    expect(exported.reduce((s, n) => s + n, 0)).toBe(stored.reduce((s, r) => s + Number(r.owedAmount), 0));
  });
});
