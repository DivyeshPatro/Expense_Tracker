// The Lending dashboard's sort is presentation only — proved against the real
// service and database.
//
// The dashboard renders balances the server already computed. This asserts that
// picking any of the five orders leaves every financial figure identical: FIFO
// allocation, per-contact balances, running balances, and the summary totals.

import { beforeEach, describe, expect, it } from "vitest";
import { CONTACT_SORTS, sortLendingContacts } from "@/lib/loan-sort";
import { addLoanEntry, getLoanDetail, lendingDashboardSummary, listLoanEntries, openLoansForContact } from "./lending";
import { prisma } from "../db";

const EMAIL = "dash-sort@ledgerly.app";
const rup = (n: number) => Math.round(n * 100);
const DAY = "2026-01-10";
let userId: string, aliceId: string, bobId: string, loanA: string, loanB: string;

/** Every financial figure the dashboard and ledger expose, as one snapshot. */
async function financialSnapshot() {
  const summary = await lendingDashboardSummary(userId);
  const allocs = await prisma.loanAllocation.findMany({
    where: { userId, gotEntry: { deletedAt: null } },
    select: { amount: true, gaveEntry: { select: { reason: true } } },
  });
  const detailA = await getLoanDetail(userId, loanA);
  const detailB = await getLoanDetail(userId, loanB);
  return JSON.stringify({
    youAreOwed: summary.youAreOwed,
    youOwe: summary.youOwe,
    net: summary.net,
    overdueCount: summary.overdueCount,
    contacts: [...summary.contacts].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ name: c.name, net: c.net, entryCount: c.entryCount })),
    allocations: allocs.map((a) => ({ loan: a.gaveEntry.reason, amount: Number(a.amount) })).sort((x, y) => (x.loan ?? "").localeCompare(y.loan ?? "")),
    runningBalances: [detailA, detailB].map((d) => ({ before: d.balanceBeforePaise, after: d.balanceAfterPaise })),
    openLoans: (await openLoansForContact(userId, aliceId)).map((l) => ({ reason: l.reason, remaining: l.remainingAmount })),
  });
}

describe("dashboard sort cannot influence anything financial", () => {
  beforeEach(async () => {
    const ex = await prisma.user.findUnique({ where: { email: EMAIL } });
    if (ex) await prisma.user.delete({ where: { id: ex.id } });
    userId = (await prisma.user.create({ data: { name: "Owner", email: EMAIL, emailVerified: true } })).id;
    aliceId = (await prisma.participant.create({ data: { ownerId: userId, displayName: "Alice" } })).id;
    bobId = (await prisma.participant.create({ data: { ownerId: userId, displayName: "Bob" } })).id;

    // Alice: two same-day loans (the FIFO-ambiguous case) plus a partial repayment.
    loanA = await addLoanEntry(userId, { participantId: aliceId, kind: "GAVE", amount: rup(1000), accountId: null, date: DAY, reason: "A" });
    await new Promise((r) => setTimeout(r, 25));
    loanB = await addLoanEntry(userId, { participantId: aliceId, kind: "GAVE", amount: rup(500), accountId: null, date: DAY, reason: "B" });
    await addLoanEntry(userId, { participantId: aliceId, kind: "GOT", amount: rup(700), accountId: null, date: DAY, reason: "repayment" });
    // Bob: money the owner owes, so the list mixes both directions.
    await addLoanEntry(userId, { participantId: bobId, kind: "GOT", amount: rup(900), accountId: null, date: "2026-03-01", reason: "borrowed" });
  });

  it("7/8/9 — every financial figure is identical under all five sorts", async () => {
    const snapshots = new Set<string>();
    for (const s of CONTACT_SORTS) {
      const summary = await lendingDashboardSummary(userId);
      sortLendingContacts(summary.contacts, s.value); // the user picks a sort
      snapshots.add(await financialSnapshot());
    }
    expect(snapshots.size).toBe(1);
  });

  it("7 — the repayment still lands on the loan entered first", async () => {
    for (const s of CONTACT_SORTS) {
      const summary = await lendingDashboardSummary(userId);
      sortLendingContacts(summary.contacts, s.value);
      const allocs = await prisma.loanAllocation.findMany({
        where: { userId, gotEntry: { deletedAt: null } },
        select: { amount: true, gaveEntry: { select: { reason: true } } },
      });
      expect(allocs.map((a) => ({ loan: a.gaveEntry.reason, amount: Number(a.amount) }))).toEqual([{ loan: "A", amount: rup(700) }]);
    }
  });

  it("9 — summary totals are unchanged", async () => {
    const base = await lendingDashboardSummary(userId);
    expect(base.youAreOwed).toBe(rup(800)); // Alice: 1500 lent − 700 repaid
    expect(base.youOwe).toBe(rup(900)); // Bob
    for (const s of CONTACT_SORTS) {
      const after = await lendingDashboardSummary(userId);
      sortLendingContacts(after.contacts, s.value);
      expect({ owed: after.youAreOwed, owe: after.youOwe, net: after.net }).toEqual({ owed: base.youAreOwed, owe: base.youOwe, net: base.net });
    }
  });

  it("8 — running balances stay chronological, not display order", async () => {
    const a = await getLoanDetail(userId, loanA);
    const b = await getLoanDetail(userId, loanB);
    // A entered first, so B's "before" picks up where A's "after" left off.
    expect(a.balanceBeforePaise).toBe(0);
    expect(a.balanceAfterPaise).toBe(rup(1000));
    expect(b.balanceBeforePaise).toBe(rup(1000));
    expect(b.balanceAfterPaise).toBe(rup(1500));
    for (const s of CONTACT_SORTS) {
      sortLendingContacts((await lendingDashboardSummary(userId)).contacts, s.value);
      expect((await getLoanDetail(userId, loanB)).balanceBeforePaise).toBe(rup(1000));
    }
  });

  it("11 — sorting does not mutate the summary it was handed", async () => {
    const summary = await lendingDashboardSummary(userId);
    const before = summary.contacts.map((c) => c.name);
    for (const s of CONTACT_SORTS) sortLendingContacts(summary.contacts, s.value);
    expect(summary.contacts.map((c) => c.name)).toEqual(before);
  });

  it("the sorts genuinely produce different orders — so this is a real test", async () => {
    const summary = await lendingDashboardSummary(userId);
    const orders = CONTACT_SORTS.map((s) => sortLendingContacts(summary.contacts, s.value).map((c) => c.name).join(">"));
    expect(new Set(orders).size).toBeGreaterThan(1);
  });

  it("10 — the ledger itself stays in FIFO order regardless", async () => {
    for (const s of CONTACT_SORTS) {
      sortLendingContacts((await lendingDashboardSummary(userId)).contacts, s.value);
      expect((await openLoansForContact(userId, aliceId)).map((l) => l.reason)).toEqual(["A", "B"]);
      // and the history query still returns newest-entered first
      const rows = await listLoanEntries(userId, { participantId: aliceId });
      expect(rows[0].reason).toBe("repayment");
    }
  });
});
