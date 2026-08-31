// Mobile navigation, against the contract the app actually has.
//
// The previous version of this suite described a design #201/#202 replaced: a
// single scrollable row holding every section, labels ("Home", "Spends",
// "Khata", "Audit Log") that no longer exist, and an assertion that there is
// NO "More" button. The bar is now a fixed number of slots plus a More sheet,
// on purpose and configurably — so that assertion was the opposite of the
// intended behaviour, and repairing its selectors would have produced a suite
// that passed while asserting something false.
//
// What it tests now is the contract itself, from NAV_ITEMS and nav-prefs:
//   • the bar shows `maxTabs - 1` sections plus More (default 6 → 5 + More)
//   • every remaining section is reachable through the More sheet
//   • navigation works from both, and the sheet closes behind you
//   • the current section is marked, in the bar and in the sheet
//   • nothing is offered twice
//   • the bar is mobile-only; desktop keeps its sidebar
//
// Run: node scripts/db-local.mjs --shell "node scripts/e2e-mobile-nav.mjs"
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(SCRIPT_DIR, "..", "e2e-output");
fs.mkdirSync(SHOT, { recursive: true });

const BASE = "http://localhost:3000";
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

// The catalogue the product navigates by. Kept here as data rather than as a
// list of literals scattered through the assertions: when a module is added,
// this suite should notice it, not silently keep testing twelve of thirteen.
const DAILY = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/transactions", label: "Spending" },
  { href: "/people", label: "People" },
  { href: "/cards", label: "Cards" },
  { href: "/bills", label: "Bills" },
];
const OVERFLOW = [
  { href: "/lending", label: "Lending" },
  { href: "/shared", label: "Shared" },
  { href: "/budgets", label: "Budgets" },
  { href: "/accounts", label: "Accounts" },
  { href: "/analytics", label: "Insights" },
  { href: "/import", label: "Import" },
  { href: "/activity", label: "Activity" },
  { href: "/settings", label: "Settings" },
];

const browser = await chromium.launch({ headless: true });
const desktopCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const desktop = await desktopCtx.newPage();
desktop.setDefaultTimeout(20000);

/** The bottom bar. Mobile-only by design (`md:hidden`). */
const bar = (page) => page.locator("nav");
/** The More sheet, by its own accessible name. */
const moreSheet = (page) => page.getByRole("dialog", { name: "More sections" });

async function signIn(page) {
  await page.goto(`${BASE}/sign-in`, { waitUntil: "load" });
  await page.waitForSelector('button[type="submit"]');
  await page.waitForTimeout(800);
  await page.fill('input[type="email"]', "arjun@ledgerly.app");
  await page.fill('input[type="password"]', "ledgerly-demo");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 30000 });
}

/** Deterministic readiness: the bar's own first tab, not incidental page copy. */
async function barReady(page) {
  await bar(page).getByRole("link", { name: "Dashboard" }).first().waitFor({ state: "visible", timeout: 20000 });
}

try {
  await signIn(desktop);
  const cookies = await desktopCtx.cookies();

  const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobileCtx.addCookies(cookies);
  const mobile = await mobileCtx.newPage();
  mobile.setDefaultTimeout(20000);

  await mobile.goto(`${BASE}/dashboard`, { waitUntil: "load" });
  await barReady(mobile);

  // ═══════════ the bar: a fixed number of slots, plus More ═══════════
  ok("the bottom navigation bar is present on mobile", await bar(mobile).isVisible());

  const barLinks = await bar(mobile).getByRole("link").evaluateAll((els) =>
    els.map((e) => ({ href: e.getAttribute("href")?.split("?")[0], label: e.textContent?.trim() }))
  );
  ok(
    "the bar shows the five daily sections, in catalogue order",
    barLinks.length === DAILY.length && DAILY.every((d, i) => barLinks[i].href === d.href),
    barLinks.map((l) => l.href).join(", ")
  );

  const moreButton = bar(mobile).getByRole("button", { name: "More sections" });
  ok("the bar reserves its last slot for More", (await moreButton.count()) === 1);
  ok("More is announced as opening a dialog", (await moreButton.getAttribute("aria-haspopup")) === "dialog");

  // Every section is reachable: nothing may fall out of both surfaces.
  await moreButton.click();
  await moreSheet(mobile).waitFor({ state: "visible" });
  const sheetLinks = await moreSheet(mobile).getByRole("link").evaluateAll((els) =>
    els.map((e) => e.getAttribute("href")?.split("?")[0])
  );
  ok(
    "the More sheet holds every section the bar could not fit",
    OVERFLOW.every((o) => sheetLinks.includes(o.href)) && sheetLinks.length === OVERFLOW.length,
    sheetLinks.join(", ")
  );

  const barHrefs = barLinks.map((l) => l.href);
  ok(
    "no section is offered in both the bar and the sheet",
    sheetLinks.every((h) => !barHrefs.includes(h)),
    sheetLinks.filter((h) => barHrefs.includes(h)).join(", ") || "no overlap"
  );
  await mobile.screenshot({ path: path.join(SHOT, "mobile-nav-more-sheet.png") });

  // ═══════════ the sheet closes, both ways ═══════════
  await mobile.keyboard.press("Escape");
  await moreSheet(mobile).waitFor({ state: "detached" });
  ok("Escape closes the More sheet", true);

  await moreButton.click();
  await moreSheet(mobile).waitFor({ state: "visible" });
  // Tap the backdrop: the sheet's panel is centred, so the very top of the
  // overlay is backdrop on any viewport.
  await mobile.mouse.click(195, 8);
  await moreSheet(mobile).waitFor({ state: "detached" });
  ok("tapping outside closes the More sheet", true);

  // ═══════════ navigating from the sheet ═══════════
  await moreButton.click();
  await moreSheet(mobile).waitFor({ state: "visible" });
  await moreSheet(mobile).getByRole("link", { name: "Shared" }).click();
  await mobile.waitForURL("**/shared**", { timeout: 20000 });
  ok("a section opens from the More sheet", mobile.url().includes("/shared"));
  await moreSheet(mobile).waitFor({ state: "detached", timeout: 10000 });
  ok("the sheet closes behind you rather than covering where you landed", true);

  // ═══════════ the current section is marked ═══════════
  await barReady(mobile);
  const moreActiveWhileInside = await bar(mobile)
    .getByRole("button", { name: "More sections" })
    .evaluate((el) => getComputedStyle(el.querySelector("span")).color);
  await moreButton.click();
  await moreSheet(mobile).waitFor({ state: "visible" });
  const sharedCurrent = await moreSheet(mobile).getByRole("link", { name: "Shared" }).getAttribute("aria-current");
  ok("the sheet marks the section you are on", sharedCurrent === "page", String(sharedCurrent));
  const budgetsCurrent = await moreSheet(mobile).getByRole("link", { name: "Budgets" }).getAttribute("aria-current");
  ok("and marks nothing else", budgetsCurrent === null, String(budgetsCurrent));
  await mobile.keyboard.press("Escape");
  await moreSheet(mobile).waitFor({ state: "detached" });

  // ═══════════ navigating from the bar, and its active state ═══════════
  await bar(mobile).getByRole("link", { name: "Spending" }).click();
  await mobile.waitForURL("**/transactions**", { timeout: 20000 });
  await barReady(mobile);
  ok("a section opens from the bar", mobile.url().includes("/transactions"));

  const spendingCurrent = await bar(mobile).getByRole("link", { name: "Spending" }).getAttribute("aria-current");
  const dashboardCurrent = await bar(mobile).getByRole("link", { name: "Dashboard" }).getAttribute("aria-current");
  ok("the bar marks the section you are on", spendingCurrent === "page", String(spendingCurrent));
  ok("and only that one", dashboardCurrent === null, String(dashboardCurrent));

  // More is highlighted whenever the section you are in lives inside it —
  // otherwise the bar would claim you are nowhere.
  const moreColorOutside = await bar(mobile)
    .getByRole("button", { name: "More sections" })
    .evaluate((el) => getComputedStyle(el.querySelector("span")).color);
  ok(
    "More itself reads as active while you are in one of its sections",
    moreActiveWhileInside !== moreColorOutside,
    `${moreActiveWhileInside} inside vs ${moreColorOutside} outside`
  );

  // ═══════════ the quick-add control ═══════════
  const fab = bar(mobile).getByRole("button", { name: /quick add|Add expense|Add bill|Add card|Add budget/i });
  ok("the bar carries exactly one quick-add control", (await fab.count()) === 1, `${await fab.count()}`);
  const fabBox = await fab.first().boundingBox();
  ok("quick add meets the ~44px touch target", fabBox.width >= 44 && fabBox.height >= 44, `${fabBox.width}x${fabBox.height}`);

  // Every tab is tappable at this width — a scrollable bar can still leave a
  // slot smaller than a fingertip.
  const tabBoxes = await bar(mobile).getByRole("link").evaluateAll((els) =>
    els.map((e) => ({ label: e.textContent?.trim(), h: Math.round(e.getBoundingClientRect().height) }))
  );
  ok(
    "every tab meets the ~44px touch target",
    tabBoxes.every((t) => t.h >= 44),
    tabBoxes.map((t) => `${t.label}:${t.h}`).join(" ")
  );

  // ═══════════ desktop keeps its sidebar, and only that ═══════════
  await desktop.goto(`${BASE}/dashboard`, { waitUntil: "load" });
  const sidebar = desktop.locator("aside");
  await sidebar.waitFor({ state: "visible" });
  ok("desktop shows the sidebar", await sidebar.isVisible());

  const sidebarHrefs = await sidebar.getByRole("link").evaluateAll((els) =>
    els.map((e) => e.getAttribute("href")?.split("?")[0])
  );
  ok(
    "the sidebar lists every section — desktop has room, so nothing overflows",
    [...DAILY, ...OVERFLOW].every((i) => sidebarHrefs.includes(i.href)),
    [...DAILY, ...OVERFLOW].filter((i) => !sidebarHrefs.includes(i.href)).map((i) => i.href).join(", ") || "all present"
  );

  ok("the mobile bar does not render on desktop", !(await bar(desktop).isVisible().catch(() => false)));
  ok("there is no More sheet on desktop — nothing overflows", (await desktop.getByRole("button", { name: "More sections" }).count()) === 0);

  await desktop.goto(`${BASE}/transactions`, { waitUntil: "load" });
  const activeSidebarLink = sidebar.getByRole("link", { name: "Spending" });
  const inactiveSidebarLink = sidebar.getByRole("link", { name: "Budgets" });
  // The sidebar signals the current section with styling rather than
  // aria-current — unlike the mobile bar and the More sheet, which both set
  // it. That asymmetry is a real (small) accessibility gap in the product and
  // is reported separately; this asserts what the product actually does today
  // rather than pretending it already sets the attribute.
  const activeBg = await activeSidebarLink.evaluate((el) => getComputedStyle(el).backgroundColor);
  const inactiveBg = await inactiveSidebarLink.evaluate((el) => getComputedStyle(el).backgroundColor);
  ok("the sidebar marks the section you are on", activeBg !== inactiveBg, `${activeBg} vs ${inactiveBg}`);
} catch (e) {
  ok("script error", false, String(e).slice(0, 500));
  await desktop.screenshot({ path: path.join(SHOT, "mobile-nav-error.png"), fullPage: true }).catch(() => {});
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
