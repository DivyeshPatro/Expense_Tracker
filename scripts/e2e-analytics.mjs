// Proves Phase 3 (Analytics mobile redesign): the mobile tab picker shows
// one analysis section at a time instead of one long scroll stack, the
// monthly spending chart covers more history via horizontal scroll instead
// of compressing columns, and desktop keeps the full always-visible stack
// with no tabs.
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
  await mobile.goto("http://localhost:3000/analytics", { waitUntil: "load" });
  await mobile.waitForSelector("text=AVG DAILY SPEND");

  // ═══════════ mobile: no horizontal page overflow ═══════════
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  ok("mobile Analytics page has no horizontal overflow", !overflow);

  // ═══════════ mobile: tab picker shows one section at a time ═══════════
  const tabBar = mobile.getByRole("button", { name: "Trend", exact: true }).locator("..");
  ok("mobile tab picker (Trend/Categories/Merchants) is visible", await mobile.getByRole("button", { name: "Trend", exact: true }).isVisible());

  // default tab is Trend: Balance trend + Monthly spending visible, Categories/Merchants headings not laid out
  ok("Trend tab shows Balance trend", await mobile.locator("text=Balance trend").isVisible());
  ok("Trend tab shows Monthly spending", await mobile.locator("text=Monthly spending").isVisible());
  const categoriesHeadingBox = await mobile.locator("h2", { hasText: "Categories ·" }).boundingBox();
  ok("Trend tab does not lay out the Categories section (display:contents collapses it)", categoriesHeadingBox === null);

  await mobile.getByRole("button", { name: "Categories", exact: true }).click();
  await mobile.waitForTimeout(200);
  ok("Categories tab shows the category breakdown", await mobile.locator("h2", { hasText: "Categories ·" }).isVisible());
  const trendHeadingBoxAfterSwitch = await mobile.locator("text=Balance trend").boundingBox();
  ok("switching to Categories collapses the Trend section out of layout", trendHeadingBoxAfterSwitch === null);

  await mobile.getByRole("button", { name: "Merchants", exact: true }).click();
  await mobile.waitForTimeout(200);
  ok("Merchants tab shows the top-merchants section", await mobile.locator("h2", { hasText: "Top merchants" }).isVisible());

  // even though only one tab is laid out at a time, the inactive sections'
  // text stays in the DOM (display:none, not unmounted) — this is what keeps
  // the pre-existing e2e.mjs "analytics renders trend + merchants" check
  // (a body.textContent scan) passing without modification.
  const bodyText = await mobile.textContent("body");
  ok("inactive tabs' content remains present in the DOM (not unmounted)", bodyText.includes("Balance trend") && bodyText.includes("Categories"));

  // ═══════════ mobile: monthly spending chart scrolls through more history ═══════════
  await mobile.getByRole("button", { name: "Trend", exact: true }).click();
  await mobile.waitForSelector("text=Monthly spending");
  const monthLabels = await mobile.locator("text=Monthly spending").locator("..").locator("text=/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/").count();
  ok("Monthly spending chart renders 12 months of history (not compressed to 6)", monthLabels === 12, `found ${monthLabels} month labels`);

  const scrollContainer = mobile.locator("text=Monthly spending").locator("..").locator(".overflow-x-auto");
  const isScrollable = await scrollContainer.evaluate((el) => el.scrollWidth > el.clientWidth);
  ok("Monthly spending chart's own container scrolls horizontally (not the page)", isScrollable);

  // ═══════════ desktop: full stack, no tabs ═══════════
  await desktop.goto("http://localhost:3000/analytics", { waitUntil: "load" });
  await desktop.waitForSelector("text=AVG DAILY SPEND");
  const desktopTabBarVisible = await desktop.getByRole("button", { name: "Trend", exact: true }).isVisible().catch(() => false);
  ok("desktop hides the mobile tab picker", !desktopTabBarVisible);

  const desktopBody = await desktop.textContent("body");
  ok(
    "desktop shows all four sections simultaneously (no tab-gating)",
    ["Balance trend", "Monthly spending", "Categories", "Top merchants"].every((s) => desktopBody.includes(s))
  );
  const allSectionsLaidOut = await Promise.all(
    ["Balance trend", "Monthly spending", "Top merchants"].map(async (s) => (await desktop.locator("text=" + s).first().boundingBox()) !== null)
  );
  ok("desktop lays out all sections at once (none collapsed via display:contents)", allSectionsLaidOut.every(Boolean));
} catch (e) {
  ok("script error", false, String(e).slice(0, 500));
  await desktop.screenshot({ path: `${SHOT}/analytics-error.png`, fullPage: true }).catch(() => {});
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
