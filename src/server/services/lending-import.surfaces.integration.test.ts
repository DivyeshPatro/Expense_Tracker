// Large-file + downstream-surfaces check for the Khatabook → Lending import.
//
// Imports a realistic multi-hundred-contact ledger and confirms the data lands
// correctly and shows up where it should — settlement allocations, Global
// Search, the Activity trail — then that Undo removes all of it. The dashboard
// and reports pages are cache()-wrapped RSC reads and are exercised in the
// Playwright audit instead; here we verify the data they read.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { commitLendingImport } from "./lending-import";
import { unifiedSearch } from "./search";
import { undoImport } from "./import";
import { prisma } from "../db";

const EMAIL = "lending-surfaces-test@ledgerly.app";
const CONTACTS = 50;
const PER = 30;

function buildRows() {
  const rows: Record<string, unknown>[] = [];
  for (let c = 0; c < CONTACTS; c++) {
    const name = `ZZZAudit ${c}`;
    for (let j = 0; j < PER; j++) {
      const kind = j % 3 === 2 ? "got" : "gave";
      const day = String((j % 27) + 1).padStart(2, "0");
      const month = String((j % 12) + 1).padStart(2, "0");
      rows.push({ Name: name, Date: `${day}/${month}/2026`, "You Gave": kind === "gave" ? 100 : "", "You Got": kind === "got" ? 100 : "", Details: `${name} row ${j}` });
    }
  }
  // 40 exact duplicates of the very first row, and 20 invalid (no contact) rows.
  const first = rows[0];
  for (let i = 0; i < 40; i++) rows.push({ ...first });
  for (let i = 0; i < 20; i++) rows.push({ Name: "", Date: "01/01/2026", "You Gave": 100, "You Got": "", Details: "junk" });
  return rows;
}

async function freshUser() {
  const existing = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (existing) await prisma.user.delete({ where: { id: existing.id } });
  return (await prisma.user.create({ data: { name: "Test", email: EMAIL, emailVerified: true } })).id;
}

describe("large Khatabook import + downstream surfaces", () => {
  let userId: string;
  let elapsedMs = 0;

  beforeAll(async () => {
    userId = await freshUser();
  });
  beforeEach(async () => {
    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.importBatch.deleteMany({ where: { userId } });
    await prisma.loanAllocation.deleteMany({ where: { userId } });
    await prisma.loanEntry.deleteMany({ where: { userId } });
    await prisma.participant.deleteMany({ where: { ownerId: userId } });
  });

  it(`imports ${CONTACTS * PER} rows in bulk, deduped and validated, under the perf budget`, async () => {
    const rows = buildRows();
    const started = Date.now();
    const res = await commitLendingImport(userId, { rawRows: rows, adapterId: "khatabook", fileName: "big-khatabook.csv" });
    elapsedMs = Date.now() - started;
    console.log(`  [perf] ${rows.length} rows → ${res.entriesImported} entries in ${elapsedMs}ms`);

    expect(res.contactsCreated).toBe(CONTACTS);
    expect(res.entriesImported).toBe(CONTACTS * PER);
    expect(res.duplicatesSkipped).toBe(40);
    expect(res.invalidSkipped).toBe(20);
    // Generous ceiling — typically well under a second; this only catches an
    // accidental N+1 regression, not a strict SLA.
    expect(elapsedMs).toBeLessThan(20000);
  });

  it("settles repayments with FIFO — the total allocated equals the repayments received", async () => {
    await commitLendingImport(userId, { rawRows: buildRows(), adapterId: "khatabook", fileName: "big-khatabook.csv" });
    // Contact 0: 20 GAVE ×100, 10 GOT ×100 ⇒ ₹1,000 net, ₹1,000 of repayments all allocated.
    const p = await prisma.participant.findFirst({ where: { ownerId: userId, displayName: "ZZZAudit 0" } });
    const allocations = await prisma.loanAllocation.findMany({ where: { userId, gotEntry: { participantId: p!.id } }, select: { amount: true } });
    const allocated = allocations.reduce((s, a) => s + Number(a.amount), 0);
    expect(allocated).toBe(100000); // 10 × ₹100
    // At least one GAVE loan fully settled.
    const gave = await prisma.loanEntry.findMany({ where: { userId, participantId: p!.id, kind: "GAVE" }, select: { id: true, amount: true } });
    const settledById = new Map<string, number>();
    for (const a of await prisma.loanAllocation.findMany({ where: { userId, gaveEntry: { participantId: p!.id } }, select: { gaveEntryId: true, amount: true } })) {
      settledById.set(a.gaveEntryId, (settledById.get(a.gaveEntryId) ?? 0) + Number(a.amount));
    }
    const fullySettled = gave.filter((g) => (settledById.get(g.id) ?? 0) === Number(g.amount));
    expect(fullySettled.length).toBeGreaterThan(0);
  });

  it("makes imported contacts findable in Global Search with their lending balance", async () => {
    await commitLendingImport(userId, { rawRows: buildRows(), adapterId: "khatabook", fileName: "big-khatabook.csv" });
    const found = await unifiedSearch(userId, "ZZZAudit 7");
    const hit = found.contacts.find((c) => c.name === "ZZZAudit 7");
    expect(hit).toBeTruthy();
    expect(hit!.lendingNet).toBe(100000); // ₹1,000 net
  });

  it("records exactly one import event with the lending count for the Activity Timeline", async () => {
    const res = await commitLendingImport(userId, { rawRows: buildRows(), adapterId: "khatabook", fileName: "big-khatabook.csv" });
    const events = await prisma.auditLog.findMany({ where: { userId, entity: "ImportBatch", action: "import" } });
    expect(events).toHaveLength(1);
    const after = events[0].after as Record<string, unknown>;
    expect(after.lendingEntries).toBe(res.entriesImported);
    expect(after.source).toBe("khatabook");
  });

  it("undoes the whole large import cleanly", async () => {
    const res = await commitLendingImport(userId, { rawRows: buildRows(), adapterId: "khatabook", fileName: "big-khatabook.csv" });
    const undo = await undoImport(userId, res.batchId);
    expect(undo.removedLendingEntries).toBe(CONTACTS * PER);
    expect(undo.removedContacts).toBe(CONTACTS);
    expect(await prisma.loanEntry.count({ where: { userId } })).toBe(0);
    expect(await prisma.loanAllocation.count({ where: { userId } })).toBe(0);
    expect(await prisma.participant.count({ where: { ownerId: userId } })).toBe(0);
  });
});
