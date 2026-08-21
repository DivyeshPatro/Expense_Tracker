// Full data export (PRD §8 Privacy: "full data export (CSV/JSON) … self-serve").
// CSV covers the transaction ledger (the data people actually want to take
// elsewhere); JSON is a complete structural dump of everything the user owns.

import ExcelJS from "exceljs";
import { recordedAtTime, toYMD } from "@/lib/dates";
import { parsePeriod } from "@/lib/period";
import { prisma } from "../db";
import { contactStatement } from "./lending";
import { groupDashboard } from "./group-dashboard";
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

/** Excel statement for a shared-expense group (v2.0 Group Dashboard). All-time:
 * a statement of record, so it reuses groupDashboard with an "all" period and
 * lays out the overview, per-member balances and the settlement history. */
export async function exportGroupStatementXlsx(userId: string, groupId: string): Promise<{ buffer: Buffer; name: string } | null> {
  const g = await groupDashboard(userId, groupId, parsePeriod({ p: "all" }));
  if (!g) return null;
  const R = (paise: number) => paise / 100;

  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Group");

  sheet.addRow(["Ledgerly — Group Statement"]).font = { bold: true, size: 14 };
  sheet.addRow(["Group", g.name]);
  sheet.addRow(["Members", g.memberCount]);
  sheet.addRow(["Created", toYMD(new Date(g.createdAt))]);
  sheet.addRow(["Generated", toYMD(new Date())]);
  sheet.addRow([]);
  sheet.addRow(["Total expenses", "", g.overview.totalExpenseCount, R(g.overview.totalExpenseSum)]);
  sheet.addRow(["Total settlements", "", g.overview.totalSettlementCount, R(g.overview.totalSettlementSum)]);
  sheet.addRow(["You are owed", "", "", R(g.youAreOwed)]);
  sheet.addRow(["You owe", "", "", R(g.youOwe)]);
  sheet.addRow([]);

  const mHead = sheet.addRow(["Member", "Paid", "Share", "Net (+owes you / −you owe)"]);
  mHead.font = { bold: true };
  for (const m of g.members) sheet.addRow([m.name, R(m.paid), R(m.owes), R(m.net)]);
  sheet.addRow([]);

  // The expenses themselves. A statement that totals ₹15,157 without listing
  // what produced it is not a statement — and this is the sheet people take to
  // the group to check the maths against.
  const eHead = sheet.addRow(["Date", "Description", "Category", "Amount", "Paid by", "Split", "Your share"]);
  eHead.font = { bold: true };
  // Oldest first: the service hands them back newest-first for the screen, but
  // a statement reads chronologically.
  for (const e of [...g.expenses].reverse()) {
    sheet.addRow([
      e.ymd,
      e.merchant,
      e.categoryName ?? "",
      R(e.amount),
      e.paidByName,
      e.splitCount === 0 ? "not shared" : `${e.splitCount} way${e.splitCount === 1 ? "" : "s"}`,
      R(e.yourShare),
    ]);
  }
  if (g.expenses.length === 0) sheet.addRow(["No expenses yet"]);
  sheet.addRow([]);

  const sHead = sheet.addRow(["Settlement date", "Member", "Direction", "Amount", "Method"]);
  sHead.font = { bold: true };
  for (const s of g.settlements) {
    // A payment between two members is neither "Paid you" nor "You paid" — it
    // names both ends instead, so the statement stays readable by anyone.
    const direction =
      s.direction === "TO_OWNER" ? "Paid you" : s.direction === "FROM_OWNER" ? "You paid" : `${s.fromName ?? "You"} → ${s.toName ?? "You"}`;
    sheet.addRow([toYMD(new Date(s.settledAt)), s.participantName, direction, R(s.amount), s.method]);
  }
  if (g.settlements.length === 0) sheet.addRow(["No settlements yet"]);

  // ── Sheet 2: the records themselves ────────────────────────────────────────
  // The Group sheet is a summary: it says "3 ways" and prints only YOUR share,
  // so no other member can check their own number and an unequal split is
  // indistinguishable from an equal one. This sheet is the evidence behind it —
  // one row per stored ExpenseSplit and per stored Settlement, nothing derived,
  // nothing netted. Every row reads the same way: on this date, FROM owed or
  // paid TO this amount, for this reason.
  const audit = book.addWorksheet("Audit trail");

  // The owner is stored as null everywhere (payer, share, settlement end). The
  // dashboard has already decided what to call them — "You" for the owner
  // reading their own group, their real name for anyone else — so take that
  // label rather than inventing a second rule that could disagree with the
  // sheet above.
  const ownerLabel = g.members.find((m) => m.participantId === null)?.name ?? "You";

  const aHead = audit.addRow([
    "Date", "Time recorded", "Type", "From (owes / pays)", "To (owed / paid)", "Amount",
    "Group", "Details", "Category", "Expense total", "Paid by", "Basis", "Account",
  ]);
  aHead.font = { bold: true };

  const SPLIT_BASIS: Record<string, string> = { EQUAL: "Equal", PERCENT: "Percent", EXACT: "Exact", RATIO: "Ratio", CUSTOM: "Custom" };
  type AuditRow = { key: string; cells: (string | number)[] };
  const rows: AuditRow[] = [];

  for (const e of g.expenses) {
    for (const sp of e.splits) {
      // Sharing a bill creates a debt to whoever PAID it — so the person who
      // owes is the "from" side, exactly as an obligation reads. The payer's
      // own share is not a debt to themselves; it is labelled as such so it is
      // never summed as one, and it is still listed because the shares only
      // reconcile against the expense total with it present.
      const isPayer = sp.participantId === e.paidByParticipantId;
      rows.push({
        key: `${e.ymd} 1`,
        cells: [
          // No time: an expense's occurredAt is written as istNoon(date), so a
          // clock time here would be invented precision. Settlements carry a
          // real recorded instant and print one.
          e.ymd, "", isPayer ? "Own share" : "Expense share",
          sp.name, isPayer ? sp.name : e.paidByName, R(sp.owedAmount),
          g.name, e.merchant, e.categoryName ?? "", R(e.amount), e.paidByName,
          SPLIT_BASIS[sp.method] ?? sp.method, "",
        ],
      });
    }
  }

  for (const st of g.settlements) {
    // Both ends, always, named. A member↔member payment is between those two
    // members: it is never re-pointed at the owner, and the owner's own row in
    // the sheet above is unaffected by it.
    const when = new Date(st.settledAt);
    const from = st.fromName ?? ownerLabel;
    const to = st.toName ?? ownerLabel;
    rows.push({
      key: `${toYMD(when)} 2`,
      cells: [
        toYMD(when), recordedAtTime(st.settledAt), "Settlement",
        from, to, R(st.amount),
        g.name, st.note ?? "", "", "", "",
        st.method, st.accountName ?? "",
      ],
    });
  }

  // Chronological, the way a ledger is read. Sort is stable, so an expense's
  // shares stay together and in the order they were stored.
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const r of rows) audit.addRow(r.cells);
  if (rows.length === 0) audit.addRow(["Nothing recorded yet"]);

  for (const [c, w] of [[1, 12], [2, 8], [3, 14], [4, 18], [5, 18], [6, 14], [7, 18], [8, 26], [9, 14], [10, 14], [11, 16], [12, 12], [13, 16]] as const) {
    audit.getColumn(c).width = w;
  }
  for (const c of [6, 10]) audit.getColumn(c).numFmt = "#,##0.00";

  sheet.getColumn(1).width = 20;
  sheet.getColumn(2).width = 26; // descriptions live here
  sheet.getColumn(5).width = 16;
  sheet.getColumn(6).width = 12;
  // numFmt only affects numeric cells, so the text columns that share these
  // positions in other sections are unharmed.
  for (const c of [3, 4, 7]) {
    sheet.getColumn(c).width = 16;
    sheet.getColumn(c).numFmt = "#,##0.00";
  }
  return { buffer: Buffer.from(await book.xlsx.writeBuffer()), name: g.name };
}
