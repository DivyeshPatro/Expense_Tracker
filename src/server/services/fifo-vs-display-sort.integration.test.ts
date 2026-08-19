// Display order and money allocation, proved independent end to end.
//
// The pure-function test asserts this over allocateFifo alone. This one goes
// through the real service and the real database: two loans on ONE day, a
// partial repayment recorded four times — once per display sort — asserting
// every time WHICH loan the money landed on, read back from LoanAllocation.
//
// The failure this guards against is subtle and would look fine in a total:
// the outstanding balance is ₹800 whichever loan absorbed the ₹700.

import { beforeEach, describe, expect, it } from "vitest";
import { LOAN_SORTS, sortLoanEntries, type LoanSort } from "@/lib/loan-sort";
import { addLoanEntry, listLoanEntries, openLoansForContact } from "./lending";
import { prisma } from "../db";

const EMAIL = "fifo-vs-sort@ledgerly.app";
const rup = (n: number) => Math.round(n * 100);
const DAY = "2026-01-10"; // both loans on the same day — the ambiguous case

let userId: string, contactId: string, loanA: string, loanB: string;

/** What each loan still owes, straight from the allocation rows. */
async function remainingByLoan() {
  const loans = await prisma.loanEntry.findMany({ where: { userId, kind: "GAVE", deletedAt: null }, select: { id: true, amount: true, reason: true } });
  const allocs = await prisma.loanAllocation.findMany({ where: { userId, gotEntry: { deletedAt: null } }, select: { gaveEntryId: true, amount: true } });
  const paid = new Map<string, number>();
  for (const a of allocs) paid.set(a.gaveEntryId, (paid.get(a.gaveEntryId) ?? 0) + Number(a.amount));
  return Object.fromEntries(loans.map((l) => [l.reason!, Number(l.amount) - (paid.get(l.id) ?? 0)]));
}

/** Which loan(s) a repayment actually paid, by reason. */
async function allocationsByReason() {
  const allocs = await prisma.loanAllocation.findMany({
    where: { userId, gotEntry: { deletedAt: null } },
    select: { amount: true, gaveEntry: { select: { reason: true } } },
  });
  return allocs.map((a) => ({ loan: a.gaveEntry.reason, amount: Number(a.amount) })).sort((x, y) => (x.loan ?? "").localeCompare(y.loan ?? ""));
}

describe("display sort vs FIFO allocation", () => {
  beforeEach(async () => {
    const ex = await prisma.user.findUnique({ where: { email: EMAIL } });
    if (ex) await prisma.user.delete({ where: { id: ex.id } });
    userId = (await prisma.user.create({ data: { name: "Owner", email: EMAIL, emailVerified: true } })).id;
    contactId = (await prisma.participant.create({ data: { ownerId: userId, displayName: "Alice" } })).id;

    // A: ₹1,000, entered FIRST.  B: ₹500, entered SECOND. Same day.
    loanA = await addLoanEntry(userId, { participantId: contactId, kind: "GAVE", amount: rup(1000), accountId: null, date: DAY, reason: "A" });
    await new Promise((r) => setTimeout(r, 25)); // distinct createdAt
    loanB = await addLoanEntry(userId, { participantId: contactId, kind: "GAVE", amount: rup(500), accountId: null, date: DAY, reason: "B" });
  });

  it("the two loans really are same-day, and A was entered first", async () => {
    const rows = await prisma.loanEntry.findMany({ where: { id: { in: [loanA, loanB] } }, select: { id: true, occurredAt: true, createdAt: true } });
    const a = rows.find((r) => r.id === loanA)!;
    const b = rows.find((r) => r.id === loanB)!;
    expect(a.occurredAt.getTime()).toBe(b.occurredAt.getTime()); // identical instant
    expect(a.createdAt.getTime()).toBeLessThan(b.createdAt.getTime());
  });

  // The heart of it: one case per display sort.
  for (const { value: sort, label } of LOAN_SORTS) {
    it(`with the history sorted by "${label}", the ₹700 still lands entirely on A`, async () => {
      // 1. what the screen would show under this sort
      const displayed = sortLoanEntries(await listLoanEntries(userId, { participantId: contactId }), sort as LoanSort);
      const displayOrder = displayed.map((e) => e.reason);

      // 2. record the partial repayment through the real service (no manual
      //    allocations → FIFO), with the display sort in play
      await addLoanEntry(userId, { participantId: contactId, kind: "GOT", amount: rup(700), accountId: null, date: DAY, reason: "repayment" });

      // 3. the money landed on A, whatever the screen was showing
      expect(await allocationsByReason()).toEqual([{ loan: "A", amount: rup(700) }]);
      expect(await remainingByLoan()).toEqual({ A: rup(300), B: rup(500) });

      // and the display order really was this sort's order, not FIFO's
      expect(displayOrder).toEqual(
        sort === "recent" ? ["repayment", "B", "A"].filter((x) => x !== "repayment")
        : sort === "oldest" ? ["A", "B"]
        : sort === "highest" ? ["A", "B"]
        : ["B", "A"]
      );
    });
  }

  it("the four sorts genuinely produce different orders on screen", async () => {
    const rows = await listLoanEntries(userId, { participantId: contactId });
    const orders = LOAN_SORTS.map((s) => sortLoanEntries(rows, s.value).map((e) => e.reason).join(">"));
    expect(orders).toEqual(["B>A", "A>B", "A>B", "B>A"]); // recent, oldest, highest, lowest
    expect(new Set(orders).size).toBeGreaterThan(1); // they are not all the same
  });

  it("the allocation is byte-identical across all four sorts", async () => {
    const seen = new Set<string>();
    for (const s of LOAN_SORTS) {
      // fresh repayment each time
      await prisma.loanAllocation.deleteMany({ where: { userId } });
      await prisma.loanEntry.deleteMany({ where: { userId, kind: "GOT" } });
      sortLoanEntries(await listLoanEntries(userId, { participantId: contactId }), s.value); // the user picks a sort
      await addLoanEntry(userId, { participantId: contactId, kind: "GOT", amount: rup(700), accountId: null, date: DAY, reason: "repayment" });
      seen.add(JSON.stringify(await allocationsByReason()));
    }
    expect(seen.size).toBe(1);
    expect([...seen][0]).toBe(JSON.stringify([{ loan: "A", amount: rup(700) }]));
  });

  it("the allocation picker offers A first, matching what actually gets paid", async () => {
    const open = await openLoansForContact(userId, contactId);
    expect(open.map((l) => l.reason)).toEqual(["A", "B"]);
  });

  it("a second repayment continues on A, then spills to B", async () => {
    await addLoanEntry(userId, { participantId: contactId, kind: "GOT", amount: rup(700), accountId: null, date: DAY, reason: "repayment" });
    await addLoanEntry(userId, { participantId: contactId, kind: "GOT", amount: rup(500), accountId: null, date: DAY, reason: "repayment2" });
    expect(await remainingByLoan()).toEqual({ A: 0, B: rup(300) });
  });
});
