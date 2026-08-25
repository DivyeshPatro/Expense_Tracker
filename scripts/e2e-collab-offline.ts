// Collaboration Architecture RFC — Migration Step 5 (offline sync layer).
// Exercises the actor-aware checkOverride (§6.1/§6.2), the new CONFLICT
// taxonomy code and its Keep mine/Keep theirs resolution (§7), and the
// removed-member/group-deleted recovery paths (§8) — all through the real
// outbox + a real browser, with TWO real, independently-authenticated users
// (Alice = the seeded demo owner, Bob = a fresh MEMBER), the same hybrid
// technique e2e-offline-p3.ts already uses for solo two-device races, just
// with a genuinely different second actor instead of a second device of the
// same person.
//
// Run: npx tsx scripts/e2e-collab-offline.ts
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { auth } from "../src/server/auth";
import { prisma } from "../src/server/db";
import { createGroup, deleteGroup, removeGroupMember } from "../src/server/services/groups";

const BASE = "http://localhost:3000";
const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

async function sessionCookies(email: string, password: string) {
  // signInEmail called directly (not via HTTP) bypasses Better Auth's default
  // rate limiter — same reasoning as e2e-collab-ui.ts
  const result = (await auth.api.signInEmail({ body: { email, password }, returnHeaders: true })) as { headers: Headers };
  const setCookie = result.headers.getSetCookie ? result.headers.getSetCookie() : [];
  return setCookie.map((sc) => {
    const pair = sc.split(";")[0];
    const idx = pair.indexOf("=");
    return { name: pair.slice(0, idx), value: pair.slice(idx + 1), domain: "localhost", path: "/" };
  });
}

async function newDevice(browser: Browser, cookies: { name: string; value: string; domain: string; path: string }[]): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
  await page.getByText(/total balance|balance ·/i).filter({ visible: true }).first().waitFor();
  return { ctx, page };
}

async function openTxByDeepLink(page: Page, txId: string) {
  await page.goto(`${BASE}/transactions?tx=${txId}`, { waitUntil: "load" });
  await page
    .waitForFunction(
      () => {
        const body = document.body.textContent || "";
        return /\bEdit\b/.test(body) || /\bFix\b/.test(body) || body.includes("no longer exists") || body.includes("Discard");
      },
      { timeout: 10000 }
    )
    .catch(() => {});
  await page.waitForTimeout(300);
}

async function outboxSnapshot(page: Page): Promise<{ intentId: string; entityId: string; status: string; lastErrorCode?: string; conflict?: { serverActorName: string; amount: number; serverVersion: number } }[]> {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open("ledgerly");
        req.onsuccess = () => {
          const getAll = req.result.transaction("outbox", "readonly").objectStore("outbox").getAll();
          getAll.onsuccess = () => resolve(getAll.result);
        };
      })
  );
}

async function main() {
  const suffix = randomUUID().slice(0, 8);
  const PASSWORD = "LedgerlyTest#2026";

  const alice = await prisma.user.findFirstOrThrow({ where: { email: "arjun@ledgerly.app" } });
  const aliceAccount = await prisma.account.findFirstOrThrow({ where: { userId: alice.id } });
  const aliceCategory = await prisma.category.findFirstOrThrow({ where: { userId: alice.id, kind: "EXPENSE" } });

  await auth.api.signUpEmail({ body: { name: "BobOffline", email: `bob-off-${suffix}@test.local`, password: PASSWORD } });
  const bob = await prisma.user.findFirstOrThrow({ where: { email: `bob-off-${suffix}@test.local` } });

  const groupName = `OfflineFlat-${suffix}`;
  await createGroup(alice.id, groupName, []);
  const flat = await prisma.group.findFirstOrThrow({ where: { name: groupName, createdById: alice.id } });
  const bobParticipant = await prisma.participant.create({ data: { ownerId: alice.id, displayName: "BobOffline", linkedUserId: bob.id } });
  await prisma.groupMember.create({ data: { groupId: flat.id, participantId: bobParticipant.id, role: "MEMBER" } });

  const groupName2 = `OfflineFlat2-${suffix}`;
  await createGroup(alice.id, groupName2, []);
  const flat2 = await prisma.group.findFirstOrThrow({ where: { name: groupName2, createdById: alice.id } });
  const bobParticipant2 = await prisma.participant.create({ data: { ownerId: alice.id, displayName: "BobOffline2", linkedUserId: bob.id } });
  await prisma.groupMember.create({ data: { groupId: flat2.id, participantId: bobParticipant2.id, role: "MEMBER" } });

  const browser = await chromium.launch({ headless: true });

  const aliceBootstrap = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const aliceBootstrapPage = await aliceBootstrap.newPage();
  // Tolerate a cold `next dev` server, as e2e.mjs and e2e-tx-detail do:
  // submitting before React has hydrated fires a native form GET that never
  // reaches /dashboard. Without this the suite passes only on a warm server.
  let bootstrapped = false;
  for (let attempt = 0; attempt < 3 && !bootstrapped; attempt++) {
    await aliceBootstrapPage.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await aliceBootstrapPage.waitForSelector('button[type="submit"]', { timeout: 30000 });
    await aliceBootstrapPage.waitForTimeout(1500);
    await aliceBootstrapPage.fill('input[type="email"]', "arjun@ledgerly.app");
    await aliceBootstrapPage.fill('input[type="password"]', "ledgerly-demo");
    await aliceBootstrapPage.click('button[type="submit"]');
    try {
      await aliceBootstrapPage.waitForURL("**/dashboard", { timeout: 30000 });
      bootstrapped = true;
    } catch {
      /* retry */
    }
  }
  if (!bootstrapped) throw new Error("Could not sign in after 3 attempts (hydration race)");
  const aliceCookies = await aliceBootstrap.cookies();
  await aliceBootstrap.close();

  const bobCookies = await sessionCookies(`bob-off-${suffix}@test.local`, PASSWORD);

  const txIds: string[] = [];

  try {
    // ═══════════════════════ same actor, two devices, GROUP transaction → silent LWW unchanged ═══════════════════════
    {
      const tx = await prisma.transaction.create({
        data: { userId: alice.id, type: "EXPENSE", accountId: aliceAccount.id, categoryId: aliceCategory.id, amount: 10000, merchant: `OffSameActor-${suffix}`, occurredAt: new Date(), groupId: flat.id },
      });
      await prisma.account.update({ where: { id: aliceAccount.id }, data: { balance: { decrement: 10000 } } });
      txIds.push(tx.id);

      const { ctx: ctxB, page: pageB } = await newDevice(browser, aliceCookies);
      await openTxByDeepLink(pageB, tx.id); // captures version=1 into B's local state
      await ctxB.setOffline(true);
      await pageB.getByRole("button", { name: "Edit", exact: true }).click(); // Alice IS the owner — the original EditExpenseForm, unaffected by collaboration
      await pageB.waitForSelector('input[placeholder="0"]');
      await pageB.fill('input[placeholder="0"]', "999");
      await pageB.getByRole("button", { name: "Save changes", exact: true }).click();
      await pageB.waitForSelector("text=Save changes", { state: "detached" });

      const { ctx: ctxA, page: pageA } = await newDevice(browser, aliceCookies);
      await openTxByDeepLink(pageA, tx.id);
      await pageA.getByRole("button", { name: "Edit", exact: true }).click();
      await pageA.waitForSelector('input[placeholder="0"]');
      await pageA.fill('input[placeholder="0"]', "555");
      await pageA.getByRole("button", { name: "Save changes", exact: true }).click();
      await pageA.waitForSelector("text=Transaction updated");
      await pageA.waitForTimeout(800);

      await ctxB.setOffline(false);
      await pageB.waitForTimeout(2500);

      const final = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
      ok(
        "same real person (Alice), two devices, on a GROUP transaction — silent LWW is unchanged by groupId (rfc §6.2)",
        Number(final.amount) === 99900,
        `${final.amount}`
      );
      const aliceIntents = await prisma.intent.findMany({ where: { userId: alice.id, entityId: tx.id }, orderBy: { appliedAt: "asc" } });
      ok("device B's intent recorded as an override (OK_OVERRIDE), same as the pre-existing solo behavior", aliceIntents[1]?.status === "overridden", aliceIntents[1]?.status);

      await ctxA.close();
      await ctxB.close();
    }

    // ═══════════════════════ two different group members, version race → CONFLICT ═══════════════════════
    let conflictIntentId = "";
    {
      const tx = await prisma.transaction.create({
        data: { userId: alice.id, type: "EXPENSE", accountId: aliceAccount.id, categoryId: aliceCategory.id, amount: 20000, merchant: `OffConflict-${suffix}`, occurredAt: new Date(), groupId: flat.id },
      });
      await prisma.account.update({ where: { id: aliceAccount.id }, data: { balance: { decrement: 20000 } } });
      txIds.push(tx.id);

      const { ctx: ctxBob, page: pageBob } = await newDevice(browser, bobCookies);
      await openTxByDeepLink(pageBob, tx.id); // Bob (MEMBER) reads it fine — captures version=1
      await ctxBob.setOffline(true);
      await pageBob.getByRole("button", { name: "Edit", exact: true }).click(); // non-owner → CollaborativeEditForm
      await pageBob.waitForSelector('input[placeholder="0"]');
      await pageBob.fill('input[placeholder="0"]', "999");
      await pageBob.getByRole("button", { name: "Save changes", exact: true }).click();
      await pageBob.waitForSelector("text=Save changes", { state: "detached" }); // sheet closes on a successful (queued) save, offline or not

      const { ctx: ctxAlice, page: pageAlice } = await newDevice(browser, aliceCookies);
      await openTxByDeepLink(pageAlice, tx.id);
      await pageAlice.getByRole("button", { name: "Edit", exact: true }).click();
      await pageAlice.waitForSelector('input[placeholder="0"]');
      await pageAlice.fill('input[placeholder="0"]', "555");
      await pageAlice.getByRole("button", { name: "Save changes", exact: true }).click();
      await pageAlice.waitForSelector("text=Transaction updated");
      await pageAlice.waitForTimeout(800);
      await ctxAlice.close();

      await ctxBob.setOffline(false);
      await pageBob.waitForTimeout(2500);

      const afterAttempt = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
      ok(
        "a DIFFERENT authorized actor's conflicting edit does NOT apply — server state stays Alice's (rfc §6.2/§7)",
        Number(afterAttempt.amount) === 55500,
        `${afterAttempt.amount}`
      );

      const bobOutbox = await outboxSnapshot(pageBob);
      const parked = bobOutbox.find((i) => i.entityId === tx.id);
      conflictIntentId = parked?.intentId ?? "";
      ok("Bob's conflicting edit parks as needs-attention with code CONFLICT", parked?.status === "needs-attention" && parked?.lastErrorCode === "CONFLICT", JSON.stringify(parked?.conflict));
      ok(
        "the parked intent carries a conflict snapshot naming the real conflicting actor and the server's current amount",
        parked?.conflict?.serverActorName === "Arjun" && Number(parked?.conflict?.amount) === 55500,
        JSON.stringify(parked?.conflict)
      );

      const bobIntentRow = conflictIntentId ? await prisma.intent.findUnique({ where: { userId_id: { userId: bob.id, id: conflictIntentId } } }) : "no-intentId";
      ok("no Intent row exists for a parked CONFLICT — nothing was applied, exactly-once still holds", bobIntentRow === null, String(bobIntentRow));

      await openTxByDeepLink(pageBob, tx.id);
      const conflictBody = await pageBob.evaluate(() => document.body.innerText);
      ok(
        "the conflict card shows both versions with the RFC's exact framing copy",
        conflictBody.includes("changed while you were away") && conflictBody.includes("Arjun") && conflictBody.includes("Keep mine"),
        conflictBody.slice(0, 300)
      );

      await pageBob.goto(`${BASE}/settings/sync`, { waitUntil: "load" });
      // OfflineProvider reloads its outbox state from IndexedDB asynchronously
      // on mount — the very first paint after navigation still shows the
      // default "Everything is synced" until that reload() resolves
      await pageBob.waitForSelector("text=/needs? attention/i", { timeout: 5000 }).catch(() => {});
      const syncBody = await pageBob.evaluate(() => document.body.innerText);
      ok("Sync Center reflects the collaborative CONFLICT as needing attention (rfc validation #8)", /needs? attention/i.test(syncBody), syncBody.slice(0, 200));

      // ── Keep mine: requeues against the version that just conflicted ──
      await openTxByDeepLink(pageBob, tx.id);
      await pageBob.getByRole("button", { name: "Keep mine", exact: true }).click();
      await pageBob.waitForTimeout(2500);

      const afterKeepMine = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
      ok("[Keep mine] replays the SAME edit and it applies once nothing else has changed since", Number(afterKeepMine.amount) === 99900, `${afterKeepMine.amount}`);
      const bobOutboxAfterKeepMine = await outboxSnapshot(pageBob);
      ok("the resolved intent is gone from the outbox after Keep mine succeeds", !bobOutboxAfterKeepMine.some((i) => i.entityId === tx.id));

      await ctxBob.close();
    }

    // ═══════════════════════ Keep theirs discards locally, server unchanged ═══════════════════════
    {
      const tx = await prisma.transaction.create({
        data: { userId: alice.id, type: "EXPENSE", accountId: aliceAccount.id, categoryId: aliceCategory.id, amount: 12000, merchant: `OffKeepTheirs-${suffix}`, occurredAt: new Date(), groupId: flat.id },
      });
      await prisma.account.update({ where: { id: aliceAccount.id }, data: { balance: { decrement: 12000 } } });
      txIds.push(tx.id);

      const { ctx: ctxBob, page: pageBob } = await newDevice(browser, bobCookies);
      await openTxByDeepLink(pageBob, tx.id);
      await ctxBob.setOffline(true);
      await pageBob.getByRole("button", { name: "Edit", exact: true }).click();
      await pageBob.waitForSelector('input[placeholder="0"]');
      await pageBob.fill('input[placeholder="0"]', "700");
      await pageBob.getByRole("button", { name: "Save changes", exact: true }).click();
      await pageBob.waitForSelector("text=Save changes", { state: "detached" });

      const { ctx: ctxAlice, page: pageAlice } = await newDevice(browser, aliceCookies);
      await openTxByDeepLink(pageAlice, tx.id);
      await pageAlice.getByRole("button", { name: "Edit", exact: true }).click();
      await pageAlice.waitForSelector('input[placeholder="0"]');
      await pageAlice.fill('input[placeholder="0"]', "300");
      await pageAlice.getByRole("button", { name: "Save changes", exact: true }).click();
      await pageAlice.waitForSelector("text=Transaction updated");
      await pageAlice.waitForTimeout(800);
      await ctxAlice.close();

      await ctxBob.setOffline(false);
      await pageBob.waitForTimeout(2500);

      await openTxByDeepLink(pageBob, tx.id);
      const bodyBeforeResolve = await pageBob.evaluate(() => document.body.innerText);
      ok("a second, independent conflict also parks correctly", bodyBeforeResolve.includes("changed while you were away"));

      await pageBob.locator("button", { hasText: "Keep Arjun" }).click();
      await pageBob.waitForTimeout(1000);

      const afterKeepTheirs = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
      ok("[Keep theirs] leaves the server exactly as the other person left it", Number(afterKeepTheirs.amount) === 30000, `${afterKeepTheirs.amount}`);
      const bobOutboxAfter = await outboxSnapshot(pageBob);
      ok("[Keep theirs] discards the pending intent locally — no server call needed", !bobOutboxAfter.some((i) => i.entityId === tx.id));

      await ctxBob.close();
    }

    // ═══════════════════════ removed member cannot replay queued edits ═══════════════════════
    {
      const tx = await prisma.transaction.create({
        data: { userId: alice.id, type: "EXPENSE", accountId: aliceAccount.id, categoryId: aliceCategory.id, amount: 8000, merchant: `OffRemoved-${suffix}`, occurredAt: new Date(), groupId: flat.id },
      });
      await prisma.account.update({ where: { id: aliceAccount.id }, data: { balance: { decrement: 8000 } } });
      txIds.push(tx.id);

      const { ctx: ctxBob, page: pageBob } = await newDevice(browser, bobCookies);
      await openTxByDeepLink(pageBob, tx.id);
      await ctxBob.setOffline(true);
      await pageBob.getByRole("button", { name: "Edit", exact: true }).click();
      await pageBob.waitForSelector('input[placeholder="0"]');
      await pageBob.fill('input[placeholder="0"]', "42");
      await pageBob.getByRole("button", { name: "Save changes", exact: true }).click();
      await pageBob.waitForSelector("text=Save changes", { state: "detached" });

      // Alice removes Bob from the group while his edit is still queued offline
      await removeGroupMember(alice.id, flat.id, bobParticipant.id);

      await ctxBob.setOffline(false);
      await pageBob.waitForTimeout(2500);

      const unchanged = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
      ok("a removed member's queued edit never applies (rfc §8/validation #5)", Number(unchanged.amount) === 8000, `${unchanged.amount}`);

      // Bob's assertCanRead now fails identically for a fresh read — the ONLY
      // thing he can still see is his own queued intent's remembered data
      await openTxByDeepLink(pageBob, tx.id);
      const removedBody = await pageBob.evaluate(() => document.body.innerText);
      ok(
        "a removed member sees the specific 'no longer part of' recovery copy naming the group, not a generic read failure",
        removedBody.includes("no longer part of") && removedBody.includes(groupName),
        removedBody.slice(0, 300)
      );
      ok("no guided fix is offered — only Discard (rfc §8)", removedBody.includes("Discard") && !removedBody.includes("Keep as personal"));

      await pageBob.getByRole("button", { name: "Discard", exact: true }).click();
      await pageBob.waitForTimeout(500);
      const bobOutboxAfterDiscard = await outboxSnapshot(pageBob);
      ok("discarding a NOT_AUTHORIZED intent clears it from the outbox", !bobOutboxAfterDiscard.some((i) => i.entityId === tx.id));

      await ctxBob.close();
    }

    // ═══════════════════════ deleted group follows the approved recovery path ═══════════════════════
    {
      const tx = await prisma.transaction.create({
        data: { userId: alice.id, type: "EXPENSE", accountId: aliceAccount.id, categoryId: aliceCategory.id, amount: 15000, merchant: `OffGroupGone-${suffix}`, occurredAt: new Date(), groupId: flat2.id },
      });
      await prisma.account.update({ where: { id: aliceAccount.id }, data: { balance: { decrement: 15000 } } });
      txIds.push(tx.id);

      const { ctx: ctxBob, page: pageBob } = await newDevice(browser, bobCookies);
      await openTxByDeepLink(pageBob, tx.id); // Bob is still a member of flat2
      await ctxBob.setOffline(true);
      await pageBob.getByRole("button", { name: "Edit", exact: true }).click();
      await pageBob.waitForSelector('input[placeholder="0"]');
      await pageBob.fill('input[placeholder="0"]', "77");
      await pageBob.getByRole("button", { name: "Save changes", exact: true }).click();
      await pageBob.waitForSelector("text=Save changes", { state: "detached" });

      await deleteGroup(alice.id, flat2.id); // onDelete: SetNull orphans the row back to personal

      await ctxBob.setOffline(false);
      await pageBob.waitForTimeout(2500);

      const orphaned = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
      ok(
        "deleting the group orphans the transaction to personal (SetNull) and the queued edit does NOT apply",
        orphaned.groupId === null && Number(orphaned.amount) === 15000,
        `groupId=${orphaned.groupId}, amount=${orphaned.amount}`
      );

      await openTxByDeepLink(pageBob, tx.id);
      const groupGoneBody = await pageBob.evaluate(() => document.body.innerText);
      ok(
        "group-deleted recovery names the deleted group, offers Discard",
        groupGoneBody.includes("was deleted") && groupGoneBody.includes(groupName2) && groupGoneBody.includes("Discard"),
        groupGoneBody.slice(0, 300)
      );

      await pageBob.getByRole("button", { name: "Discard", exact: true }).click();
      await pageBob.waitForTimeout(500);
      const bobOutboxAfterDiscard = await outboxSnapshot(pageBob);
      ok("discarding a GROUP_DELETED intent clears it from the outbox", !bobOutboxAfterDiscard.some((i) => i.entityId === tx.id));

      await ctxBob.close();
    }
  } catch (e) {
    ok("script error", false, String(e).slice(0, 800));
  } finally {
    // ═══════════════════════ cleanup ═══════════════════════
    for (const id of txIds) {
      const t = await prisma.transaction.findUnique({ where: { id } });
      if (t && t.deletedAt === null && t.accountId) {
        await prisma.account.update({ where: { id: t.accountId }, data: { balance: { increment: t.amount } } });
      }
    }
    await prisma.expenseSplit.deleteMany({ where: { txId: { in: txIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: txIds } } });
    await prisma.intent.deleteMany({ where: { entityId: { in: txIds } } });
    await prisma.transaction.deleteMany({ where: { id: { in: txIds } } });
    await prisma.groupMember.deleteMany({ where: { groupId: flat.id } });
    await prisma.participant.deleteMany({ where: { id: { in: [bobParticipant.id, bobParticipant2.id] } } });
    await prisma.group.deleteMany({ where: { id: { in: [flat.id] } } }); // flat2 already deleted by the test itself
    await prisma.user.delete({ where: { id: bob.id } });
    await browser.close();
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
