// Proves Phase 4 (Dashboard mobile redesign): mobile home is trimmed to
// balance hero + this month's spend + a single most-urgent attention item +
// recent transactions, with cash flow/accounts/category donut/full bills/
// settlements/budgets hidden (they already have their own pages); desktop
// keeps the original full stack unchanged.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(SCRIPT_DIR, "..", "e2e-output");
fs.mkdirSync(SHOT, { recursive: true });
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const browser = await chromium.launch({ headless: true });
const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 } });
desktop.setDefaultTimeout(15000);

try {
  await desktop.goto("http://localhost:3000/sign-in");
  await desktop.fill('input[type="email"]', "arjun@ledgerly.app");
  await desktop.fill('input[type="password"]', "ledgerly-demo");
  await desktop.click('button[type="submit"]');
  await desktop.waitForURL("**/dashboard", { timeout: 15000 });
  const cookies = await desktop.context().cookies();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.setDefaultTimeout(15000);
  await mobile.context().addCookies(cookies);

  // ═══════════ mobile: no horizontal overflow, reduced scroll depth ═══════════
  await mobile.goto("http://localhost:3000/dashboard", { waitUntil: "load" });
  await mobile.waitForSelector("text=TOTAL BALANCE");
  // right after a fresh db:seed the first request can still be settling
  // (font swap, hydration) when this runs as part of e2e:all — give layout a
  // moment to stabilize before measuring, same as elsewhere in this suite.
  await mobile.waitForTimeout(300);
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  ok("mobile Dashboard has no horizontal overflow", !overflow);
  const screens = await mobile.evaluate(() => document.body.scrollHeight / window.innerHeight);
  ok("mobile Dashboard scroll depth is well under the audited ~2.8 screens", screens < 1.6, `${screens.toFixed(2)} screens`);

  // ═══════════ mobile: only the 4 audited sections are laid out ═══════════
  // Note: `hidden md:block` keeps an element in the DOM (just display:none),
  // so "not laid out" must be checked via boundingBox() (null when not
  // rendered), never via count()/isVisible-on-a-locator-that-may-not-exist —
  // a hidden element still satisfies both of those.
  ok("mobile shows the balance hero", await mobile.locator("text=TOTAL BALANCE").isVisible());
  const expenseCardBox = await mobile.locator("div", { hasText: /^EXPENSE ·/ }).first().boundingBox().catch(() => null);
  ok("mobile shows this month's spend (Expense card)", expenseCardBox !== null);
  ok("mobile shows Recent transactions", await mobile.locator("h2", { hasText: "Recent transactions" }).isVisible());

  const hiddenOnMobile = ["Cash flow", "Spending by category", "Upcoming bills", "Settlements", "Budgets"];
  for (const label of hiddenOnMobile) {
    const box = await mobile.locator("h2", { hasText: label }).first().boundingBox().catch(() => null);
    ok(`mobile does not lay out "${label}" (already has its own page)`, box === null);
  }
  // exact match — the balance hero's own "Carry forward ₹…"/"+ Income ₹…"
  // summary line would otherwise substring-collide with these stat-card labels
  const carryForwardBox = await mobile.getByText("CARRY FORWARD", { exact: true }).boundingBox().catch(() => null);
  ok("mobile does not lay out the Carry forward stat card", carryForwardBox === null);
  const incomeCardBox = await mobile.locator("div", { hasText: /^INCOME ·/ }).first().boundingBox().catch(() => null);
  ok("mobile does not lay out the Income stat card", incomeCardBox === null);

  // ═══════════ desktop: full stack unchanged ═══════════
  await desktop.waitForSelector("text=TOTAL BALANCE");
  const desktopSections = ["Cash flow", "Accounts", "Spending by category", "Upcoming bills", "Settlements", "Recent transactions", "Budgets"];
  for (const label of desktopSections) {
    ok(`desktop still shows "${label}"`, await desktop.locator("h2", { hasText: label }).first().isVisible());
  }
  ok("desktop still shows the Carry forward stat card", await desktop.getByText("CARRY FORWARD", { exact: true }).isVisible());
  ok("desktop still shows the Income stat card", await desktop.locator("text=/^INCOME ·/").first().isVisible());

  // ═══════════ mobile attention item: priority logic (bill due today beats no attention) ═══════════
  // fresh seed has nothing urgent in the current period, so the slot is
  // legitimately empty until something urgent exists — create a one-off bill
  // due today (urgency "urgent") to exercise the actual priority computation,
  // then mark it paid (which retires a one-off bill from listBills) to leave
  // the demo account as it found it.
  await desktop.goto("http://localhost:3000/bills", { waitUntil: "load" });
  await desktop.click('button:has-text("＋ New bill")');
  await desktop.waitForSelector('input[placeholder="e.g. ACT Fibernet"]');
  await desktop.fill('input[placeholder="e.g. ACT Fibernet"]', "E2EDashboardBill");
  await desktop.fill('input[placeholder="0"]', "500");
  await desktop.selectOption('select:near(:text("REPEATS"))', { label: "One-off" }).catch(async () => {
    await desktop.locator("select").last().selectOption({ label: "One-off" });
  });
  await desktop.getByRole("button", { name: "Add bill", exact: true }).click();
  await desktop.waitForSelector("text=Bill added");
  await desktop.waitForTimeout(500);

  await mobile.goto("http://localhost:3000/dashboard", { waitUntil: "load" });
  await mobile.waitForSelector("text=TOTAL BALANCE");
  // both the mobile single-item chip (md:hidden) and the desktop full strip
  // (hidden md:flex) render server-side and share this bill's text — CSS
  // decides which is actually visible at runtime, so scope to the mobile one
  const attentionLink = mobile.locator("a.md\\:hidden", { hasText: "E2EDashboardBill" });
  ok("a bill due today surfaces as the mobile attention item", await attentionLink.isVisible());
  const attentionHref = await attentionLink.getAttribute("href");
  ok("the attention item links to Bills", attentionHref === "/bills");

  // clean up: mark the one-off bill paid so it drops out of listBills entirely
  await desktop.goto("http://localhost:3000/bills", { waitUntil: "load" });
  await desktop.waitForSelector("text=E2EDashboardBill");
  await desktop.getByRole("button", { name: "Mark paid" }).first().click();
  await desktop.waitForSelector("text=paid ·");
  await desktop.waitForTimeout(500);
  // router.refresh() lags the mutation slightly — a hard reload guarantees
  // we're checking real DB state, not a stale client-cached list
  await desktop.goto("http://localhost:3000/bills", { waitUntil: "load" });
  const stillListed = await desktop.locator("text=E2EDashboardBill").count();
  ok("test bill is retired (marked paid) and no longer listed — demo data left clean", stillListed === 0, `${stillListed} remaining`);
} catch (e) {
  ok("script error", false, String(e).slice(0, 500));
  await desktop.screenshot({ path: `${SHOT}/dashboard-error.png`, fullPage: true }).catch(() => {});
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
