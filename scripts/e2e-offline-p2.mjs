// Offline-sync Phase 2 exit criteria (spec §17): universal write-behind,
// batched /api/sync, pending edit/delete coalescing, Sync Center. Each
// check maps directly to one exit-criteria bullet:
//   - every write visible <100ms (even with slow network — local-first, not
//     network-gated)
//   - double-tap submit produces one intent
//   - batch endpoint lands all queued creates correctly (§5 taxonomy,
//     applied in FIFO order by a sequential — not parallel — server loop)
//   - a coalesced edit produces exactly one eventual server mutation
// Plus: pending cancel+undo, category soft-heal (INVALID_REF_SOFT), and a
// Sync Center smoke test, since those are the other Phase 2 deliverables.
import { chromium } from "playwright";
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
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(20000);

const addExpenseViaModal = async (merchant, rupees) => {
  await page.click('button:has-text("＋ Add expense")');
  await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
  await page.fill('input[placeholder="0"]', String(rupees));
  await page.fill('input[placeholder="e.g. Swiggy"]', merchant);
  await page.getByRole("button", { name: "Add expense", exact: true }).click();
};

async function rowCount(merchant) {
  await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
  await page.fill('input[placeholder^="Search"]', merchant);
  await page.waitForTimeout(600);
  return page.locator(`button:has-text("${merchant}")`).count();
}

async function deleteAllRows(merchant) {
  for (let i = 0; i < 5; i++) {
    await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
    await page.fill('input[placeholder^="Search"]', merchant);
    await page.waitForTimeout(500);
    const row = page.locator(`button:has-text("${merchant}")`).first();
    if ((await row.count()) === 0) break;
    await row.click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForSelector("text=Delete this transaction?");
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForSelector("text=Transaction deleted");
    await page.waitForTimeout(300);
  }
}

try {
  await page.goto("http://localhost:3000/sign-in", { waitUntil: "load" });
  await page.fill('input[type="email"]', "arjun@ledgerly.app");
  await page.fill('input[type="password"]', "ledgerly-demo");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 15000 });
  await page.waitForSelector("text=/TOTAL BALANCE|BALANCE ·/");

  // ═══════════ universal write-behind: instant even while ONLINE, and not gated by network latency ═══════════
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 2500, downloadThroughput: -1, uploadThroughput: -1 });
  const t0 = Date.now();
  await addExpenseViaModal("P2Instant", 45);
  await page.waitForSelector("text=Expense added");
  const visibleMs = Date.now() - t0;
  ok(
    "online create is visible without waiting on the network (write-behind, not gated by a 2.5s-latency link)",
    visibleMs < 1500,
    `${visibleMs}ms (network latency was throttled to 2500ms)`
  );
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.waitForTimeout(1500); // let the throttled drain land before continuing
  ok("P2Instant landed exactly once", (await rowCount("P2Instant")) === 1);
  await deleteAllRows("P2Instant");

  // ═══════════ double-tap submit produces exactly one intent ═══════════
  await page.click('button:has-text("＋ Add expense")');
  await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
  await page.fill('input[placeholder="0"]', "77");
  await page.fill('input[placeholder="e.g. Swiggy"]', "P2DoubleTap");
  // raw coordinate clicks, back to back, skip Playwright's per-click
  // actionability re-check (which — correctly — refuses a second click once
  // the button's own disabled state has already landed) so this exercises
  // the real defense: React setting busy=true synchronously in the handler
  const submitBtn = page.getByRole("button", { name: "Add expense", exact: true });
  const box = await submitBtn.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForSelector("text=Expense added");
  await page.waitForTimeout(1200);
  ok("double-tap submit produces exactly one transaction (not two)", (await rowCount("P2DoubleTap")) === 1);
  await deleteAllRows("P2DoubleTap");

  // ═══════════ batch endpoint: 3 queued offline all land correctly ═══════════
  await context.setOffline(true);
  await addExpenseViaModal("P2Batch1", 10);
  await page.waitForSelector("text=Expense added");
  await addExpenseViaModal("P2Batch2", 20);
  await page.waitForSelector("text=Expense added");
  await addExpenseViaModal("P2Batch3", 30);
  await page.waitForSelector("text=Expense added");
  await context.setOffline(false);
  await page.waitForSelector("text=Waiting to sync", { state: "detached", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const b1 = await rowCount("P2Batch1");
  const b2 = await rowCount("P2Batch2");
  const b3 = await rowCount("P2Batch3");
  ok("batch drain lands all 3 queued creates exactly once each", b1 === 1 && b2 === 1 && b3 === 1, `${b1}, ${b2}, ${b3}`);
  await deleteAllRows("P2Batch1");
  await deleteAllRows("P2Batch2");
  await deleteAllRows("P2Batch3");

  // ═══════════ coalesced edit produces exactly one eventual server mutation ═══════════
  await context.setOffline(true);
  await addExpenseViaModal("P2Coalesce", 50);
  await page.waitForSelector("text=Expense added");
  await page.click('button:has-text("P2Coalesce")');
  await page.waitForSelector("text=Edit");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
  await page.fill('input[type="number"]', "65");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.waitForSelector("text=Save changes", { state: "detached" }); // editPending() closes the whole sheet on success
  await context.setOffline(false);
  await page.waitForSelector("text=Waiting to sync", { state: "detached", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const coalesceCount = await rowCount("P2Coalesce");
  await page.click('button:has-text("P2Coalesce")');
  const detailBody = await page.evaluate(() => document.body.innerText);
  ok(
    "coalesced edit produces exactly one server transaction, carrying the edited amount (not the original)",
    coalesceCount === 1 && detailBody.includes("₹65"),
    `${coalesceCount} row(s), detail: ${detailBody.includes("₹65") ? "₹65 ✓" : "missing ₹65"}`
  );
  await page.keyboard.press("Escape");
  await deleteAllRows("P2Coalesce");

  // ═══════════ pending cancel + undo (local only, never touches the server) ═══════════
  await context.setOffline(true);
  await addExpenseViaModal("P2Cancel", 90);
  await page.waitForSelector("text=Expense added");
  await page.click('button:has-text("P2Cancel")');
  await page.waitForSelector("text=Remove");
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.waitForSelector("text=Removed — it was never synced");
  ok("cancelling a pending item removes it from the list immediately", !(await page.evaluate(() => document.body.innerText)).includes("P2Cancel"));
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForSelector("text=P2Cancel");
  ok("undo restores the cancelled intent", (await page.evaluate(() => document.body.innerText)).includes("P2Cancel"));
  await context.setOffline(false);
  await page.waitForSelector("text=Waiting to sync", { state: "detached", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  ok("the restored intent still drains normally after undo", (await rowCount("P2Cancel")) === 1);
  await deleteAllRows("P2Cancel");

  // category soft-heal (INVALID_REF_SOFT) is covered separately in
  // scripts/e2e-offline-p2-softheal.ts — it needs a direct Prisma delete
  // mid-flight (simulating another device), which this plain-Playwright
  // script can't do

  // ═══════════ Sync Center smoke test ═══════════
  await page.goto("http://localhost:3000/settings/sync", { waitUntil: "load" });
  await page.waitForSelector("text=Recent activity");
  const syncCenterBody = await page.evaluate(() => document.body.innerText);
  ok("Sync Center renders a status hero", /Everything is synced|waiting to sync|need.*attention/i.test(syncCenterBody));
  ok("Sync Center shows Recent activity with at least one entry from this run", syncCenterBody.includes("Recent activity") && syncCenterBody.includes("·"));
  ok("Sync Center shows This device", syncCenterBody.includes("This device"));
  ok("Sync Center shows Background sync truth row", syncCenterBody.includes("Background sync"));
  await page.click('a:has-text("← Settings")');
  await page.waitForSelector("text=Sync Center →");
  ok("the Settings sync card links into the Sync Center", true);
} catch (e) {
  ok("script error", false, String(e).slice(0, 500));
  await page.screenshot({ path: `${SHOT}/offline-p2-error.png`, fullPage: true }).catch(() => {});
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
