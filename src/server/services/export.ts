// Full data export (PRD §8 Privacy: "full data export (CSV/JSON) … self-serve").
// CSV covers the transaction ledger (the data people actually want to take
// elsewhere); JSON is a complete structural dump of everything the user owns.

import ExcelJS from "exceljs";
import { toYMD } from "@/lib/dates";
import { prisma } from "../db";
import { contactStatement } from "./lending";
import { BACKUP_FORMAT_VERSION } from "./backup-restore";
import { toBackupCard } from "./card-backup";

export async function exportTransactionsCsv(userId: string): Promise<string> {
  const rows = await prisma.transaction.findMany({
    where: { userId, deletedAt: null },
    include: { account: { select: { name: true } }, toAccount: { select: { name: true } }, category: { select: { name: true } } },
    orderBy: { occurredAt: "asc" },
  });

  const header = ["Date", "Type", "Amount", "Account", "To Account", "Category", "Merchant", "Notes", "Payment Method", "Recurring"];
  const lines = [header.map(csvCell).join(",")];
  for (const t of rows) {
    lines.push(
      [
        toYMD(t.occurredAt),
        t.type,
        (Number(t.amount) / 100).toFixed(2),
        t.account?.name ?? "",
        t.toAccount?.name ?? "",
        t.category?.name ?? "",
        t.merchant,
        t.notes ?? "",
        t.paymentMethod ?? "",
        t.isRecurring ? "yes" : "no",
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\r\n");
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export async function exportTransactionsXlsx(userId: string): Promise<Buffer> {
  const rows = await prisma.transaction.findMany({
    where: { userId, deletedAt: null },
    include: { account: { select: { name: true } }, toAccount: { select: { name: true } }, category: { select: { name: true } } },
    orderBy: { occurredAt: "asc" },
  });

  const columns = ["Date", "Type", "Amount", "Account", "To Account", "Category", "Merchant", "Notes", "Payment Method", "Recurring"];
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Transactions");
  sheet.columns = columns.map((header) => ({ header, key: header }));
  for (const t of rows) {
    sheet.addRow({
      Date: toYMD(t.occurredAt),
      Type: t.type,
      Amount: Number(t.amount) / 100,
      Account: t.account?.name ?? "",
      "To Account": t.toAccount?.name ?? "",
      Category: t.category?.name ?? "",
      Merchant: t.merchant,
      Notes: t.notes ?? "",
      "Payment Method": t.paymentMethod ?? "",
      Recurring: t.isRecurring ? "yes" : "no",
    });
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

export async function exportFullJson(userId: string) {
  const [user, accounts, categories, transactions, budgets, bills, participants, groups, settlements, recurringRules, loanEntries, loanAllocations, tags, creditCards] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true, email: true, currency: true, createdAt: true } }),
    prisma.account.findMany({ where: { userId } }),
    prisma.category.findMany({ where: { userId } }),
    prisma.transaction.findMany({ where: { userId, deletedAt: null }, include: { splits: true, tags: { include: { tag: true } } } }),
    prisma.budget.findMany({ where: { userId } }),
    prisma.bill.findMany({ where: { userId } }),
    prisma.participant.findMany({ where: { ownerId: userId } }),
    prisma.group.findMany({ where: { createdById: userId }, include: { members: true } }),
    prisma.settlement.findMany({ where: { userId } }),
    prisma.recurringRule.findMany({ where: { userId } }),
    prisma.loanEntry.findMany({ where: { userId, deletedAt: null } }),
    prisma.loanAllocation.findMany({ where: { userId } }),
    prisma.tag.findMany({ where: { userId } }),
    prisma.creditCard.findMany({ where: { userId } }),
  ]);

  return JSON.parse(
    JSON.stringify(
      {
        // formatVersion: bump when the backup shape changes in a way the
        // restore engine can't tolerate blindly. Restore reads accounts,
        // categories, transactions and credit cards; the lending/budget/etc.
        // arrays are carried for forward-completeness (a future restore
        // version).
        //
        // v2 added creditCards. A v1 backup restores into this version
        // unchanged — it simply has no cards.
        formatVersion: BACKUP_FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        user,
        accounts,
        categories,
        transactions,
        budgets,
        bills,
        participants,
        groups,
        settlements,
        recurringRules,
        loanEntries,
        loanAllocations,
        tags,
        // Sealed exactly as stored: the export path never decrypts, so a
        // backup file contains no card number even momentarily, and taking one
        // doesn't require CARD_ENCRYPTION_KEY.
        creditCards: creditCards.map(toBackupCard),
      },
      (_k, v) => (typeof v === "bigint" ? Number(v) : v)
    )
  );
}

/** Excel account statement for one lending contact (v2.1 Lending 2.0 #58).
 * Mirrors the printable statement: meta header, opening balance, the You
 * Gave / You Got entries with a running balance, totals and closing. Amounts
 * are written as rupees (paise ÷ 100) with a currency number format. */
export async function exportContactStatementXlsx(
  userId: string,
  participantId: string,
  range: { from?: string; to?: string } = {}
): Promise<{ buffer: Buffer; name: string }> {
  const st = await contactStatement(userId, participantId, range);
  const R = (paise: number) => paise / 100;
  const periodLabel =
    st.from && st.to ? `${st.from} to ${st.to}` : st.from ? `Since ${st.from}` : st.to ? `Up to ${st.to}` : "All time";

  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Statement");

  sheet.addRow(["Ledgerly — Account Statement"]).font = { bold: true, size: 14 };
  sheet.addRow(["Contact", st.contact.name]);
  if (st.contact.phone) sheet.addRow(["Phone", st.contact.phone]);
  sheet.addRow(["Period", periodLabel]);
  sheet.addRow(["Generated", toYMD(new Date())]);
  sheet.addRow([]);
  sheet.addRow(["Opening balance", "", "", "", R(st.openingBalancePaise)]);
  sheet.addRow([]);

  const head = sheet.addRow(["Date", "Details", "You Gave", "You Got", "Balance"]);
  head.font = { bold: true };
  for (const e of st.entries) {
    sheet.addRow([
      e.occurredAt,
      e.reason ?? (e.kind === "GAVE" ? "You gave" : "You got"),
      e.kind === "GAVE" ? R(e.amount) : null,
      e.kind === "GOT" ? R(e.amount) : null,
      R(e.balanceAfterPaise),
    ]);
  }
  sheet.addRow(["Totals", "", R(st.totalGavePaise), R(st.totalGotPaise), ""]).font = { bold: true };
  sheet.addRow([]);
  sheet.addRow(["Closing balance", "", "", "", R(st.closingBalancePaise)]).font = { bold: true };

  sheet.getColumn(1).width = 16;
  sheet.getColumn(2).width = 34;
  for (const c of [3, 4, 5]) {
    sheet.getColumn(c).width = 14;
    sheet.getColumn(c).numFmt = "#,##0.00";
  }

  return { buffer: Buffer.from(await book.xlsx.writeBuffer()), name: st.contact.name };
}
