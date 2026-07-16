// Offline-sync Phase 0 exit criterion (spec §17): replaying the same create
// intent twice yields exactly one transaction row and one balance effect,
// paise-exact. Exercises the REAL service (addExpense) against the dev DB —
// the same code path server actions call — then leaves the ledger untouched.
// Run: npx tsx scripts/offline-p0-replay.ts
import { randomUUID } from "node:crypto";
import { prisma } from "../src/server/db";
import { addExpense, softDeleteTransaction } from "../src/server/services/transactions";

const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

async function main() {
  const user = await prisma.user.findFirst({ where: { email: "arjun@ledgerly.app" } });
  if (!user) throw new Error("Demo user not found — run db:seed first");
  const account = await prisma.account.findFirst({ where: { userId: user.id, name: "HDFC Savings" } });
  if (!account) throw new Error("Demo account not found");

  const balanceBefore = (await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).balance;

  const intent = {
    intentId: randomUUID(),
    deviceId: "p0-replay-test-device",
    clientTs: new Date().toISOString(),
    entityId: randomUUID().replace(/-/g, "").slice(0, 24), // client-assigned tx id
  };
  const input = {
    amount: 12345, // paise — deliberately odd so a double-apply is unmistakable
    accountId: account.id,
    categoryId: null,
    merchant: "P0ReplayProbe",
    date: new Date().toISOString().slice(0, 10),
  };

  const id1 = await addExpense(user.id, input, intent);
  const id2 = await addExpense(user.id, input, intent); // exact replay — at-least-once delivery simulated

  ok("replay returns the original entity id (DUPLICATE → same outcome)", id1 === id2, `${id1} vs ${id2}`);
  ok("client-assigned entity id was honored", id1 === intent.entityId);

  const rows = await prisma.transaction.count({ where: { userId: user.id, merchant: "P0ReplayProbe", deletedAt: null } });
  ok("exactly one transaction row exists after two deliveries", rows === 1, `${rows} rows`);

  const balanceAfter = (await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).balance;
  ok(
    "balance moved exactly once, paise-exact",
    balanceAfter === balanceBefore - BigInt(12345),
    `${balanceBefore} -> ${balanceAfter} (expected −12345)`
  );

  const intentRow = await prisma.intent.findUnique({ where: { userId_id: { userId: user.id, id: intent.intentId } } });
  ok("intent row recorded as applied with the entity id", intentRow?.status === "applied" && intentRow?.entityId === id1);

  const auditRow = await prisma.auditLog.findFirst({
    where: { userId: user.id, entity: "Transaction", entityId: id1, action: "create" },
  });
  const sync = (auditRow?.after as { _sync?: { intentId?: string; deviceId?: string } } | null)?._sync;
  ok(
    "audit snapshot carries intentId + deviceId (bitemporal-lite, spec §4.2)",
    sync?.intentId === intent.intentId && sync?.deviceId === intent.deviceId
  );

  // a DIFFERENT intent may not reuse the same entity id — structural backstop
  let conflictRejected = false;
  try {
    await addExpense(user.id, input, { ...intent, intentId: randomUUID() });
  } catch {
    conflictRejected = true;
  }
  ok("a new intent reusing the same entity id is rejected, not double-applied", conflictRejected);

  // ── cleanup: reverse through the real service, then hard-delete the probes ──
  await softDeleteTransaction(user.id, id1);
  const balanceRestored = (await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).balance;
  ok("cleanup restores the balance paise-exact", balanceRestored === balanceBefore, `${balanceRestored} vs ${balanceBefore}`);
  await prisma.transaction.delete({ where: { id: id1 } });
  await prisma.intent.deleteMany({ where: { userId: user.id, deviceId: "p0-replay-test-device" } });
  await prisma.auditLog.deleteMany({ where: { userId: user.id, entityId: id1 } });
}

main()
  .catch((e) => {
    ok("script error", false, String(e).slice(0, 300));
  })
  .finally(async () => {
    await prisma.$disconnect();
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  });
