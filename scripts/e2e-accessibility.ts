// Accessibility suite — axe-core + keyboard-navigation + landmark checks
// against the authenticated surfaces at both desktop and mobile viewports,
// using the same real-browser + real-server pattern as the other e2e scripts.
// Run: npx tsx scripts/e2e-accessibility.ts
//
// Contrast IS gated now: Phase 2 (v2.0) darkened --acc/--green/--red/--amber/
// --mut2 to clear WCAG AA everywhere, verified at 0 nodes across every screen
// and both viewports. A regression here is a real bug, not a design call.
import { chromium, type Page } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const BASE = "http://localhost:3000";
const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

async function auditPage(page: Page, name: string) {
  const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const gating = res.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  ok(
    `${name}: no serious/critical axe violations (incl. contrast)`,
    gating.length === 0,
    gating.map((v) => `${v.id} (${v.impact}, ${v.nodes.length}x)`).join("; ")
  );
  const minor = res.violations.filter((v) => v.impact !== "critical" && v.impact !== "serious");
  if (minor.length > 0) console.log(`  (${minor.length} lower-severity: ${minor.map((v) => v.id).join(", ")})`);
}

/** No positive tabindex anywhere — it breaks the natural tab order. */
async function checkNoPositiveTabindex(page: Page, name: string) {
  const bad = await page.evaluate(() =>
    [...document.querySelectorAll("[tabindex]")].map((el) => Number(el.getAttribute("tabindex"))).filter((n) => n > 0).length
  );
  ok(`${name}: no positive tabindex (natural focus order preserved)`, bad === 0, `${bad} found`);
}

/** Every page has the landmarks + a heading a screen reader needs to navigate. */
async function checkLandmarks(page: Page, name: string) {
  const s = await page.evaluate(() => ({
    main: document.querySelectorAll("main").length,
    nav: document.querySelectorAll("nav").length,
    h1: document.querySelectorAll("h1").length,
    headings: document.querySelectorAll("h1,h2,h3").length,
  }));
  ok(`${name}: exactly one <main> landmark`, s.main === 1, `main=${s.main}`);
  ok(`${name}: a <nav> landmark present`, s.nav >= 1, `nav=${s.nav}`);
  ok(`${name}: at least one heading`, s.headings >= 1, `headings=${s.headings}`);
}

async function login(page: Page) {
  await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button[type="submit"]', { timeout: 40000 });
  await page.waitForTimeout(700);
  await page.fill('input[type="email"]', "arjun@ledgerly.app");
  await page.fill('input[type="password"]', "ledgerly-demo");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 40000 });
  await page.waitForTimeout(1200);
}

async function main() {
  const browser = await chromium.launch({ headless: true });

  // ─── Desktop (1280) ───────────────────────────────────────────────
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const dp = desktop.newPage ? await desktop.newPage() : (await desktop.pages())[0];
  dp.setDefaultTimeout(60000);
  try {
    await dp.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded" });
    await dp.waitForSelector('button[type="submit"]', { timeout: 40000 });
    await auditPage(dp, "desktop sign-in");
    await login(dp);
    for (const [name, url] of [["desktop dashboard", "/dashboard"], ["desktop transactions", "/transactions"], ["desktop lending", "/lending"], ["desktop settings", "/settings"]] as const) {
      await dp.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded" });
      await dp.waitForTimeout(1200);
      await auditPage(dp, name);
      await checkLandmarks(dp, name);
      await checkNoPositiveTabindex(dp, name);
    }

    // Skip link: first Tab from the top of the page reveals a "Skip to content"
    // link that targets the main region.
    await dp.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
    await dp.waitForTimeout(1000);
    await dp.evaluate(() => (document.activeElement as HTMLElement)?.blur?.());
    await dp.keyboard.press("Tab");
    const skip = await dp.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return { text: el?.textContent?.trim(), href: el?.getAttribute("href"), visible: el ? el.getBoundingClientRect().height > 0 : false };
    });
    ok("first Tab reveals a working 'Skip to content' link", /skip to content/i.test(skip.text ?? "") && skip.href === "#main-content" && skip.visible, JSON.stringify(skip));

    // Focus trap + Escape on the overlay that covers the app.
    //
    // Adding an expense is the full-screen composer now, which is deliberately
    // NOT role="dialog" — it is a screen, not a sheet. The obligation is the
    // same either way and is what this measures: while it is up, Tab must stay
    // inside it and Escape must close it. Anything else strands a keyboard
    // user on a sidebar they cannot see.
    await dp.getByRole("button", { name: "＋ Add expense" }).click();
    await dp.waitForSelector("div[data-composer]", { timeout: 8000 });
    await dp.waitForTimeout(400);
    let trapped = true;
    for (let i = 0; i < 30; i++) {
      await dp.keyboard.press("Tab");
      const inside = await dp.evaluate(() => {
        const screen = document.querySelector("div[data-composer]")?.parentElement ?? null;
        return !!(screen && document.activeElement && screen.contains(document.activeElement));
      });
      if (!inside) { trapped = false; break; }
    }
    ok("the full-screen composer traps Tab focus within itself", trapped);
    await dp.keyboard.press("Escape");
    await dp.waitForTimeout(300);
    ok("the composer closes on Escape", (await dp.locator("div[data-composer]").count()) === 0);

    // The sheets it opens are still real dialogs, and still have to behave.
    await dp.getByRole("button", { name: "＋ Add expense" }).click();
    await dp.waitForSelector("div[data-composer]", { timeout: 8000 });
    await dp.getByRole("button", { name: /^Category:|Choose a category/ }).click();
    await dp.waitForSelector('[role="dialog"]', { timeout: 8000 });
    ok("a picker opened from the composer is a real dialog", (await dp.locator('[role="dialog"]').count()) >= 1);
    await dp.keyboard.press("Escape");
    await dp.waitForTimeout(300);
    ok("that dialog closes on Escape", (await dp.locator('[role="dialog"]').count()) === 0);
    await dp.keyboard.press("Escape");
    await dp.waitForTimeout(300);
  } finally {
    await desktop.close();
  }

  // ─── Mobile (390) — the redesigned surfaces + a bottom sheet ───────
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mp = await mobile.newPage();
  mp.setDefaultTimeout(60000);
  try {
    await login(mp);
    for (const [name, url] of [["mobile dashboard", "/dashboard"], ["mobile transactions", "/transactions"], ["mobile bills", "/bills"], ["mobile settings", "/settings"]] as const) {
      await mp.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded" });
      await mp.waitForTimeout(1200);
      await auditPage(mp, name);
      await checkNoPositiveTabindex(mp, name);
    }
    // A bottom sheet: the Bills action sheet.
    await mp.goto(`${BASE}/bills`, { waitUntil: "domcontentloaded" });
    await mp.waitForTimeout(1500);
    await mp.locator("button:has-text('Monthly')").first().click();
    await mp.waitForSelector('[role="dialog"]', { timeout: 8000 });
    await mp.waitForTimeout(400);
    await auditPage(mp, "mobile bill action sheet");
    let trapped = true;
    for (let i = 0; i < 20; i++) {
      await mp.keyboard.press("Tab");
      const inside = await mp.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]');
        return !!(dlg && document.activeElement && dlg.contains(document.activeElement));
      });
      if (!inside) { trapped = false; break; }
    }
    ok("bottom sheet traps Tab focus", trapped);
    await mp.keyboard.press("Escape");
    await mp.waitForTimeout(300);
    ok("bottom sheet closes on Escape", (await mp.locator('[role="dialog"]').count()) === 0);
  } finally {
    await mobile.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
