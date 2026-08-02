// Database-backed tests for the Khatabook → Lending import.
//
// Live Postgres only (`npm run test:integration`). Verifies the bulk commit is
// mathematically identical to entering each row by hand: contacts deduped,
// GOT repayments settled by FIFO, balances reconciled, undo fully reversing,
// and the whole thing atomic.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { commitLendingImport, importedContactSources, previewLendingImport } from "./lending-import";
import { undoImport } from "./import";
import * as auditModule from "./audit";
import { prisma } from "../db";

const EMAIL = "lending-import-test@ledgerly.app";

/** One Khatabook two-column row. */
function kb(name: string, date: string, gave: string | number | "", got: string | number | "", note = ""): Record<string, unknown> {
  return { Name: name, Date: date, "You Gave": gave, "You Got": got, Details: note };
}

async function freshUser() {
  const existing = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (existing) await prisma.user.delete({ where: { id: existing.id } });
  const user = await prisma.user.create({ data: { name: "Test", email: EMAIL, emailVerified: true } });
  return user.id;
}

async function clearLedger(userId: string) {
  await prisma.importBatch.deleteMany({ where: { userId } });
  await prisma.loanAllocation.deleteMany({ where: { userId } });
  await prisma.loanEntry.deleteMany({ where: { userId } });
  await prisma.participant.deleteMany({ where: { ownerId: userId } });
}

/** Ground-truth net (Σ GAVE − Σ GOT) straight from the ledger, independent of the service under test. */
async function netFor(userId: string, displayName: string): Promise<number> {
  const p = await prisma.participant.findFirst({ where: { ownerId: userId, displayName } });
  if (!p) return 0;
  const entries = await prisma.loanEntry.findMany({ where: { userId, participantId: p.id, deletedAt: null }, select: { kind: true, amount: true } });
  return entries.reduce((s, e) => s + (e.kind === "GAVE" ? Number(e.amount) : -Number(e.amount)), 0);
}

describe("commitLendingImport", () => {
  let userId: string;

  beforeAll(async () => {
    userId = await freshUser();
  });

  beforeEach(async () => {
    await clearLedger(userId);
    vi.restoreAllMocks();
  });

  it("creates one contact per unique name and a loan entry per row", async () => {
    const rows = [
      kb("Ramesh", "01/07/2026", "1500", "", "Rice"),
      kb("Ramesh", "05/07/2026", "", "500", "Part payment"),
      kb("Suresh", "02/07/2026", "300", "", ""),
      kb("Ramesh", "10/07/2026", "200", "", "Oil"),
    ];
    const res = await commitLendingImport(userId, { rawRows: rows, adapterId: "khatabook", fileName: "kb.csv" });

    expect(res.contactsCreated).toBe(2);
    expect(res.entriesImported).toBe(4);
    const participants = await prisma.participant.count({ where: { ownerId: userId } });
    expect(participants).toBe(2);
    // Ramesh: 1500 − 500 + 200 = 1200 ; Suresh: 300
    expect(await netFor(userId, "Ramesh")).toBe(120000);
    expect(await netFor(userId, "Suresh")).toBe(30000);
  });

  it("preserves the note on every entry and defaults the funding source to cash", async () => {
    await commitLendingImport(userId, { rawRows: [kb("Amir", "01/07/2026", "1000", "", "Diwali advance")], adapterId: "khatabook", fileName: "kb.csv" });
    const entry = await prisma.loanEntry.findFirst({ where: { userId } });
    expect(entry?.notes).toBe("Diwali advance");
    expect(entry?.accountId).toBeNull();
  });

  it("settles GOT repayments against prior GAVE loans with FIFO, exactly like manual entry", async () => {
    const rows = [
      kb("Kiran", "01/07/2026", "1000", "", "Loan 1"),
      kb("Kiran", "02/07/2026", "500", "", "Loan 2"),
      kb("Kiran", "10/07/2026", "", "1200", "Repayment"),
    ];
    await commitLendingImport(userId, { rawRows: rows, adapterId: "khatabook", fileName: "kb.csv" });

    const allocations = await prisma.loanAllocation.findMany({ where: { userId }, include: { gaveEntry: true } });
    // 1200 repayment: 1000 fully onto Loan 1 (oldest), 200 onto Loan 2.
    const byLoan = new Map<string, number>();
    for (const a of allocations) byLoan.set(a.gaveEntry.notes ?? "", (byLoan.get(a.gaveEntry.notes ?? "") ?? 0) + Number(a.amount));
    expect(byLoan.get("Loan 1")).toBe(100000);
    expect(byLoan.get("Loan 2")).toBe(20000);
    // Net: 1500 − 1200 = 300
    expect(await netFor(userId, "Kiran")).toBe(30000);
  });

  it("merges into an existing contact and settles new repayments against its open loans", async () => {
    // A contact that already exists with an open GAVE loan.
    const p = await prisma.participant.create({ data: { ownerId: userId, displayName: "Rahul" } });
    await prisma.loanEntry.create({ data: { userId, participantId: p.id, kind: "GAVE", amount: 100000n, occurredAt: new Date("2026-06-01T00:00:00Z") } });

    // Import matches by case/space-insensitive key ("rahul"), default merge.
    const res = await commitLendingImport(userId, {
      rawRows: [kb(" rahul ", "01/07/2026", "", "400", "Repay")],
      adapterId: "khatabook",
      fileName: "kb.csv",
    });
    expect(res.contactsCreated).toBe(0);
    expect(res.contactsMerged).toBe(1);
    expect(await prisma.participant.count({ where: { ownerId: userId } })).toBe(1); // no duplicate
    // 1000 existing − 400 repayment = 600, and the repayment allocated against the existing loan.
    expect(await netFor(userId, "Rahul")).toBe(60000);
    const alloc = await prisma.loanAllocation.findFirst({ where: { userId } });
    expect(alloc && Number(alloc.amount)).toBe(40000);
  });

  it("skips rows that duplicate the existing ledger on re-import", async () => {
    const rows = [kb("Vijay", "01/07/2026", "1000", "", ""), kb("Vijay", "02/07/2026", "", "300", "")];
    await commitLendingImport(userId, { rawRows: rows, adapterId: "khatabook", fileName: "kb.csv" });
    const second = await commitLendingImport(userId, { rawRows: rows, adapterId: "khatabook", fileName: "kb.csv" });
    expect(second.entriesImported).toBe(0);
    expect(second.duplicatesSkipped).toBe(2);
    expect(await prisma.loanEntry.count({ where: { userId } })).toBe(2); // still just the first import
  });

  it("lets an over-repayment take the balance negative without inventing allocations", async () => {
    const rows = [kb("Neha", "01/07/2026", "300", "", ""), kb("Neha", "02/07/2026", "", "500", "")];
    await commitLendingImport(userId, { rawRows: rows, adapterId: "khatabook", fileName: "kb.csv" });
    expect(await netFor(userId, "Neha")).toBe(-20000); // 300 − 500
    // Only 300 of the 500 repayment could be allocated.
    const total = (await prisma.loanAllocation.findMany({ where: { userId } })).reduce((s, a) => s + Number(a.amount), 0);
    expect(total).toBe(30000);
  });

  it("undoes an import: removes its entries and created contacts, keeps pre-existing ones", async () => {
    const preexisting = await prisma.participant.create({ data: { ownerId: userId, displayName: "OldFriend" } });
    const res = await commitLendingImport(userId, {
      rawRows: [kb("NewGuy", "01/07/2026", "1000", "", ""), kb("OldFriend", "02/07/2026", "200", "", "")],
      adapterId: "khatabook",
      fileName: "kb.csv",
      options: { decisions: { oldfriend: "merge" } },
    });

    const undo = await undoImport(userId, res.batchId);
    expect(undo.removedLendingEntries).toBe(2);
    expect(undo.removedContacts).toBe(1); // only NewGuy
    expect(await prisma.loanEntry.count({ where: { userId } })).toBe(0);
    // Pre-existing contact survives; the imported new one is gone.
    expect(await prisma.participant.findFirst({ where: { id: preexisting.id } })).not.toBeNull();
    expect(await prisma.participant.count({ where: { ownerId: userId } })).toBe(1);
  });

  it("reports imported contacts (for the migration badge) and drops them after undo", async () => {
    const res = await commitLendingImport(userId, { rawRows: [kb("Badgey", "01/07/2026", "1000", "", "")], adapterId: "khatabook", fileName: "kb.csv" });
    const created = await prisma.participant.findFirst({ where: { ownerId: userId, displayName: "Badgey" } });
    const before = await importedContactSources(userId);
    expect(before[created!.id]).toBe("Khatabook");
    await undoImport(userId, res.batchId);
    const after = await importedContactSources(userId);
    expect(after[created!.id]).toBeUndefined(); // undone batch no longer counts
  });

  it("is atomic — a failure late in the commit leaves nothing behind", async () => {
    vi.spyOn(auditModule, "audit").mockRejectedValueOnce(new Error("boom"));
    await expect(
      commitLendingImport(userId, { rawRows: [kb("Ghost", "01/07/2026", "1000", "", "")], adapterId: "khatabook", fileName: "kb.csv" })
    ).rejects.toThrow();
    expect(await prisma.participant.count({ where: { ownerId: userId } })).toBe(0);
    expect(await prisma.loanEntry.count({ where: { userId } })).toBe(0);
    expect(await prisma.importBatch.count({ where: { userId } })).toBe(0);
  });

  it("handles a large import in bulk and reconciles the total", async () => {
    const rows: Record<string, unknown>[] = [];
    const CONTACTS = 50;
    const PER = 20;
    for (let c = 0; c < CONTACTS; c++) {
      for (let i = 0; i < PER; i++) {
        const day = String((i % 27) + 1).padStart(2, "0");
        rows.push(kb(`Person ${c}`, `${day}/07/2026`, "100", "", `row ${i}`));
      }
    }
    const res = await commitLendingImport(userId, { rawRows: rows, adapterId: "khatabook", fileName: "big.csv" });
    expect(res.contactsCreated).toBe(CONTACTS);
    expect(res.entriesImported).toBe(CONTACTS * PER);
    // Every entry is a 100 GAVE ⇒ each contact nets 2000.
    expect(await netFor(userId, "Person 0")).toBe(200000);
    const totalEntries = await prisma.loanEntry.count({ where: { userId } });
    expect(totalEntries).toBe(CONTACTS * PER);
  });
});

describe("previewLendingImport", () => {
  let userId: string;
  beforeAll(async () => {
    userId = await freshUser();
  });
  beforeEach(async () => {
    await clearLedger(userId);
  });

  it("reports contacts, totals and a date range without writing anything", async () => {
    const rows = [kb("A", "01/07/2026", "1000", "", ""), kb("B", "03/07/2026", "", "400", ""), kb("A", "05/07/2026", "200", "", "")];
    const preview = await previewLendingImport(userId, rows, "khatabook");
    expect(preview.adapterLabel).toMatch(/khatabook/i);
    expect(preview.contactsToCreate).toBe(2);
    expect(preview.totals).toEqual({ gavePaise: 120000, gotPaise: 40000, netPaise: 80000 });
    expect(preview.dateRange).toEqual({ min: "2026-07-01", max: "2026-07-05" });
    expect(await prisma.loanEntry.count({ where: { userId } })).toBe(0); // no writes
  });

  it("flags invalid rows with a reason and still counts the valid ones", async () => {
    const rows = [kb("", "01/07/2026", "1000", "", ""), kb("Good", "bad-date", "1", "", ""), kb("Good", "02/07/2026", "500", "", "")];
    const preview = await previewLendingImport(userId, rows, "khatabook");
    expect(preview.counts.invalidRows).toBe(2);
    expect(preview.counts.validRows).toBe(1);
    expect(preview.invalid.map((i) => i.reason)).toEqual(expect.arrayContaining([expect.stringMatching(/contact/i), expect.stringMatching(/date/i)]));
  });
});
