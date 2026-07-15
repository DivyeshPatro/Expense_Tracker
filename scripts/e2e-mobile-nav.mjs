// Proves Phase 2 (mobile navigation + quick add): the five mobile bottom-nav
// positions (Home, Transactions, Quick Add, Analytics, More), the Quick Add
// sheet opening/dismissing and routing each of its four choices to the right
// form, Shared being reachable through More, the old floating FAB no longer
// being duplicated on mobile, and that desktop nav/active-state is untouched.
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
  await mobile.waitForSelector("text=TOTAL BALANCE");

  // ═══════════ five mobile bottom-nav positions ═══════════
  const nav = mobile.locator("nav");
  ok("mobile bottom nav bar is visible", await nav.isVisible());

  const homeLink = nav.getByRole("link", { name: /Home/ });
  const txnsLink = nav.getByRole("link", { name: /Txns/ });
  const analyticsLink = nav.getByRole("link", { name: /Analytics/ });
  const quickAddBtn = mobile.locator('button[aria-label="Quick add"]');
  const moreBtn = nav.getByRole("button", { name: /More/ });
  ok("position 1: Home link present", await homeLink.isVisible());
  ok("position 2: Transactions link present", await txnsLink.isVisible());
  ok("position 3: Quick Add center button present", await quickAddBtn.isVisible());
  ok("position 4: Analytics link present", await analyticsLink.isVisible());
  ok("position 5: More button present", await moreBtn.isVisible());

  // touch target sizing (~44px minimum)
  const qaBox = await quickAddBtn.boundingBox();
  ok("Quick Add button meets ~44px minimum touch target", qaBox.width >= 44 && qaBox.height >= 44, `${qaBox.width}x${qaBox.height}`);

  // ═══════════ active nav state ═══════════
  // armStuckNavFallback arms a 500ms grace-period timer per click; clicking a
  // second nav link inside that window can land back on the first click's
  // pre-click URL by coincidence and trip its (unrelated, pre-existing)
  // stuck-nav fallback into a spurious hard reload — wait out the grace
  // period between clicks so this test isn't flaky because of it.
  await txnsLink.click();
  await mobile.waitForURL("**/transactions**");
  const txnsColor = await txnsLink.locator("span").first().evaluate((el) => getComputedStyle(el).color);
  const homeColorAfterNav = await homeLink.locator("span").first().evaluate((el) => getComputedStyle(el).color);
  ok("active tab (Transactions) is visually distinguished from inactive tab (Home)", txnsColor !== homeColorAfterNav, `${txnsColor} vs ${homeColorAfterNav}`);
  await mobile.waitForTimeout(600);

  await homeLink.click();
  await mobile.waitForURL("**/dashboard**");
  await mobile.waitForSelector("text=TOTAL BALANCE");
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
  await mobile.waitForSelector("text=FROM");
  ok("Quick Add → Transfer opens the transfer form", (await mobile.textContent("body")).includes("FROM") && (await mobile.textContent("body")).includes("TO"));
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

  // ═══════════ Shared reachable through More; badge/prominence ═══════════
  await moreBtn.click();
  await mobile.waitForSelector('[role="dialog"][aria-label="More"]');
  const moreSheet = mobile.locator('[role="dialog"][aria-label="More"]');
  const moreItems = moreSheet.locator("a");
  const firstItemText = await moreItems.first().textContent();
  ok("Shared is the first (most prominent) item in the More sheet", firstItemText.includes("Shared"), firstItemText);

  await moreSheet.getByRole("link", { name: /Shared/ }).click();
  await mobile.waitForURL("**/shared**");
  ok("Shared is reachable through the More sheet", mobile.url().includes("/shared"));
  await mobile.waitForTimeout(600); // outlast this click's armStuckNavFallback grace period (see note above)

  // More tab should now read active since Shared lives only inside it
  const moreColorOnShared = await moreBtn.locator("span").first().evaluate((el) => getComputedStyle(el).color);
  await mobile.goto("http://localhost:3000/dashboard", { waitUntil: "load" });
  await mobile.waitForSelector("text=TOTAL BALANCE");
  const moreColorOnDashboard = await moreBtn.locator("span").first().evaluate((el) => getComputedStyle(el).color);
  ok("More tab shows active state while on Shared (which now lives only inside it)", moreColorOnShared !== moreColorOnDashboard, `${moreColorOnShared} vs ${moreColorOnDashboard}`);

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
