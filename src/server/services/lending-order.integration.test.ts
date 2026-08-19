// Lending entries must read newest-entered first.
//
// Every entry is stamped istNoon(date) — one instant per day — so ordering on
// occurredAt alone leaves same-day rows in whatever order Postgres happens to
// return. Someone who has just added an entry expects to see it at the top,
// and instead finds it wherever it landed.
//
// The FIFO allocation has the mirror problem: without a tiebreak, two loans
// made on the same day have no defined order, so which one a repayment pays
// down is not determined.

import { beforeEach, describe, expect, it } from "vitest";
import { istNoon } from "@/lib/dates";
import { listLoanEntries } from "./lending";
import { prisma } from "../db";

const EMAIL = "lending-order@ledgerly.app";
const rup = (n: number) => Math.round(n * 100);
let userId: string, aliceId: string;

/** Three entries on ONE day, created in a known order. */
async function seedSameDay(ymd: string) {
  const made: string[] = [];
  for (const reason of ["first", "second", "third"]) {
    const e = await prisma.loanEntry.create({
      data: { userId, participantId: aliceId, kind: "GAVE", amount: rup(100), occurredAt: istNoon(ymd), reason },
    });
    made.push(e.id);
    await new Promise((r) => setTimeout(r, 15)); // distinct createdAt
  }
  return made;
}

describe("lending entry ordering", () => {
  beforeEach(async () => {
    const ex = await prisma.user.findUnique({ where: { email: EMAIL } });
    if (ex) await prisma.user.delete({ where: { id: ex.id } });
    userId = (await prisma.user.create({ data: { name: "Owner", email: EMAIL, emailVerified: true } })).id;
    aliceId = (await prisma.participant.create({ data: { ownerId: userId, displayName: "Alice" } })).id;
  });

  it("lists the most recently entered first when entries share a day", async () => {
    await seedSameDay("2026-08-20");
    const rows = await listLoanEntries(userId, { participantId: aliceId });
    expect(rows.map((r) => r.reason)).toEqual(["third", "second", "first"]);
  });

  it("still orders by date first, across days", async () => {
    await prisma.loanEntry.create({ data: { userId, participantId: aliceId, kind: "GAVE", amount: rup(50), occurredAt: istNoon("2026-08-21"), reason: "tomorrow" } });
    await seedSameDay("2026-08-20"); // entered later, but dated earlier
    const rows = await listLoanEntries(userId, { participantId: aliceId });
    expect(rows[0].reason).toBe("tomorrow");
    expect(rows.slice(1).map((r) => r.reason)).toEqual(["third", "second", "first"]);
  });

  it("the order is stable across repeated reads", async () => {
    await seedSameDay("2026-08-20");
    const a = (await listLoanEntries(userId, { participantId: aliceId })).map((r) => r.reason);
    const b = (await listLoanEntries(userId, { participantId: aliceId })).map((r) => r.reason);
    const c = (await listLoanEntries(userId, { participantId: aliceId })).map((r) => r.reason);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("a single entry and an empty history are unaffected", async () => {
    expect(await listLoanEntries(userId, { participantId: aliceId })).toEqual([]);
    await prisma.loanEntry.create({ data: { userId, participantId: aliceId, kind: "GAVE", amount: rup(10), occurredAt: istNoon("2026-08-20"), reason: "only" } });
    expect((await listLoanEntries(userId, { participantId: aliceId })).map((r) => r.reason)).toEqual(["only"]);
  });
});
