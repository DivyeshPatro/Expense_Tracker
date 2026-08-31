// Offline-sync Phase 3 exit criteria (spec §17): "two-device edit race → LWW
// + both versions in audit; parked intent unblocks unrelated queue; every
// §12 solo scenario has a passing e2e." Combines Prisma (to simulate a
// second device's write landing first, or another device deleting a
// referenced account/category mid-flight — exactly like the Phase 2
// soft-heal test) with Playwright (real browser outbox + drain).
// Run: npx tsx scripts/e2e-offline-p3.ts
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Cookie, type Page } from "playwright";
import { prisma } from "../src/server/db";
import { composerOf, saveComposer, setMerchant, typeAmount } from "./e2e-composer.mjs";

const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

async function signIn(page: Page) {
  await page.goto("http://localhost:3000/sign-in", { waitUntil: "load" });
  await page.fill('input[type="email"]', "arjun@ledgerly.app");
  await page.fill('input[type="password"]', "ledgerly-demo");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 20000 });
  // The eyebrow reads "TOTAL BALANCE" on a live window and "BALANCE · <period>"
  // otherwise. Either means the dashboard has painted; exact matching keeps it
  // from also resolving the mobile hero's "Total balance".
  await page.getByText(/^(TOTAL BALANCE|BALANCE · .+)$/).first().waitFor({ timeout: 20000 });
}

/** A fresh context (own IndexedDB → own device identity) authenticated by
 * copying the ONE real session's cookies, instead of a form sign-in — Better
 * Auth's default rate limiter caps repeated /api/auth/sign-in POSTs, and this
 * script legitimately needs several "devices" against the same account. */
async function newDevice(browser: Browser, cookies: Cookie[]): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  await page.goto("http://localhost:3000/dashboard", { waitUntil: "load" });
  // The eyebrow reads "TOTAL BALANCE" on a live window and "BALANCE · <period>"
  // otherwise. Either means the dashboard has painted; exact matching keeps it
  // from also resolving the mobile hero's "Total balance".
  await page.getByText(/^(TOTAL BALANCE|BALANCE · .+)$/).first().waitFor({ timeout: 20000 });
  return { ctx, page };
}

async function openDetail(page: Page, merchant: string) {
  await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
  // Search is a collapsed <details> — opt-in, so it has to be opened first.
  const field = page.locator('input[placeholder^="Search"]');
  if (!(await field.isVisible())) await page.locator("summary").filter({ hasText: "Search" }).first().click();
  await field.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(200);
  await field.fill(merchant);
  await page.waitForTimeout(600);
  await page.locator(`button:has-text("${merchant}")`).first().click();
  // a healthy transaction shows Edit/Delete; a needs-attention one shows
  // Fix/Discard instead (no "Edit" at all) — wait for whichever shows up
  await page.waitForSelector('text=/^(Edit|Fix)$/', { timeout: 10000 });
}

async function editAmount(page: Page, newRupees: string) {
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  // A queued row still opens the classic pending form (its amount field is
  // deliberately type="text", so it is addressed by label); a synced one opens
  // the composer, whose amount is a keypad.
  await Promise.race([
    composerOf(page).waitFor({ timeout: 20000 }),
    page.getByLabel("AMOUNT (₹)").waitFor({ timeout: 20000 }),
  ]);
  if (await composerOf(page).count()) {
    await typeAmount(page, newRupees);
    return;
  }
  await page.getByLabel("AMOUNT (₹)").fill(newRupees);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
}

/** Selects the option matching `optionText` on whichever <select> on the
 * page actually lists it — a <Field> label isn't programmatically tied to
 * its <select>, so scanning every select's own options is the only reliable
 * way to find the right one (Playwright's `:near()` matched the wrong
 * element here more than once). */
async function selectByOptionText(page: Page, optionText: string): Promise<boolean> {
  const selects = page.locator("select");
  const count = await selects.count();
  for (let i = 0; i < count; i++) {
    const opts = await selects.nth(i).locator("option").allTextContents();
    if (opts.some((o) => o.includes(optionText))) {
      await selects.nth(i).selectOption({ label: opts.find((o) => o.includes(optionText))! });
      return true;
    }
  }
  return false;
}

async function main() {
  const user = await prisma.user.findFirst({ where: { email: "arjun@ledgerly.app" } });
  if (!user) throw new Error("Demo user not found — run db:seed first");
  const account = await prisma.account.findFirst({ where: { userId: user.id, name: "HDFC Savings" } });
  if (!account) throw new Error("Demo account not found");

  const browser = await chromium.launch({ headless: true });

  // one real form sign-in for the whole script — every "device" below reuses
  // its cookies via a fresh context instead of signing in again, since
  // Better Auth's default rate limiter caps repeated sign-in POSTs and this
  // script needs several devices against the same account
  const bootstrap = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const bootstrapPage = await bootstrap.newPage();
  await signIn(bootstrapPage);
  const cookies = await bootstrap.cookies();
  await bootstrap.close();

  // ═══════════════════════ two-device edit race → LWW + both versions in audit ═══════════════════════
  {
    const tx = await prisma.transaction.create({
      data: { userId: user.id, type: "EXPENSE", accountId: account.id, amount: 10000, merchant: "P3Race", occurredAt: new Date() },
    });
    await prisma.account.update({ where: { id: account.id }, data: { balance: { decrement: 10000 } } });

    const { ctx: ctxB, page: pageB } = await newDevice(browser, cookies);
    await openDetail(pageB, "P3Race"); // captures version=1 into B's local state
    await ctxB.setOffline(true);
    await editAmount(pageB, "999"); // queues update with baseVersion=1, still offline

    const { ctx: ctxA, page: pageA } = await newDevice(browser, cookies);
    await openDetail(pageA, "P3Race");
    await editAmount(pageA, "555"); // online — applies immediately, server version 1 -> 2
    await pageA.waitForSelector("text=Transaction updated");
    await pageA.waitForTimeout(800);

    await ctxB.setOffline(false);
    await pageB.waitForSelector("text=Waiting to sync", { state: "detached", timeout: 20000 }).catch(() => {});
    await pageB.waitForTimeout(1200);

    const final = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
    ok("last writer (device B, arriving second) wins — no prompt, no data loss", Number(final.amount) === 99900, `${final.amount}`);

    const audits = await prisma.auditLog.findMany({ where: { userId: user.id, entityId: tx.id, action: "update" }, orderBy: { at: "asc" } });
    ok("both edits produced their own audit row", audits.length === 2, `${audits.length} rows`);
    const a1 = audits[0]?.after as { amount?: string } | null;
    const a2 = audits[1]?.before as { amount?: string } | null;
    ok(
      "both versions are reconstructable from the audit trail (A's after == B's before == 555)",
      String(a1?.amount) === "55500" && String(a2?.amount) === "55500",
      `A.after=${a1?.amount}, B.before=${a2?.amount}`
    );

    const intents = await prisma.intent.findMany({ where: { userId: user.id, entityId: tx.id }, orderBy: { appliedAt: "asc" } });
    ok("device A's intent recorded as a clean apply", intents[0]?.status === "applied", intents[0]?.status);
    ok("device B's intent recorded as an override (OK_OVERRIDE)", intents[1]?.status === "overridden", intents[1]?.status);

    const bLog = await pageB.evaluate(
      () =>
        new Promise<{ status: string; detail?: string }[]>((resolve) => {
          const req = indexedDB.open("ledgerly");
          req.onsuccess = () => {
            const getAll = req.result.transaction("syncLog", "readonly").objectStore("syncLog").getAll();
            getAll.onsuccess = () => resolve(getAll.result);
          };
        })
    );
    const overrideEntry = bLog.find((e) => e.status === "overridden");
    ok("device B's activity log names the override (spec §13 copy)", !!overrideEntry?.detail?.includes("replaced an edit from"), overrideEntry?.detail);

    await prisma.transaction.delete({ where: { id: tx.id } });
    await prisma.account.update({ where: { id: account.id }, data: { balance: { increment: 10000 } } });
    await prisma.intent.deleteMany({ where: { userId: user.id, entityId: tx.id } });
    await prisma.auditLog.deleteMany({ where: { userId: user.id, entityId: tx.id } });
    await ctxA.close();
    await ctxB.close();
    await new Promise((r) => setTimeout(r, 800)); // let resources settle between sections
  }

  // ═══════════════════════ poison-pill parking unblocks the unrelated queue ═══════════════════════
  {
    const { ctx, page } = await newDevice(browser, cookies);
    await page.waitForTimeout(300); // let device identity establish before seeding the outbox directly

    // fresh, unique ids every run — a hardcoded intentId would collide with
    // the server's permanent (userId, intentId) idempotency record from a
    // previous run and get silently treated as a replay (correct behavior,
    // but it would make THIS test's own re-runs unreliable)
    const poisonedIntentId = randomUUID();
    const unrelatedIntentId = randomUUID();
    const poisonedEntityId = randomUUID().replace(/-/g, "").slice(0, 24);
    const unrelatedEntityId = randomUUID().replace(/-/g, "").slice(0, 24);

    await page.evaluate(
      async ({ userId, poisonedIntentId, unrelatedIntentId, poisonedEntityId, unrelatedEntityId }) => {
        const req = indexedDB.open("ledgerly");
        await new Promise<void>((resolve) => {
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction("outbox", "readwrite");
            const store = tx.objectStore("outbox");
            const now = Date.now();
            store.put({
              intentId: poisonedIntentId,
              seq: now * 100 + 1,
              userId,
              deviceId: "poison-test-device",
              kind: "expense.create",
              payload: { amount: "12", accountId: null, categoryId: null, merchant: "P3Poisoned", date: new Date().toISOString().slice(0, 10) },
              entityId: poisonedEntityId,
              clientTs: new Date().toISOString(),
              status: "pending",
              attempts: 19,
              firstFailedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(), // 25h ago — already past the 24h poison-pill window
            });
            store.put({
              intentId: unrelatedIntentId,
              seq: now * 100 + 2,
              userId,
              deviceId: "poison-test-device",
              kind: "expense.create",
              payload: { amount: "13", accountId: null, categoryId: null, merchant: "P3Unrelated", date: new Date().toISOString().slice(0, 10) },
              entityId: unrelatedEntityId,
              clientTs: new Date().toISOString(),
              status: "pending",
              attempts: 0,
            });
            tx.oncomplete = () => resolve();
          };
        });
      },
      { userId: user.id, poisonedIntentId, unrelatedIntentId, poisonedEntityId, unrelatedEntityId }
    );

    // force the batch to fail once, deterministically (not a real network flake)
    await page.route("**/api/sync", (route) => route.abort());
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForTimeout(1500);
    await page.unroute("**/api/sync");

    const afterFirstAttempt = await page.evaluate(
      () =>
        new Promise<{ intentId: string; status: string; lastErrorCode?: string }[]>((resolve) => {
          const req = indexedDB.open("ledgerly");
          req.onsuccess = () => {
            const getAll = req.result.transaction("outbox", "readonly").objectStore("outbox").getAll();
            getAll.onsuccess = () => resolve(getAll.result);
          };
        })
    );
    const poisoned = afterFirstAttempt.find((i) => i.intentId === poisonedIntentId);
    ok(
      "an intent past 24h/20 attempts of RETRYABLE failure parks as needs-attention (poison-pill)",
      poisoned?.status === "needs-attention" && poisoned?.lastErrorCode === "RETRYABLE",
      `status=${poisoned?.status}, code=${poisoned?.lastErrorCode}`
    );
    const stillQueued = afterFirstAttempt.find((i) => i.intentId === unrelatedIntentId);
    ok("the unrelated intent behind it wasn't lost or corrupted while parked", stillQueued?.status === "pending", stillQueued?.status);

    // now let the real drain through — the parked intent must not block the unrelated one
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForTimeout(2000);
    const unrelatedRows = await prisma.transaction.count({ where: { userId: user.id, merchant: "P3Unrelated", deletedAt: null } });
    ok("the parked intent does not block the unrelated queue from draining", unrelatedRows === 1, `${unrelatedRows} row(s)`);

    // cleanup: outbox (still holds the poisoned intent), the drained
    // transaction + its balance effect, and both server-side Intent rows
    await page.evaluate((poisonedIntentId: string) => {
      const req = indexedDB.open("ledgerly");
      req.onsuccess = () => {
        req.result.transaction("outbox", "readwrite").objectStore("outbox").delete(poisonedIntentId);
      };
    }, poisonedIntentId);
    if (unrelatedRows > 0) {
      const rows = await prisma.transaction.findMany({ where: { userId: user.id, merchant: "P3Unrelated", deletedAt: null } });
      for (const r of rows) {
        if (r.accountId) await prisma.account.update({ where: { id: r.accountId }, data: { balance: { increment: r.amount } } });
        await prisma.transaction.delete({ where: { id: r.id } });
      }
    }
    await prisma.intent.deleteMany({ where: { userId: user.id, id: { in: [poisonedIntentId, unrelatedIntentId] } } });
    await ctx.close();
    await new Promise((r) => setTimeout(r, 800)); // let resources settle between sections
  }

  // ═══════════════════════ §12 solo scenario: account deleted mid-flight → INVALID_REF_HARD ═══════════════════════
  {
    // unique per run — a fixed name risks colliding with an orphan left by
    // an earlier interrupted run, which selectByOptionText can't distinguish
    // from the one this run just created (both share the exact option label)
    const scratchAccountName = `P3ScratchAccount-${randomUUID().slice(0, 8)}`;
    const scratchAccount = await prisma.account.create({
      data: { userId: user.id, name: scratchAccountName, type: "BANK", balance: 0, openingBalance: 0 },
    });
    const tx = await prisma.transaction.create({
      data: { userId: user.id, type: "EXPENSE", accountId: account.id, amount: 5000, merchant: "P3AccountGone", occurredAt: new Date() },
    });
    await prisma.account.update({ where: { id: account.id }, data: { balance: { decrement: 5000 } } });

    const { ctx, page } = await newDevice(browser, cookies);
    await openDetail(page, "P3AccountGone");
    await ctx.setOffline(true);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.waitForSelector('input[type="number"]');
    // find whichever <select> actually lists the scratch account, rather than
    // guessing DOM position or relying on Playwright's ambiguous :near() —
    // there's no unique accessible name tying a <select> to its <Field> label
    await selectByOptionText(page, scratchAccountName);
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.waitForSelector("text=Save changes", { state: "detached" }); // the sheet closes on a successful (queued) save

    // simulate another device deleting the account before this queued edit gets a chance to sync
    await prisma.account.delete({ where: { id: scratchAccount.id } });

    await ctx.setOffline(false);
    await page.waitForTimeout(2500);
    const stillOnOriginal = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
    ok("edit referencing a since-deleted account never silently lands", stillOnOriginal.accountId === account.id, `accountId=${stillOnOriginal.accountId}`);

    await openDetail(page, "P3AccountGone");
    const body = await page.evaluate(() => document.body.innerText);
    ok("needs-attention copy names the missing account (INVALID_REF_HARD)", body.includes("account this refers to no longer exists"));
    ok("Fix and Discard are both offered", body.includes("Fix") && body.includes("Discard"));

    await prisma.transaction.delete({ where: { id: tx.id } });
    await prisma.account.update({ where: { id: account.id }, data: { balance: { increment: 5000 } } });
    await prisma.intent.deleteMany({ where: { userId: user.id, entityId: tx.id } });
    await prisma.auditLog.deleteMany({ where: { userId: user.id, entityId: tx.id } });
    await ctx.close();
    await new Promise((r) => setTimeout(r, 800)); // let resources settle between sections
  }

  // ═══════════════════════ §12 solo scenario: category deleted mid-flight on an EDIT → soft-heal ═══════════════════════
  {
    const scratchCategoryName = `P3ScratchCategory-${randomUUID().slice(0, 8)}`;
    const scratchCategory = await prisma.category.create({ data: { userId: user.id, name: scratchCategoryName, kind: "EXPENSE", icon: "🧪" } });
    const tx = await prisma.transaction.create({
      data: { userId: user.id, type: "EXPENSE", accountId: account.id, amount: 4000, merchant: "P3CategoryGone", occurredAt: new Date() },
    });
    await prisma.account.update({ where: { id: account.id }, data: { balance: { decrement: 4000 } } });

    const { ctx, page } = await newDevice(browser, cookies);
    await openDetail(page, "P3CategoryGone");
    await ctx.setOffline(true);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.waitForSelector('input[type="number"]');
    await selectByOptionText(page, scratchCategoryName);
    await page.fill('input[type="number"]', "45");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.waitForSelector("text=Save changes", { state: "detached" }); // the sheet closes on a successful (queued) save

    await prisma.category.delete({ where: { id: scratchCategory.id } });

    await ctx.setOffline(false);
    await page.waitForTimeout(2000);
    const healed = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
    ok("edit auto-heals to uncategorized instead of parking (INVALID_REF_SOFT)", healed.categoryId === null, `categoryId=${healed.categoryId}`);
    ok("the rest of the edit (amount) still applied", Number(healed.amount) === 4500, `${healed.amount}`);

    await prisma.transaction.delete({ where: { id: tx.id } });
    await prisma.account.update({ where: { id: account.id }, data: { balance: { increment: 4500 } } });
    await prisma.intent.deleteMany({ where: { userId: user.id, entityId: tx.id } });
    await prisma.auditLog.deleteMany({ where: { userId: user.id, entityId: tx.id } });
    await ctx.close();
    await new Promise((r) => setTimeout(r, 800)); // let resources settle between sections
  }

  // ═══════════════════════ §12 solo scenario: too old (>30 days) → STALE_INTENT ═══════════════════════
  {
    const tx = await prisma.transaction.create({
      data: { userId: user.id, type: "EXPENSE", accountId: account.id, amount: 1800, merchant: "P3StaleEdit", occurredAt: new Date() },
    });
    await prisma.account.update({ where: { id: account.id }, data: { balance: { decrement: 1800 } } });

    const { ctx, page } = await newDevice(browser, cookies);
    await openDetail(page, "P3StaleEdit");
    await ctx.setOffline(true);
    await editAmount(page, "20");
    await page.waitForSelector("text=Save changes", { state: "detached" }); // the sheet closes on a successful (queued) save

    // rewrite the queued intent's clientTs to 31 days ago — simulating a
    // device that stayed offline far longer than the retention window
    await page.evaluate(() => {
      const req = indexedDB.open("ledgerly");
      req.onsuccess = () => {
        const store = req.result.transaction("outbox", "readwrite").objectStore("outbox");
        const getAll = store.getAll();
        getAll.onsuccess = () => {
          for (const intent of getAll.result) {
            if (intent.kind === "expense.update") {
              intent.clientTs = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
              store.put(intent);
            }
          }
        };
      };
    });

    await ctx.setOffline(false);
    await page.waitForTimeout(2000);
    const unchanged = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
    ok("a >30-day-old queued edit never silently applies (STALE_INTENT)", Number(unchanged.amount) === 1800, `${unchanged.amount}`);

    await openDetail(page, "P3StaleEdit");
    const staleBody = await page.evaluate(() => document.body.innerText);
    ok("needs-attention copy tells the user it waited too long", staleBody.includes("waited too long to sync safely"));

    await prisma.transaction.delete({ where: { id: tx.id } });
    await prisma.account.update({ where: { id: account.id }, data: { balance: { increment: 1800 } } });
    await prisma.intent.deleteMany({ where: { userId: user.id, entityId: tx.id } });
    await prisma.auditLog.deleteMany({ where: { userId: user.id, entityId: tx.id } });
    await ctx.close();
    await new Promise((r) => setTimeout(r, 800)); // let resources settle between sections
  }

  // ═══════════════════════ §12 solo scenario: session expired at sync time → banner, queue holds ═══════════════════════
  {
    const { ctx, page } = await newDevice(browser, cookies);

    await page.route("**/api/sync", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "AUTH_EXPIRED" }) }));
    await page.click('button:has-text("＋ Add expense")');
    await typeAmount(page, "22");
    await setMerchant(page, "P3AuthExpired");
    await saveComposer(page);
    await page.waitForTimeout(1200);

    const bannerBody = await page.evaluate(() => document.body.innerText);
    ok("session-expired banner appears (not a per-item failure)", /Sign in again to sync your \d+ change/.test(bannerBody));

    const stillPending = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const req = indexedDB.open("ledgerly");
          req.onsuccess = () => {
            const count = req.result.transaction("outbox", "readonly").objectStore("outbox").count();
            count.onsuccess = () => resolve(count.result);
          };
        })
    );
    ok("the queue holds untouched — nothing is lost while signed out", stillPending === 1, `${stillPending} still queued`);

    await page.unroute("**/api/sync");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForTimeout(1500);
    const drainedAfterAuthOk = await prisma.transaction.count({ where: { userId: user.id, merchant: "P3AuthExpired", deletedAt: null } });
    ok("once the session is valid again, the held queue drains normally", drainedAfterAuthOk === 1, `${drainedAfterAuthOk} row(s)`);

    if (drainedAfterAuthOk > 0) {
      const rows = await prisma.transaction.findMany({ where: { userId: user.id, merchant: "P3AuthExpired", deletedAt: null } });
      for (const r of rows) {
        if (r.accountId) await prisma.account.update({ where: { id: r.accountId }, data: { balance: { increment: r.amount } } });
        await prisma.transaction.delete({ where: { id: r.id } });
      }
    }
    await ctx.close();
    await new Promise((r) => setTimeout(r, 800)); // let resources settle between sections
  }

  await browser.close();
}

main()
  .catch((e) => {
    ok("script error", false, String(e).slice(0, 500));
  })
  .finally(async () => {
    await prisma.$disconnect();
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  });
