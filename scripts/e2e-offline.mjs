// Offline-sync Phase 0 + Phase 1 exit criteria (spec §17), browser side.
// P0: installable manifest, SW registration + device identity, offline shell,
// network-first online behavior. P1: offline creates queue with local echo
// (⏳), the hero balance includes pending with the footnote cue, reconnection
// drains automatically and lands paise-identical to online creates, a queue
// left by a killed app drains on reopen, and the Settings sync card reports
// truthfully.
import { chromium } from "playwright";
import { composerOf, openSplitSheet, saveComposer, setMerchant, topSheet, typeAmount } from "./e2e-composer.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const SHOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "e2e-output");
fs.mkdirSync(SHOT, { recursive: true });
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
page.setDefaultTimeout(20000);

try {
  await page.goto("http://localhost:3000/sign-in", { waitUntil: "load" });

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  ok("manifest is linked (installable PWA)", manifestHref === "/manifest.webmanifest", manifestHref ?? "missing");
  const manifest = await page.evaluate(async () => (await fetch("/manifest.webmanifest")).json());
  ok("manifest declares name/start_url/display/icons", manifest.name === "Ledgerly" && manifest.display === "standalone" && manifest.icons?.length > 0);

  await page.fill('input[type="email"]', "arjun@ledgerly.app");
  await page.fill('input[type="password"]', "ledgerly-demo");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 15000 });
  // This suite runs at 390px, where the hero reads "Total balance"; the
  // desktop eyebrow is in the DOM but hidden. Ask for whichever is on screen.
  await page.getByText(/^(TOTAL BALANCE|Total balance)$/).filter({ visible: true }).first().waitFor({ timeout: 20000 });

  const swState = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return { scope: reg.scope, active: !!reg.active };
  });
  ok("service worker registers and activates", swState.active && swState.scope.endsWith("/"), swState.scope);

  const deviceId = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open("ledgerly");
        req.onsuccess = () => {
          const db = req.result;
          try {
            const get = db.transaction("meta", "readonly").objectStore("meta").get("deviceId");
            get.onsuccess = () => resolve(get.result?.value ?? null);
            get.onerror = () => resolve(null);
          } catch {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      })
  );
  ok("device identity established in IndexedDB", typeof deviceId === "string" && deviceId.length >= 32, String(deviceId).slice(0, 8) + "…");

  // let the SW settle + cache the precache set, then go dark
  await page.waitForTimeout(600);
  await context.setOffline(true);
  await page.goto("http://localhost:3000/dashboard", { waitUntil: "load" }).catch(() => {});
  const offlineText = await page.evaluate(() => document.body.innerText);
  ok("cold offline navigation renders the branded shell", offlineText.includes("You’re offline") || offlineText.includes("You're offline"));
  await page.screenshot({ path: `${SHOT}/offline-shell-390.png` });

  await context.setOffline(false);
  await page.goto("http://localhost:3000/dashboard", { waitUntil: "load" });
  // This suite runs at 390px, where the hero reads "Total balance"; the
  // desktop eyebrow is in the DOM but hidden. Ask for whichever is on screen.
  await page.getByText(/^(TOTAL BALANCE|Total balance)$/).filter({ visible: true }).first().waitFor({ timeout: 20000 });
  ok("back online: navigations are network-first (fresh page, not a cached shell)", true);

  // ═══════════ Phase 1: offline create, local echo, drain, paise-exact ═══════════
  const heroPaise = async () => {
    // Exact: a loose match also resolves the mobile hero's "Total balance",
    // and reading the wrong hero's figure would silently compare the wrong
    // numbers rather than fail outright.
    const t = await page
      .getByText(/^(TOTAL BALANCE|Total balance)$/)
      .filter({ visible: true })
      .first()
      .locator("..")
      .innerText();
    const m = t.match(/(−?₹[\d,]+)/);
    return Math.round(Number(m[1].replace(/₹|,|\s/g, "").replace(/−/g, "-")) * 100);
  };
  // Adding a Debit is the full-screen composer. The offline path underneath is
  // unchanged — same outbox, same queueing — so every assertion below still
  // measures what it always did.
  const addExpenseViaModal = async (merchant, rupees) => {
    await page.click('button:has-text("＋ Add expense")');
    await typeAmount(page, rupees);
    await setMerchant(page, merchant);
    await saveComposer(page);
  };

  await page.setViewportSize({ width: 1280, height: 900 }); // desktop: header add button + roomy asserts
  await page.goto("http://localhost:3000/dashboard", { waitUntil: "load" });
  // This suite runs at 390px, where the hero reads "Total balance"; the
  // desktop eyebrow is in the DOM but hidden. Ask for whichever is on screen.
  await page.getByText(/^(TOTAL BALANCE|Total balance)$/).filter({ visible: true }).first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(400); // let hydration settle after the viewport/nav change
  const base = await heroPaise();

  // online control write (goes through the same intent-tagged path);
  // router.refresh() needs a moment to land — poll rather than guess
  await addExpenseViaModal("P1Control", 111);
  let afterControl = base;
  for (let i = 0; i < 20 && afterControl === base; i++) {
    await page.waitForTimeout(500);
    afterControl = await heroPaise();
  }
  ok("online create still works and moves the hero paise-exact", afterControl === base - 11100, `${base} -> ${afterControl}`);

  // offline create on the OPEN dashboard: footnote + inclusive balance, no navigation
  await context.setOffline(true);
  await addExpenseViaModal("P1Offline", 222);
  // Phase 2: universal write-behind means every create shows the normal
  // success toast immediately (online or not) — the ⏳ row badge is the sole
  // ambient pending signal now (spec §17 Phase 2 toast-copy simplification)
  await page.waitForSelector("text=/includes 1 unsynced change/");
  const offlineHero = await heroPaise();
  ok("offline create: hero balance includes the pending amount immediately", offlineHero === afterControl - 22200, `${afterControl} -> ${offlineHero}`);
  await page.screenshot({ path: `${SHOT}/offline-pending-hero.png` });

  // reconnect → automatic drain → server row replaces the echo, balance identical.
  // The footnote detaches the moment the outbox empties, BEFORE router.refresh
  // lands the new server balance — poll until the refreshed number arrives.
  await context.setOffline(false);
  await page.waitForSelector("text=/includes 1 unsynced change/", { state: "detached", timeout: 15000 });
  let drainedHero = 0;
  for (let i = 0; i < 20; i++) {
    drainedHero = await heroPaise();
    if (drainedHero === base - 33300) break;
    await page.waitForTimeout(500);
  }
  ok(
    "drained offline create lands paise-identical to an online create",
    drainedHero === base - 11100 - 22200,
    `expected ${base - 33300}, got ${drainedHero}`
  );

  // local echo on an open transactions list
  await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
  // Search is a collapsed <details> now — the list is the page's job and the
  // field is opt-in — so it has to be opened before it can be used.
  {
    const field = page.locator('input[placeholder^="Search"]');
    if (!(await field.isVisible())) await page.locator("summary").filter({ hasText: "Search" }).first().click();
    await field.waitFor({ state: "visible", timeout: 15000 });
  }
  await context.setOffline(true);
  await addExpenseViaModal("P1EchoRow", 55);
  await page.waitForSelector("text=Waiting to sync");
  const echo = await page.evaluate(() => document.body.innerText);
  ok("offline create shows a ⏳ local-echo row on the open list", echo.includes("P1EchoRow") && echo.includes("Waiting for internet"));
  await page.screenshot({ path: `${SHOT}/offline-echo-row.png` });
  await context.setOffline(false);
  await page.waitForTimeout(2500);
  await page.waitForSelector("text=Waiting to sync", { state: "detached", timeout: 15000 });
  const afterEcho = await page.evaluate(() => document.body.innerText);
  ok("after drain the echo is replaced by the real server row", afterEcho.includes("P1EchoRow"));

  // split expenses refuse the queue with honest copy (P1 is solo-only)
  await context.setOffline(true);
  await page.click('button:has-text("＋ Add expense")');
  await typeAmount(page, "900");
  await openSplitSheet(page);
  await page.waitForSelector("text=Equal split");
  // Scope to the split sheet — the ledger behind it has seeded rows
  // mentioning Karan.
  await topSheet(page).locator('button:has-text("Karan")').first().click();
  await page.waitForTimeout(300);
  // The swipe is expected to be REFUSED: a split touches other people's
  // balances and needs the server, so the composer stays up and says so.
  await saveComposer(page, { expectClose: false });
  await page.waitForSelector("text=Split expenses need internet");
  ok("split expense offline is refused with honest copy (solo-only P1)", true);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  if (await composerOf(page).count()) {
    await composerOf(page).getByRole("button", { name: "Close" }).click();
    await page.waitForTimeout(300);
  }

  // killed-app recovery: queue an intent, destroy the page, reopen → drains on mount
  await addExpenseViaModal("P1Killed", 333);
  await page.close(); // app "killed" with the intent still queued in IndexedDB
  await context.setOffline(false);
  const page2 = await context.newPage();
  page2.setDefaultTimeout(20000);
  await page2.setViewportSize({ width: 1280, height: 900 }); // desktop for the header-button steps below
  await page2.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
  await page2.waitForSelector("text=P1Killed", { timeout: 20000 });
  // the row appears instantly as a local echo (read from IndexedDB on mount);
  // the drain into a real server row races with that. Phase 2's batch drain
  // calls a Route Handler (fetch), not a Server Action, so it no longer gets
  // Next's automatic RSC-payload merge — router.refresh() is now a second,
  // separate round trip after the outbox empties, so the echo can briefly
  // disappear before the real row paints. Poll rather than assume they land
  // in the same tick.
  await page2.waitForSelector("text=Waiting to sync", { state: "detached", timeout: 15000 }).catch(() => {});
  let killedBody = "";
  for (let i = 0; i < 10; i++) {
    killedBody = await page2.evaluate(() => document.body.innerText);
    if (killedBody.includes("P1Killed") && !killedBody.includes("Waiting to sync")) break;
    await page2.waitForTimeout(500);
  }
  ok("a queue left by a killed app survives and drains on reopen", killedBody.includes("P1Killed") && !killedBody.includes("Waiting to sync"));

  // Settings sync card: live counts while offline on the open page, Sync now
  await page2.goto("http://localhost:3000/settings", { waitUntil: "load" });
  await page2.waitForSelector("text=Everything is synced");
  await context.setOffline(true);
  await page2.click('button:has-text("＋ Add expense")');
  await typeAmount(page2, "44");
  await setMerchant(page2, "P1Settings");
  await saveComposer(page2);
  await page2.waitForSelector("text=1 waiting to sync");
  ok("settings sync card reports pending truthfully while offline", true);
  await page2.screenshot({ path: `${SHOT}/offline-settings-card.png` });
  await context.setOffline(false);
  await page2.getByRole("button", { name: "Sync now", exact: true }).click();
  await page2.waitForSelector("text=Everything is synced", { timeout: 15000 });
  ok("Sync now drains and the card returns to synced", true);

  // ── cleanup: remove the four test transactions ──
  for (const merchant of ["P1Control", "P1Offline", "P1EchoRow", "P1Killed", "P1Settings"]) {
    await page2.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
    {
      const field = page2.locator('input[placeholder^="Search"]');
      if (!(await field.isVisible())) await page2.locator("summary").filter({ hasText: "Search" }).first().click();
      await field.waitFor({ state: "visible", timeout: 15000 });
    }
    await page2.fill('input[placeholder^="Search"]', merchant);
    await page2.waitForTimeout(500);
    const row = page2.locator(`button:has-text("${merchant}")`).first();
    if ((await row.count()) === 0) continue;
    await row.click();
    await page2.getByRole("button", { name: "Delete", exact: true }).click();
    await page2.waitForSelector("text=Delete this transaction?");
    await page2.getByRole("button", { name: "Delete", exact: true }).click();
    await page2.waitForSelector("text=Transaction deleted");
    await page2.waitForTimeout(300);
  }
  ok("cleanup: P1 test transactions removed", true);
} catch (e) {
  ok("script error", false, String(e).slice(0, 400));
  await page.screenshot({ path: `${SHOT}/offline-error.png`, fullPage: true }).catch(() => {});
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
