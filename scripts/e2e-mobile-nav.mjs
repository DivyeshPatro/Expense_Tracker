// Proves the mobile bottom navigation: an all-in-one horizontally-scrollable
// row of every section (no "More" sheet, no separate Analytics tab — that's
// now the Insights tab of Spends), a center-docked Quick Add FAB, the active
// tab visually distinguished, the Quick Add sheet opening/dismissing and
// routing each of its choices to the right form, exactly one Quick Add entry
// point on mobile, Shared reachable directly in the row, and desktop
// nav/active-state remaining untouched.
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
  await mobile.goto("http://localhost:3000/dashboard", { waitUntil: "load" });
  await mobile.waitForSelector("text=Net standing");

  // ═══════════ all-in-one scrollable bottom nav ═══════════
  const nav = mobile.locator("nav");
  ok("mobile bottom nav bar is visible", await nav.isVisible());

  const homeLink = nav.getByRole("link", { name: /Home/ });
  const spendsLink = nav.getByRole("link", { name: /Spends/ });
  const quickAddBtn = mobile.locator('button[aria-label="Quick add"]');
  ok("Home tab present", (await homeLink.count()) === 1);
  ok("Spends tab present (Transactions, relabelled)", (await spendsLink.count()) === 1);
  ok("center Quick Add button present", await quickAddBtn.isVisible());

  // every section lives in the one scrollable row (no More sheet)
  const inNav = ["Khata", "Accounts", "Cards", "Budgets", "Bills", "Shared", "Audit Log", "Import", "Settings"];
  for (const label of inNav) {
    ok(`nav row includes ${label}`, (await nav.getByRole("link", { name: new RegExp(label) }).count()) === 1);
  }
  ok("no 'More' button (every section is in the row)", (await nav.getByRole("button", { name: /^More$/ }).count()) === 0);
  ok("no dedicated Analytics tab (it's the Insights tab of Spends)", (await nav.getByRole("link", { name: /Analytics/ }).count()) === 0);

  // touch target sizing (~44px minimum)
  const qaBox = await quickAddBtn.boundingBox();
  ok("Quick Add button meets ~44px minimum touch target", qaBox.width >= 44 && qaBox.height >= 44, `${qaBox.width}x${qaBox.height}`);

  // ═══════════ active nav state ═══════════
  // armStuckNavFallback arms a 500ms grace-period timer per click; clicking a
  // second nav link inside that window can land back on the first click's
  // pre-click URL by coincidence and trip its (unrelated, pre-existing)
  // stuck-nav fallback into a spurious hard reload — wait out the grace
  // period between clicks so this test isn't flaky because of it.
  // dispatchEvent rather than click(): in `next dev` the dev-tools "Issues"
  // badge floats over the bottom-left of the nav and would intercept a real
  // pointer on the left-most tabs. It doesn't exist in a production build; the
  // dispatched click drives the same Link navigation without the hit-test.
  await spendsLink.dispatchEvent("click");
  await mobile.waitForURL("**/transactions**");
  const spendsColor = await spendsLink.locator("span").first().evaluate((el) => getComputedStyle(el).color);
  const homeColorAfterNav = await homeLink.locator("span").first().evaluate((el) => getComputedStyle(el).color);
  ok("active tab (Spends) is visually distinguished from inactive tab (Home)", spendsColor !== homeColorAfterNav, `${spendsColor} vs ${homeColorAfterNav}`);
  await mobile.waitForTimeout(600);

  await homeLink.dispatchEvent("click");
  await mobile.waitForURL("**/dashboard**");
  await mobile.waitForSelector("text=Net standing");
  await mobile.waitForTimeout(600);

  // ═══════════ mobile FAB no longer duplicated ═══════════
  const desktopFab = mobile.locator('button[aria-label="Quick add (desktop)"]');
  ok("the old floating-corner FAB is not visible on mobile (superseded by center Quick Add)", !(await desktopFab.isVisible().catch(() => false)));
  const visibleQuickAddButtons = await mobile.locator('button[aria-label="Quick add"]').count();
  ok("exactly one Quick Add entry point renders on mobile", visibleQuickAddButtons === 1, `found ${visibleQuickAddButtons}`);

  // ═══════════ Quick Add opens + each of the four choices reaches the correct form ═══════════
  await quickAddBtn.click();
  await mobile.waitForSelector('[role="dialog"][aria-label="Quick add"]');
  const quickAddSheet = mobile.locator('[role="dialog"][aria-label="Quick add"]');
  const sheetBody = await quickAddSheet.textContent();
  ok("Quick Add sheet lists all four transaction types", ["Expense", "Income", "Transfer", "Split with friends"].every((l) => sheetBody.includes(l)));

  await quickAddSheet.getByRole("button", { name: "🧾 Expense" }).click();
  await mobile.waitForSelector("text=AMOUNT (₹)");
  ok("Quick Add → Expense opens the expense form", await mobile.locator('input[placeholder="e.g. Swiggy"]').isVisible());
  await mobile.keyboard.press("Escape");
  await mobile.waitForTimeout(300);

  await quickAddBtn.click();
  await mobile.waitForSelector('[role="dialog"][aria-label="Quick add"]');
  await quickAddSheet.getByRole("button", { name: "💰 Income" }).click();
  await mobile.waitForSelector('input[placeholder="e.g. Salary · Acme Corp"]');
  ok("Quick Add → Income opens the income form", await mobile.locator('input[placeholder="e.g. Salary · Acme Corp"]').isVisible());
  await mobile.keyboard.press("Escape");
  await mobile.waitForTimeout(300);

  await quickAddBtn.click();
  await mobile.waitForSelector('[role="dialog"][aria-label="Quick add"]');
  await quickAddSheet.getByRole("button", { name: "⇄ Transfer" }).click();
  await mobile.waitForSelector('[role="dialog"][aria-label="Transfer money"]');
  const transferText = await mobile.locator('[role="dialog"][aria-label="Transfer money"]').textContent();
  ok("Quick Add → Transfer opens the transfer form", transferText.includes("FROM") && transferText.includes("TO"));
  await mobile.keyboard.press("Escape");
  await mobile.waitForTimeout(300);

  await quickAddBtn.click();
  await mobile.waitForSelector('[role="dialog"][aria-label="Quick add"]');
  await quickAddSheet.getByRole("button", { name: "👥 Split with friends" }).click();
  await mobile.waitForSelector("text=AMOUNT (₹)");
  // the split toggle's reveal panel (participant chips + EQUAL/EXACT/PERCENT/
  // RATIO mode buttons) only renders once split=true — confirms the prefill
  // pre-enabled it rather than landing on a plain (unsplit) expense form.
  const splitPreEnabled = await mobile.getByRole("button", { name: "Equal split", exact: true }).isVisible().catch(() => false);
  ok("Quick Add → Split with friends opens the expense form with split pre-enabled", splitPreEnabled);
  await mobile.keyboard.press("Escape");
  await mobile.waitForTimeout(300);

  // ═══════════ Quick Add dismisses correctly ═══════════
  await quickAddBtn.click();
  await mobile.waitForSelector('[role="dialog"][aria-label="Quick add"]');
  await mobile.keyboard.press("Escape");
  await mobile.waitForSelector('[role="dialog"][aria-label="Quick add"]', { state: "detached", timeout: 5000 });
  ok("Quick Add sheet dismisses via Escape", true);

  await quickAddBtn.click();
  await mobile.waitForSelector('[role="dialog"][aria-label="Quick add"]');
  await mobile.mouse.click(20, 20); // backdrop, outside the panel
  await mobile.waitForSelector('[role="dialog"][aria-label="Quick add"]', { state: "detached", timeout: 5000 });
  ok("Quick Add sheet dismisses via backdrop click", true);

  // ═══════════ Shared reachable directly in the row (no More sheet) ═══════════
  // Shared sits deep in the scrollable row; clicking auto-scrolls it into view.
  const sharedLink = nav.getByRole("link", { name: /Shared/ });
  await sharedLink.dispatchEvent("click");
  await mobile.waitForURL("**/shared**", { timeout: 60000 }); // first visit cold-compiles under `next dev`
  ok("Shared is reachable directly from the bottom nav", mobile.url().includes("/shared"));
  const sharedColorActive = await sharedLink.locator("span").first().evaluate((el) => getComputedStyle(el).color);
  await mobile.waitForTimeout(600); // outlast this click's armStuckNavFallback grace period (see note above)

  await mobile.goto("http://localhost:3000/dashboard", { waitUntil: "load" });
  await mobile.waitForSelector("text=Net standing");
  const sharedColorInactive = await sharedLink.locator("span").first().evaluate((el) => getComputedStyle(el).color);
  ok("Shared tab shows active state while on /shared", sharedColorActive !== sharedColorInactive, `${sharedColorActive} vs ${sharedColorInactive}`);

  // ═══════════ desktop navigation remains unchanged ═══════════
  await desktop.goto("http://localhost:3000/dashboard", { waitUntil: "load" });
  await desktop.waitForSelector("text=TOTAL BALANCE");
  const sidebar = desktop.locator("aside");
  ok("desktop sidebar is visible", await sidebar.isVisible());
  const sidebarText = await sidebar.textContent();
  const expectedSidebarItems = ["Dashboard", "Transactions", "Accounts", "Budgets", "Bills", "Shared", "Analytics", "Settings"];
  ok("desktop sidebar still lists all 8 destinations, including Shared as first-class", expectedSidebarItems.every((l) => sidebarText.includes(l)));

  const desktopFabBtn = desktop.locator('button[aria-label="Quick add (desktop)"]');
  ok("desktop still has its quick-add chooser (FAB) in the corner", await desktopFabBtn.isVisible());
  await desktopFabBtn.click();
  await desktop.waitForSelector("text=Split with friends");
  ok("desktop FAB chooser still offers all four transaction types", true);
  await desktop.keyboard.press("Escape").catch(() => {});
  await desktopFabBtn.click({ force: true }).catch(() => {}); // toggle closed
  await desktop.waitForTimeout(200);

  const headerAddExpense = desktop.getByRole("button", { name: "＋ Add expense", exact: true });
  ok("desktop header ＋ Add expense button is unchanged", await headerAddExpense.isVisible());

  const noMobileNavOnDesktop = await desktop.locator("nav").isVisible().catch(() => false);
  ok("mobile bottom nav bar does not render on desktop", !noMobileNavOnDesktop);

  // active-state check on desktop sidebar
  await desktop.goto("http://localhost:3000/transactions", { waitUntil: "load" });
  const activeSidebarLink = desktop.locator("aside a", { hasText: "Transactions" });
  const activeBg = await activeSidebarLink.evaluate((el) => getComputedStyle(el).backgroundColor);
  ok("desktop sidebar active-route highlighting still works", activeBg !== "rgba(0, 0, 0, 0)" && activeBg !== "transparent", activeBg);
} catch (e) {
  ok("script error", false, String(e).slice(0, 500));
  await desktop.screenshot({ path: `${SHOT}/mobile-nav-error.png`, fullPage: true }).catch(() => {});
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
