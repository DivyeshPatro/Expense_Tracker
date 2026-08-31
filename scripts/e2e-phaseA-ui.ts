// Production audit Phase A — UI-level proof for blockers #2 (Intent
// completeness) and #3 (actorUserId display). Blocker #1 (TOCTOU) is proven
// in e2e-toctou-race.ts, which needs no browser. Reuses the real-two-user
// technique already established in e2e-collab-ui.ts/e2e-collab-offline.ts.
//
// Run: npx tsx scripts/e2e-phaseA-ui.ts
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { auth } from "../src/server/auth";
import { prisma } from "../src/server/db";
import { createGroup } from "../src/server/services/groups";

const BASE = "http://localhost:3000";
const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

async function sessionCookies(email: string, password: string) {
  const result = (await auth.api.signInEmail({ body: { email, password }, returnHeaders: true })) as { headers: Headers };
  const setCookie = result.headers.getSetCookie ? result.headers.getSetCookie() : [];
  return setCookie.map((sc) => {
    const pair = sc.split(";")[0];
    const idx = pair.indexOf("=");
    return { name: pair.slice(0, idx), value: pair.slice(idx + 1), domain: "localhost", path: "/" };
  });
}

async function newSession(browser: Browser, cookies: { name: string; value: string; domain: string; path: string }[]): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
  // Exact: a loose `text=` also matches the mobile hero's "Total balance".
  await page.getByText("TOTAL BALANCE", { exact: true }).waitFor({ timeout: 20000 });
  return { ctx, page };
}

// Alice owns these transactions, so her create and edit both open the
// full-screen composer. Bob does not, so his edit still opens the classic
// CollaborativeEditForm — which is the path §PhaseA.2 is actually about.
const composer = (page: Page) => page.locator("div[data-composer]");
const topSheet = (page: Page) => page.getByRole("dialog").last();

async function typeAmount(page: Page, amount: string) {
  await composer(page).waitFor({ timeout: 20000 });
  await composer(page).getByRole("button", { name: "Clear amount" }).click();
  for (const ch of amount) {
    await composer(page).getByRole("button", { name: ch, exact: true }).click();
    await page.waitForTimeout(50);
  }
}

async function setMerchant(page: Page, merchant: string) {
  await composer(page).getByRole("button", { name: "Merchant and notes" }).click();
  await page.waitForTimeout(400);
  await topSheet(page).locator("input").first().fill(merchant);
  await topSheet(page).getByRole("button", { name: "Done", exact: true }).click();
  await page.waitForTimeout(350);
}

async function sheetDone(page: Page) {
  const done = topSheet(page).getByRole("button", { name: "Done", exact: true });
  if (await done.count()) {
    await done.click();
    await page.waitForTimeout(350);
  }
}

/** Drag the confirm handle the whole way — the composer has no Save button. */
async function saveComposer(page: Page, { expectClose = true }: { expectClose?: boolean } = {}) {
  await sheetDone(page);
  const track = composer(page).locator("div[role='slider']");
  const box = (await track.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 30, y);
  await page.mouse.down();
  const end = box.x + 30 + (box.width - 62);
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(box.x + 30 + ((end - box.x - 30) * i) / 12, y);
    await page.waitForTimeout(18);
  }
  await page.mouse.up();
  if (expectClose) await composer(page).waitFor({ state: "detached", timeout: 20000 });
  await page.waitForTimeout(500);
}

/** Choose a group via the composer's Personal|Group control. */
async function selectComposerGroup(page: Page, groupName: string) {
  await composer(page).getByRole("group", { name: "Personal or group" }).getByRole("button").last().click();
  await page.waitForTimeout(600);
  await topSheet(page).getByRole("button", { name: new RegExp(groupName) }).first().click();
  await page.waitForTimeout(700);
  await sheetDone(page);
}


async function openTxByDeepLink(page: Page, txId: string) {
  await page.goto(`${BASE}/transactions?tx=${txId}`, { waitUntil: "load" });
  await page
    .waitForFunction(
      () => {
        const body = document.body.textContent || "";
        return /\bEdit\b/.test(body) || /\bFix\b/.test(body) || body.includes("no longer exists");
      },
      { timeout: 10000 }
    )
    .catch(() => {});
  await page.waitForTimeout(300);
}

async function main() {
  const suffix = randomUUID().slice(0, 8);
  const PASSWORD = "LedgerlyTest#2026";

  const alice = await prisma.user.findFirstOrThrow({ where: { email: "arjun@ledgerly.app" } });

  await auth.api.signUpEmail({ body: { name: "PhaseABob", email: `phasea-bob-${suffix}@test.local`, password: PASSWORD } });
  const bob = await prisma.user.findFirstOrThrow({ where: { email: `phasea-bob-${suffix}@test.local` } });

  const groupName = `PhaseAFlat-${suffix}`;
  await createGroup(alice.id, groupName, []);
  const flat = await prisma.group.findFirstOrThrow({ where: { name: groupName, createdById: alice.id } });
  const bobParticipant = await prisma.participant.create({ data: { ownerId: alice.id, displayName: "PhaseABob", linkedUserId: bob.id } });
  await prisma.groupMember.create({ data: { groupId: flat.id, participantId: bobParticipant.id, role: "MEMBER" } });

  const browser = await chromium.launch({ headless: true });

  const aliceBootstrap = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const aliceBootstrapPage = await aliceBootstrap.newPage();
  await aliceBootstrapPage.goto(`${BASE}/sign-in`, { waitUntil: "load" });
  await aliceBootstrapPage.fill('input[type="email"]', "arjun@ledgerly.app");
  await aliceBootstrapPage.fill('input[type="password"]', "ledgerly-demo");
  await aliceBootstrapPage.click('button[type="submit"]');
  await aliceBootstrapPage.waitForURL("**/dashboard", { timeout: 20000 });
  const aliceCookies = await aliceBootstrap.cookies();
  await aliceBootstrap.close();

  const bobCookies = await sessionCookies(`phasea-bob-${suffix}@test.local`, PASSWORD);

  const txIds: string[] = [];

  try {
    const { page: alicePage } = await newSession(browser, aliceCookies);
    const { page: bobPage } = await newSession(browser, bobCookies);

    // ═══════════════════════ §PhaseA.2: a split CREATE now carries a real intent ═══════════════════════
    await alicePage.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await alicePage.click('button:has-text("＋ Add expense")');
    await typeAmount(alicePage, "600");
    await setMerchant(alicePage, `PhaseASplit-${suffix}`);
    // People first, then the group: choosing the group narrows the picker to
    // its own roster, and Karan is not a member of it.
    await alicePage
      .locator("div[data-composer]")
      .getByRole("button", { name: /people ·|Choose who's splitting|Split with someone/ })
      .click();
    await alicePage.waitForTimeout(600);
    const aliceSplitSheet = topSheet(alicePage);
    if ((await aliceSplitSheet.locator('[role="switch"]').first().getAttribute("aria-checked")) !== "true") {
      await aliceSplitSheet.getByText("👥 Split with friends").first().click();
      await alicePage.waitForTimeout(300);
    }
    await alicePage.waitForSelector("text=Karan");
    for (const b of await aliceSplitSheet.locator('button[aria-pressed="true"]').all()) {
      if (!(await b.innerText()).includes("Karan")) await b.click();
      await alicePage.waitForTimeout(100);
    }
    const karanRow = aliceSplitSheet.locator("button").filter({ hasText: "Karan" }).first();
    if ((await karanRow.getAttribute("aria-pressed")) !== "true") await karanRow.click();
    await alicePage.waitForTimeout(300);
    await sheetDone(alicePage);
    await selectComposerGroup(alicePage, groupName);
    await saveComposer(alicePage);

    const splitTx = await prisma.transaction.findFirstOrThrow({ where: { merchant: `PhaseASplit-${suffix}` } });
    txIds.push(splitTx.id);
    const createIntent = await prisma.intent.findFirst({ where: { entityId: splitTx.id, kind: "expense.create" } });
    ok(
      "a split-expense CREATE now creates a real Intent row (used to carry no intent at all)",
      !!createIntent && createIntent.userId === alice.id,
      createIntent ? `kind=${createIntent.kind}, userId=${createIntent.userId}` : "no Intent row found"
    );

    // ═══════════════════════ §PhaseA.2: split-edit intent completeness closes a real silent-overwrite bug ═══════════════════════
    // Alice opens the split transaction's edit form NOW (captures version=1
    // into her form's local state) but does not save yet.
    await openTxByDeepLink(alicePage, splitTx.id);
    await alicePage.getByRole("button", { name: "Edit", exact: true }).click();
    // The owner's edit is the composer, which captures version=1 into its own
    // state exactly as the classic form did.
    await composer(alicePage).waitFor({ timeout: 20000 });

    // Bob (a different real actor) edits the SAME transaction and saves —
    // server version 1 -> 2. This uses the ALREADY-intent-tracked
    // CollaborativeEditForm path (unaffected by this phase's fix).
    await openTxByDeepLink(bobPage, splitTx.id);
    await bobPage.getByRole("button", { name: "Edit", exact: true }).click();
    await bobPage.waitForSelector('input[placeholder="e.g. Swiggy"]');
    await bobPage.fill('input[placeholder="e.g. Swiggy"]', `PhaseASplit-${suffix}-bob`);
    await bobPage.getByRole("button", { name: "Save changes", exact: true }).click();
    await bobPage.waitForSelector("text=Transaction updated", { timeout: 8000 });
    await bobPage.waitForTimeout(600);

    const intentCountBeforeAlice = await prisma.intent.count({ where: { entityId: splitTx.id } });

    // Alice now saves from her STALE-opened form (still believes version=1).
    // Before this fix, her split-edit carried no intent/baseVersion at all
    // and would have applied BLINDLY, silently discarding Bob's edit with no
    // signal to either person.
    await setMerchant(alicePage, `PhaseASplit-${suffix}-alice-stale`);
    // Expected to be REFUSED — that is the assertion below — so the composer
    // stays up and reports the conflict rather than closing.
    await saveComposer(alicePage, { expectClose: false });
    await alicePage.waitForTimeout(1000);

    const aliceErrorBody = await alicePage.evaluate(() => document.body.innerText);
    ok(
      "Alice's stale split-edit against a different actor's newer edit is REJECTED with an honest message (not a silent overwrite)",
      aliceErrorBody.includes("changed while you were away") && aliceErrorBody.includes("Bob"),
      aliceErrorBody.slice(0, 300)
    );

    const afterConflict = await prisma.transaction.findUniqueOrThrow({ where: { id: splitTx.id } });
    ok(
      "the server still reflects Bob's edit — Alice's stale write never applied (this is the bug that used to exist)",
      afterConflict.merchant === `PhaseASplit-${suffix}-bob`,
      afterConflict.merchant
    );

    const intentCountAfterAlice = await prisma.intent.count({ where: { entityId: splitTx.id } });
    ok(
      "Alice's rejected attempt created no new Intent row (the whole transaction rolled back)",
      intentCountAfterAlice === intentCountBeforeAlice,
      `before=${intentCountBeforeAlice}, after=${intentCountAfterAlice}`
    );

    // ═══════════════════════ §PhaseA.3: actorUserId now displays in the Activity Timeline ═══════════════════════
    // Alice's sheet is still sitting in the edit form (the failed save above
    // doesn't close it) — Cancel back to the read view, which remounts
    // HistoryCard (it's only rendered outside `editing`) with a fresh fetch,
    // no page navigation required.
    await alicePage.getByRole("button", { name: "Cancel", exact: true }).click();
    await alicePage.getByRole("button", { name: "Edit", exact: true }).waitFor();
    await alicePage.waitForTimeout(600);
    const historyBody = await alicePage.evaluate(() => document.body.innerText);
    ok(
      "the History card attributes Bob's edit to him by name (rfc §5 — previously captured but never displayed)",
      /history/i.test(historyBody) && historyBody.includes("PhaseABob"),
      historyBody.slice(0, 400)
    );
    await alicePage.keyboard.press("Escape").catch(() => {});
    await alicePage.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {}); // dismiss the modal via backdrop, back to a known state

    // Alice's own solo edit, for contrast, should show no attribution at all
    await alicePage.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await alicePage.click('button:has-text("＋ Add expense")');
    await typeAmount(alicePage, "120");
    await setMerchant(alicePage, `PhaseASolo-${suffix}`);
    await saveComposer(alicePage);
    await alicePage.waitForTimeout(800);
    const soloTx = await prisma.transaction.findFirstOrThrow({ where: { merchant: `PhaseASolo-${suffix}` } });
    txIds.push(soloTx.id);

    // edit it directly via deep link (proven robust above) instead of a list
    // click + text-match, which raced the background outbox drain's refresh
    await openTxByDeepLink(alicePage, soloTx.id);
    await alicePage.getByRole("button", { name: "Edit", exact: true }).click();
    await composer(alicePage).waitFor({ timeout: 20000 });
    await setMerchant(alicePage, `PhaseASolo-${suffix}-edited`);
    await saveComposer(alicePage);
    await alicePage.waitForSelector("text=Transaction updated", { timeout: 8000 });
    await alicePage.waitForTimeout(800);

    await openTxByDeepLink(alicePage, soloTx.id);
    await alicePage.waitForTimeout(500);
    const soloHistoryBody = await alicePage.evaluate(() => document.body.innerText);
    ok(
      "Alice's own solo edit shows no actor attribution (only cross-actor edits are labeled)",
      /history/i.test(soloHistoryBody) && !soloHistoryBody.includes("PhaseABob"),
      soloHistoryBody.slice(0, 300)
    );
  } catch (e) {
    ok("script error", false, String(e).slice(0, 800));
  } finally {
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
    await prisma.participant.delete({ where: { id: bobParticipant.id } });
    await prisma.group.delete({ where: { id: flat.id } });
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
