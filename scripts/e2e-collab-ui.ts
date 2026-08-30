// Collaboration Architecture RFC — Migration Step 4 (UI cutover). Exercises
// the actual browser UI added this phase: TransactionDetailSheet's
// collaboration-aware read view + CollaborativeEditForm, and the group-aware
// create flow. Authorization *logic* itself (assertCanRead/assertCanWrite,
// role gating, cross-tenant leakage) is already covered exhaustively at the
// service layer by e2e-collab-foundation.ts (RFC §15) — this suite instead
// proves the NEW UI code renders the right thing for the right role and
// never exposes a control the viewer can't actually use.
//
// Reachability note: as of this phase there is deliberately no product
// surface (list/dashboard/notification) that lets a non-owner discover
// another member's group transaction — that's an out-of-scope product
// decision, not an oversight (see the Step 4 report). This script reaches
// the detail sheet the same way the product itself will need to eventually:
// a `?tx=<id>` deep link on the transactions page (tx-list.tsx), added
// specifically as test-facing plumbing, not a browsing feature — it opens
// exactly the same detail sheet a real click would, and getTransactionDetail
// still no-ops to "no longer exists" for anyone unauthorized to read it.
//
// Run: npx tsx scripts/e2e-collab-ui.ts
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { auth } from "../src/server/auth";
import { prisma } from "../src/server/db";
import { changeGroupMemberRole, createGroup } from "../src/server/services/groups";
import { applyBalances } from "../src/server/services/transactions";

const BASE = "http://localhost:3000";
const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

async function sessionCookies(email: string, password: string) {
  // signInEmail called directly (not via HTTP) bypasses Better Auth's default
  // /api/auth/sign-in rate limiter — this script needs three independent
  // real sessions in one run, and Alice's is the only one that goes through
  // the actual form (see bootstrapAlice below).
  const result = (await auth.api.signInEmail({
    body: { email, password },
    returnHeaders: true,
  })) as { headers: Headers };
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
  await page.getByText(/total balance|balance ·/i).filter({ visible: true }).first().waitFor();
  return { ctx, page };
}

/** Scans every <select> on the page for the one that actually lists
 * `optionText` — Field doesn't bind its label to the <select> via for/id, so
 * this is the only reliable way to find the right one (borrowed from
 * e2e-offline-p3.ts, same reasoning). */
async function selectByOptionText(page: Page, optionText: string): Promise<boolean> {
  const selects = page.locator("select");
  const count = await selects.count();
  for (let i = 0; i < count; i++) {
    const opts = await selects.nth(i).locator("option").allTextContents();
    const match = opts.find((o) => o.includes(optionText));
    if (match) {
      // force: the modal's sticky action bar overlays the centre of these
      // controls, so Playwright's actionability check never passes even though
      // the select is visible and enabled. Selecting an option on a native
      // <select> sets the value and fires change without a pointer event, so
      // this drives the same code path a user does. (A forced CLICK would not
      // be safe — it still dispatches at the coordinate and hits the bar.)
      await selects.nth(i).selectOption({ label: match }, { force: true });
      return true;
    }
  }
  return false;
}

async function openTxByDeepLink(page: Page, txId: string) {
  await page.goto(`${BASE}/transactions?tx=${txId}`, { waitUntil: "load" });
  // either the detail sheet loaded (Edit/Fix visible) or the authorization
  // no-op message appeared — wait for whichever shows up first
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

/**
 * The transaction a create flow just wrote.
 *
 * The toast fires when the server action returns, but the row is committed and
 * revalidated a moment later — a fixed sleep before querying is a race, and on
 * a loaded machine 500ms loses it. Poll for the row instead.
 */
async function txByMerchant(merchant: string) {
  // 15s, not 6: the first create through a given route on a cold `next dev`
  // pays that route's compile before the write lands, and this suite drives
  // three separate sessions so it hits several cold routes in a row.
  for (let i = 0; i < 50; i++) {
    const tx = await prisma.transaction.findFirst({ where: { merchant } });
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`No transaction was written for "${merchant}" after 15s`);
}

/** A transaction once it reaches the state the test is waiting for. Same race
 *  as txByMerchant: the toast fires before the write is visible to a fresh
 *  query. */
async function txWhen(id: string, ready: (tx: { merchant: string | null }) => boolean) {
  for (let i = 0; i < 50; i++) {
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id } });
    if (ready(tx)) return tx;
    await new Promise((r) => setTimeout(r, 300));
  }
  return prisma.transaction.findUniqueOrThrow({ where: { id } });
}

async function modalText(page: Page): Promise<string> {
  const panel = page.locator(".fixed.inset-0.z-\\[60\\]").first();
  return (await panel.textContent()) ?? "";
}

async function main() {
  const suffix = randomUUID().slice(0, 8);
  const PASSWORD = "LedgerlyTest#2026";

  const alice = await prisma.user.findFirstOrThrow({ where: { email: "arjun@ledgerly.app" } });

  await auth.api.signUpEmail({ body: { name: "BobUI", email: `bob-ui-${suffix}@test.local`, password: PASSWORD } });
  const bob = await prisma.user.findFirstOrThrow({ where: { email: `bob-ui-${suffix}@test.local` } });
  await auth.api.signUpEmail({ body: { name: "CarolUI", email: `carol-ui-${suffix}@test.local`, password: PASSWORD } });
  const carol = await prisma.user.findFirstOrThrow({ where: { email: `carol-ui-${suffix}@test.local` } });

  const groupName = `UITestFlat-${suffix}`;
  await createGroup(alice.id, groupName, []);
  const flat = await prisma.group.findFirstOrThrow({ where: { name: groupName, createdById: alice.id } });
  const bobParticipant = await prisma.participant.create({ data: { ownerId: alice.id, displayName: "BobUI", linkedUserId: bob.id } });
  await prisma.groupMember.create({ data: { groupId: flat.id, participantId: bobParticipant.id, role: "MEMBER" } });

  const browser = await chromium.launch({ headless: true });

  // one real form sign-in (Alice, the seeded demo account) — Bob/Carol use
  // signInEmail directly instead, see sessionCookies() above
  const aliceCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const alicePage = await aliceCtx.newPage();
  alicePage.setDefaultTimeout(30000);
  // Tolerate a cold `next dev` server, the same way e2e.mjs and e2e-tx-detail
  // already do: submitting before React has hydrated fires a native form GET
  // that never reaches /dashboard, and the first authenticated render has to
  // compile the route before it can answer. Without this the suite passes only
  // on a warm server, which is no baseline at all.
  let aliceIn = false;
  for (let attempt = 0; attempt < 3 && !aliceIn; attempt++) {
    await alicePage.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await alicePage.waitForSelector('button[type="submit"]', { timeout: 30000 });
    await alicePage.waitForTimeout(1500);
    await alicePage.fill('input[type="email"]', "arjun@ledgerly.app");
    await alicePage.fill('input[type="password"]', "ledgerly-demo");
    await alicePage.click('button[type="submit"]');
    try {
      await alicePage.waitForURL("**/dashboard", { timeout: 30000 });
      aliceIn = true;
    } catch {
      /* retry */
    }
  }
  if (!aliceIn) throw new Error("Could not sign in after 3 attempts (hydration race)");
  await alicePage.getByText(/total balance|balance ·/i).filter({ visible: true }).first().waitFor();

  const { page: bobPage } = await newSession(browser, await sessionCookies(`bob-ui-${suffix}@test.local`, PASSWORD));
  const { page: carolPage } = await newSession(browser, await sessionCookies(`carol-ui-${suffix}@test.local`, PASSWORD));

  const txIds: string[] = [];
  const cleanupUsers = [bob.id, carol.id];

  try {
    // ═══════════════════════ group-aware create flow ═══════════════════════

    // Alice (OWNER) creates a group expense through the real Add Expense form
    await alicePage.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await alicePage.click('button:has-text("＋ Add expense")');
    await alicePage.waitForSelector('input[placeholder="e.g. Swiggy"]');
    await alicePage.fill('input[placeholder="0"]', "800");
    await alicePage.fill('input[placeholder="e.g. Swiggy"]', `UIGroupRent-${suffix}`);
    const aliceSawGroupField = await selectByOptionText(alicePage, groupName);
    ok("Alice's Add Expense form shows the GROUP field once she belongs to a group", aliceSawGroupField);
    await alicePage.getByRole("button", { name: "Add expense", exact: true }).click();
    await alicePage.waitForSelector("text=Expense added");
    await alicePage.waitForTimeout(500);
    const rentTx = await txByMerchant(`UIGroupRent-${suffix}`);
    txIds.push(rentTx.id);
    ok(
      "a group-tagged create through the UI lands with the right groupId and stays filed under the creator's own userId (rfc §1)",
      rentTx.groupId === flat.id && rentTx.userId === alice.id
    );

    // Bob (MEMBER) creates his OWN transaction tagged with the same group —
    // positive path: "Group create works for authorized members"
    await bobPage.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await bobPage.click('button:has-text("＋ Add expense")');
    await bobPage.waitForSelector('input[placeholder="e.g. Swiggy"]');
    await bobPage.fill('input[placeholder="0"]', "300");
    await bobPage.fill('input[placeholder="e.g. Swiggy"]', `UIBobOwn-${suffix}`);
    const bobSawGroupField = await selectByOptionText(bobPage, groupName);
    ok("a MEMBER's own Add Expense form also shows the shared group (not just the owner's)", bobSawGroupField);
    await bobPage.getByRole("button", { name: "Add expense", exact: true }).click();
    await bobPage.waitForSelector("text=Expense added");
    await bobPage.waitForTimeout(500);
    const bobTx = await txByMerchant(`UIBobOwn-${suffix}`);
    txIds.push(bobTx.id);
    ok(
      "a MEMBER can create a transaction in the group through the real create flow, filed under their own userId",
      bobTx.groupId === flat.id && bobTx.userId === bob.id
    );

    // Alice creates a split group expense (with Karan) — used below to prove
    // the amount lock + split-preservation design decision (S4.4)
    await alicePage.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await alicePage.click('button:has-text("＋ Add expense")');
    await alicePage.waitForSelector('input[placeholder="e.g. Swiggy"]');
    await alicePage.fill('input[placeholder="0"]', "600");
    await alicePage.fill('input[placeholder="e.g. Swiggy"]', `UIGroupSplit-${suffix}`);
    // A role="switch" that the dialog's sticky action bar overlays.
    // dispatchEvent, not force: a forced click still fires at the coordinate,
    // so it lands on the bar and closes the modal instead of toggling the
    // switch. Dispatching on the element drives the same handler.
    await alicePage.locator('[role="switch"]').filter({ hasText: "Split with friends" }).first().dispatchEvent("click");
    await alicePage.waitForSelector("text=Karan");
    // scoped to the open modal — the transactions list behind it can already
    // have plenty of unrelated historical rows whose aria-label also mentions
    // "Karan" (e.g. "...paid by Karan..."), which an unscoped locator matches first
    // The picker sits below the fold in a tall dialog, so it must be scrolled
    // to first, and the sticky action bar covers this part of the form — hence
    // dispatchEvent rather than click.
    const karanChip = alicePage.locator(".fixed.inset-0.z-\\[60\\] button", { hasText: "Karan" }).first();
    await karanChip.scrollIntoViewIfNeeded();
    await karanChip.dispatchEvent("click");
    await selectByOptionText(alicePage, groupName);
    await alicePage.getByRole("button", { name: "Add expense", exact: true }).click();
    await alicePage.waitForSelector("text=Split expense added");
    await alicePage.waitForTimeout(500);
    const splitTx = await txByMerchant(`UIGroupSplit-${suffix}`);
    txIds.push(splitTx.id);

    // ═══════════════════════ MEMBER capabilities (rfc §3) ═══════════════════════

    await openTxByDeepLink(bobPage, rentTx.id);
    const bobReadBody = await modalText(bobPage);
    ok(
      "a MEMBER opening another member's group transaction sees the group context banner with the owner's name and their own role",
      bobReadBody.includes(groupName) && bobReadBody.includes("recorded by Arjun") && bobReadBody.includes("MEMBER")
    );
    ok(
      "accountId is shown but never as a functional control for a non-owner (no <select> anywhere in the read view)",
      (await bobPage.locator(".fixed.inset-0.z-\\[60\\] select").count()) === 0
    );
    ok("a MEMBER sees an active Edit control on another member's transaction", await bobPage.getByRole("button", { name: "Edit", exact: true }).isVisible());
    const bobSeesDisabledDelete = await bobPage.getByRole("button", { name: "Delete · admins only" }).isVisible();
    const bobSeesActiveDelete = await bobPage.getByRole("button", { name: "Delete", exact: true }).isVisible().catch(() => false);
    ok("a plain MEMBER never sees a functioning Delete control on someone else's transaction — only the explained disabled state", bobSeesDisabledDelete && !bobSeesActiveDelete);

    await bobPage.getByRole("button", { name: "Edit", exact: true }).click();
    await bobPage.waitForSelector('input[placeholder="0"]');
    const editSelectCount = await bobPage.locator(".fixed.inset-0.z-\\[60\\] select").count();
    ok(
      "the non-owner edit form renders accountId as locked read-only text, never a live picker (rfc §1)",
      editSelectCount === 1 // exactly one live <select>: the group-scoped CATEGORY picker
    );
    const editBodyBeforeSave = await modalText(bobPage);
    ok("the non-owner edit form explains why the account is locked", editBodyBeforeSave.includes("locked"));
    await bobPage.fill('input[placeholder="e.g. Swiggy"]', `UIGroupRent-${suffix}-edited`);
    await bobPage.getByRole("button", { name: "Save changes", exact: true }).click();
    await bobPage.waitForSelector("text=Transaction updated", { timeout: 8000 });
    await bobPage.waitForTimeout(600);

    const afterBobEdit = await txWhen(rentTx.id, (t) => t.merchant === `UIGroupRent-${suffix}-edited`);
    ok(
      "a MEMBER's edit persists through the real server authorization path, without touching accountId or reassigning ownership",
      afterBobEdit.merchant === `UIGroupRent-${suffix}-edited` && afterBobEdit.accountId === rentTx.accountId && afterBobEdit.userId === alice.id
    );
    let bobEditAudit = null as Awaited<ReturnType<typeof prisma.auditLog.findFirst>>;
    for (let i = 0; i < 50 && !bobEditAudit; i++) {
      bobEditAudit = await prisma.auditLog.findFirst({ where: { entityId: rentTx.id, action: "update" }, orderBy: { at: "desc" } });
      if (!bobEditAudit) await new Promise((r) => setTimeout(r, 300));
    }
    ok("the audit row for a cross-member edit is filed under the owner's ledger but attributes the real actor (rfc §5)", bobEditAudit?.userId === alice.id && bobEditAudit?.actorUserId === bob.id);

    ok(
      "a collaborative (cross-person) edit goes direct — it never enters the offline outbox or shows the queued/waiting banner",
      !(await bobPage.locator("text=Waiting to sync").isVisible().catch(() => false))
    );

    // History card should now show entries — proves the entityHistory fix
    // (rfc §5's OR-extension), not the pre-fix empty-for-non-owner state
    await openTxByDeepLink(bobPage, rentTx.id);
    await bobPage.waitForTimeout(500);
    const bobHistoryBody = await modalText(bobPage);
    ok("a non-owner sees the transaction's full History (rfc §5's OR-extension), not a silently empty card", bobHistoryBody.includes("History") && bobHistoryBody.includes("edited"));

    // ═══════════════════════ split-transaction amount lock (S4.4) ═══════════════════════

    await openTxByDeepLink(bobPage, splitTx.id);
    await bobPage.getByRole("button", { name: "Edit", exact: true }).click();
    await bobPage.waitForSelector('input[placeholder="0"]');
    const amountLocked = await bobPage.locator('input[placeholder="0"]').first().isDisabled();
    ok("the amount field locks in the non-owner edit form whenever the transaction has an existing split", amountLocked);
    const lockNoteVisible = (await modalText(bobPage)).includes("split with friends");
    ok("the locked amount explains why", lockNoteVisible);
    await bobPage.fill('input[placeholder="e.g. Swiggy"]', `UIGroupSplit-${suffix}-edited`);
    await bobPage.getByRole("button", { name: "Save changes", exact: true }).click();
    await bobPage.waitForSelector("text=Transaction updated", { timeout: 8000 });
    await bobPage.waitForTimeout(500);
    const afterSplitEdit = await prisma.transaction.findUniqueOrThrow({ where: { id: splitTx.id }, include: { splits: true } });
    const karanShare = afterSplitEdit.splits.find((s) => s.participantId !== null);
    ok(
      "a non-owner's edit of a split transaction preserves the amount and the existing split shares byte-for-byte",
      Number(afterSplitEdit.amount) === 60000 && !!karanShare && Number(karanShare.owedAmount) === 30000 && afterSplitEdit.merchant === `UIGroupSplit-${suffix}-edited`
    );

    // ═══════════════════════ ADMIN capabilities (rfc §3) ═══════════════════════

    await changeGroupMemberRole(alice.id, flat.id, bobParticipant.id, "ADMIN");
    await openTxByDeepLink(bobPage, rentTx.id);
    ok("promoting a MEMBER to ADMIN turns the disabled Delete control into a real one on the next load", await bobPage.getByRole("button", { name: "Delete", exact: true }).isVisible());
    await bobPage.getByRole("button", { name: "Delete", exact: true }).click();
    await bobPage.waitForSelector("text=Delete this transaction?");
    await bobPage.getByRole("button", { name: "Delete", exact: true }).click();
    await bobPage.waitForSelector("text=Transaction deleted", { timeout: 8000 });
    // migration step 5: this delete now queues through the same outbox as
    // every other collaborative write — the toast fires on the (near-instant)
    // local enqueue, not the server drain, so give the background drain a
    // moment before asserting server state
    await bobPage.waitForTimeout(1200);
    const afterAdminDelete = await prisma.transaction.findUniqueOrThrow({ where: { id: rentTx.id } });
    ok("an ADMIN can delete a transaction created by a different member, through the real UI", afterAdminDelete.deletedAt !== null);

    // ═══════════════════════ OWNER capabilities (rfc §3) ═══════════════════════

    await openTxByDeepLink(alicePage, bobTx.id);
    const ownerOnBobsTx = await modalText(alicePage);
    ok(
      "the group OWNER viewing a transaction she doesn't personally own also gets the collaborative (non-owner) view — accountId lock applies to her too (rfc §2)",
      (await alicePage.locator(".fixed.inset-0.z-\\[60\\] select").count()) === 0
    );
    ok("the OWNER sees an active Delete control on another member's transaction (OWNER ≥ ADMIN tier)", await alicePage.getByRole("button", { name: "Delete", exact: true }).isVisible());
    await alicePage.getByRole("button", { name: "Delete", exact: true }).click();
    await alicePage.waitForSelector("text=Delete this transaction?");
    await alicePage.getByRole("button", { name: "Delete", exact: true }).click();
    await alicePage.waitForSelector("text=Transaction deleted", { timeout: 8000 });
    await alicePage.waitForTimeout(1200); // migration step 5: queued through the outbox — see the ADMIN check above
    const afterOwnerDelete = await prisma.transaction.findUniqueOrThrow({ where: { id: bobTx.id } });
    ok("the group OWNER can delete a transaction created by a different member, through the real UI", afterOwnerDelete.deletedAt !== null);
    void ownerOnBobsTx;

    // ═══════════════════════ non-member cannot reach the collaborative UI ═══════════════════════

    await openTxByDeepLink(carolPage, splitTx.id);
    const carolBody = await modalText(carolPage);
    ok(
      "a non-member following the same deep link a member would use gets the generic no-longer-exists message, never the transaction's real content",
      carolBody.includes("no longer exists") && !carolBody.includes(`UIGroupSplit-${suffix}`) && !carolBody.includes(groupName)
    );

    // ═══════════════════════ solo transactions unchanged (regression) ═══════════════════════

    await alicePage.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await alicePage.click('button:has-text("＋ Add expense")');
    await alicePage.waitForSelector('input[placeholder="e.g. Swiggy"]');
    await alicePage.fill('input[placeholder="0"]', "150");
    await alicePage.fill('input[placeholder="e.g. Swiggy"]', `UISoloRegression-${suffix}`);
    // deliberately leave GROUP at "Personal"
    await alicePage.getByRole("button", { name: "Add expense", exact: true }).click();
    await alicePage.waitForSelector("text=Expense added");
    await alicePage.waitForTimeout(500);
    const soloTx = await txByMerchant(`UISoloRegression-${suffix}`);
    txIds.push(soloTx.id);

    // Search is a collapsed <details> now — the list is the page's job and the
    // field is opt-in — so it has to be opened before it can be typed into.
    const search = alicePage.locator('input[placeholder^="Search"]');
    if (!(await search.isVisible())) await alicePage.locator("summary", { hasText: "Search" }).first().click();
    await search.waitFor();
    await search.fill(`UISoloRegression-${suffix}`);
    await alicePage.waitForTimeout(500);
    await alicePage.locator(`button:has-text("UISoloRegression-${suffix}")`).first().click();
    await alicePage.getByRole("button", { name: "Edit", exact: true }).waitFor();
    await alicePage.getByRole("button", { name: "Edit", exact: true }).click();
    // An owner's solo Debit edit opens the full-screen composer. The property
    // under test is unchanged — the owner gets the FULL editor, where the
    // non-owner's is deliberately narrowed with the account read-only — it is
    // just expressed as chips rather than two <select>s now.
    const soloComposer = alicePage.locator("div[data-composer]");
    await soloComposer.waitFor({ timeout: 15000 });
    const accountChip = soloComposer.getByRole("button", { name: /^Payment method:|^Choose a payment method$/ });
    const categoryChip = soloComposer.getByRole("button", { name: /^Category:|^Choose a category$/ });
    ok(
      "a solo transaction's owner still gets the fully-functional editor — account and category both live and changeable — where a non-owner's is narrowed",
      (await accountChip.count()) === 1 && (await categoryChip.count()) === 1
        && (await accountChip.isEnabled()) && (await categoryChip.isEnabled()),
      `account=${await accountChip.count()} category=${await categoryChip.count()}`
    );
    await alicePage.getByRole("button", { name: "Cancel", exact: true }).click();
  } catch (e) {
    ok("script error", false, String(e).slice(0, 800));
    await bobPage.screenshot({ path: "e2e-output/collab-ui-error-bob.png", fullPage: true }).catch(() => {});
    await alicePage.screenshot({ path: "e2e-output/collab-ui-error-alice.png", fullPage: true }).catch(() => {});
  } finally {
    // ═══════════════════════ cleanup ═══════════════════════
    // reverse balance effects for anything still live (soft-deleted rows —
    // rentTx/bobTx by the test itself — already had theirs reversed by the
    // real delete path; splitTx/soloTx never got deleted, so their debit is
    // still sitting on Alice's REAL persistent demo account otherwise)
    for (const id of txIds) {
      const t = await prisma.transaction.findUnique({ where: { id } });
      if (t && t.deletedAt === null && t.accountId) await applyBalances(prisma, t, -1);
    }
    await prisma.expenseSplit.deleteMany({ where: { txId: { in: txIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: txIds } } });
    await prisma.intent.deleteMany({ where: { entityId: { in: txIds } } });
    await prisma.transaction.deleteMany({ where: { id: { in: txIds } } });
    await prisma.groupMember.deleteMany({ where: { groupId: flat.id } });
    await prisma.invitation.deleteMany({ where: { participantId: bobParticipant.id } });
    await prisma.participant.delete({ where: { id: bobParticipant.id } });
    await prisma.group.delete({ where: { id: flat.id } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUsers } } });
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
