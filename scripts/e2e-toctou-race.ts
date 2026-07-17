// Production audit §1.1 (Phase A blocker #1) — proves the SERIALIZABLE +
// retry fix in `serializable()` (transactions.ts) closes the read-then-write
// race checkOverride's version comparison alone could not: two genuinely
// CONCURRENT updates to the same row, both reading the same stale version,
// used to both apply — the second silently overwriting the first's fields
// with no OK_OVERRIDE, no CONFLICT, nothing. This script fires two real
// updateExpense() calls via Promise.all (not sequentially, unlike every
// existing race test in this codebase — see the audit's own note on why
// those never caught this) so their $transaction calls genuinely interleave
// at the database level, then asserts exactly one side won cleanly and the
// other got an honest CONFLICT — never a silently corrupted/blended amount.
// Run: npx tsx scripts/e2e-toctou-race.ts
import { randomUUID } from "node:crypto";
import { prisma } from "../src/server/db";
import { createGroup } from "../src/server/services/groups";
import { ConflictError, applyBalances, updateExpense, type IntentMeta } from "../src/server/services/transactions";

const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

function intent(baseVersion: number): IntentMeta {
  return { intentId: randomUUID(), deviceId: randomUUID(), clientTs: new Date().toISOString(), baseVersion };
}

async function main() {
  const suffix = randomUUID().slice(0, 8);
  const alice = await prisma.user.findFirstOrThrow({ where: { email: "arjun@ledgerly.app" } });
  const aliceAccount = await prisma.account.findFirstOrThrow({ where: { userId: alice.id } });
  const aliceCategory = await prisma.category.findFirstOrThrow({ where: { userId: alice.id, kind: "EXPENSE" } });

  const bob = await prisma.user.create({ data: { name: "RaceBob", email: `race-bob-${suffix}@test.local`, emailVerified: true } });
  const groupName = `RaceFlat-${suffix}`;
  await createGroup(alice.id, groupName, []);
  const flat = await prisma.group.findFirstOrThrow({ where: { name: groupName, createdById: alice.id } });
  const bobParticipant = await prisma.participant.create({ data: { ownerId: alice.id, displayName: "RaceBob", linkedUserId: bob.id } });
  await prisma.groupMember.create({ data: { groupId: flat.id, participantId: bobParticipant.id, role: "MEMBER" } });

  const cleanupTxIds: string[] = [];

  try {
    // ═══════════════════════ genuine concurrent race: two different actors, same baseVersion ═══════════════════════
    for (let round = 1; round <= 5; round++) {
      const tx = await prisma.transaction.create({
        data: {
          userId: alice.id,
          type: "EXPENSE",
          accountId: aliceAccount.id,
          categoryId: aliceCategory.id,
          amount: 10000,
          merchant: `RaceTx-${suffix}-${round}`,
          occurredAt: new Date(),
          groupId: flat.id,
        },
      });
      await prisma.account.update({ where: { id: aliceAccount.id }, data: { balance: { decrement: 10000 } } });
      cleanupTxIds.push(tx.id);

      const alicePayload = {
        amount: 55500,
        accountId: aliceAccount.id,
        categoryId: aliceCategory.id,
        merchant: `RaceTx-${suffix}-${round}-alice`,
        date: new Date().toISOString().slice(0, 10),
      };
      const bobPayload = {
        amount: 99900,
        accountId: aliceAccount.id,
        categoryId: aliceCategory.id,
        merchant: `RaceTx-${suffix}-${round}-bob`,
        date: new Date().toISOString().slice(0, 10),
      };

      // both fired in the SAME tick, both reading baseVersion=1 — this is
      // the actual race window; no sequencing, no waits between them
      const [aliceOutcome, bobOutcome] = await Promise.allSettled([
        updateExpense(alice.id, tx.id, alicePayload, intent(1)),
        updateExpense(bob.id, tx.id, bobPayload, intent(1)),
      ]);

      const aliceOk = aliceOutcome.status === "fulfilled";
      const bobOk = bobOutcome.status === "fulfilled";
      const aliceConflict = aliceOutcome.status === "rejected" && aliceOutcome.reason instanceof ConflictError;
      const bobConflict = bobOutcome.status === "rejected" && bobOutcome.reason instanceof ConflictError;

      // exactly one side must win cleanly and the other must get an HONEST
      // conflict signal — never both silently "succeeding" (which is exactly
      // the bug: the second one to physically commit would silently clobber
      // the first with zero signal), and never both failing
      const exactlyOneWon = (aliceOk && bobConflict) || (bobOk && aliceConflict);
      ok(`round ${round}: exactly one concurrent actor wins cleanly, the other gets an honest CONFLICT (never both silently applying)`, exactlyOneWon, `alice=${aliceOutcome.status}${aliceConflict ? "(CONFLICT)" : ""}, bob=${bobOutcome.status}${bobConflict ? "(CONFLICT)" : ""}`);

      const final = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
      const winnerAmount = aliceOk ? alicePayload.amount : bobOk ? bobPayload.amount : -1;
      ok(
        `round ${round}: the final row matches EXACTLY the winner's submitted amount — no corrupted/blended state`,
        Number(final.amount) === winnerAmount,
        `final=${final.amount}, expected winner amount=${winnerAmount}`
      );

      const intentRows = await prisma.intent.findMany({ where: { entityId: tx.id } });
      ok(`round ${round}: exactly one Intent row exists for this entity — the loser's write never touched the database at all`, intentRows.length === 1, `${intentRows.length} row(s)`);
    }
  } catch (e) {
    ok("script error", false, String(e).slice(0, 800));
  } finally {
    for (const id of cleanupTxIds) {
      const t = await prisma.transaction.findUnique({ where: { id } });
      if (t && t.deletedAt === null && t.accountId) await applyBalances(prisma, t, -1);
    }
    await prisma.auditLog.deleteMany({ where: { entityId: { in: cleanupTxIds } } });
    await prisma.intent.deleteMany({ where: { entityId: { in: cleanupTxIds } } });
    await prisma.transaction.deleteMany({ where: { id: { in: cleanupTxIds } } });
    await prisma.groupMember.deleteMany({ where: { groupId: flat.id } });
    await prisma.participant.delete({ where: { id: bobParticipant.id } });
    await prisma.group.delete({ where: { id: flat.id } });
    await prisma.user.delete({ where: { id: bob.id } });
  }
}

main()
  .catch((e) => {
    ok("script error", false, String(e).slice(0, 800));
  })
  .finally(async () => {
    await prisma.$disconnect();
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  });
