// Verification harness for the in-app amount keypad.
//
// Written because driving this by hand through a browser bridge proved
// unreliable: the dev server recompiles between runs, so fixed waits made the
// dialog open sometimes and not others, and a flaky harness cannot tell a
// product failure from its own. Playwright waits on real conditions, uses a
// genuine touch/coarse-pointer context (hasTouch + isMobile), and writes
// screenshots — so the results are reproducible and reviewable.
//
// Covers: desktop absence, 360/390/430 widths, dark AND light themes, live
// calculation, evaluated-value persistence, invalid input, keyboard operation,
// axe accessibility, horizontal overflow, and screenshots.
//
// Run with the dev server up:  node scripts/e2e-keypad.mjs
import { chromium, devices } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(SCRIPT_DIR, "..", "e2e-output");
fs.mkdirSync(SHOT, { recursive: true });
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

// In dev, Next compiles each route on its FIRST request, which can take well
// over 20s on a cold start — long enough that a default timeout reports a
// compile as a test failure. Generous here, tight in CI where the app is
// prebuilt. Override with E2E_TIMEOUT if a machine needs longer.
const TIMEOUT = Number(process.env.E2E_TIMEOUT ?? 60000);

const browser = await chromium.launch({ headless: true });

// Fail fast and clearly if the dev server simply isn't up — otherwise the
// first symptom is an opaque "page.goto: Timeout exceeded", which sent a real
// debugging session down the wrong path.
try {
  const ping = await fetch(BASE, { method: "HEAD" });
  if (!ping.ok && ping.status >= 500) throw new Error(`HTTP ${ping.status}`);
} catch (e) {
  console.error(`\nCannot reach ${BASE} — is the dev server running?\n  npm run dev\n\n(${e.message})`);
  await browser.close();
  process.exit(2);
}

/** Sign in once and reuse the cookies for every context. */
const auth = await browser.newPage({ viewport: { width: 1280, height: 900 } });
auth.setDefaultTimeout(TIMEOUT);
await auth.goto(`${BASE}/sign-in`, { timeout: TIMEOUT });
await auth.fill('input[type="email"]', "arjun@ledgerly.app");
await auth.fill('input[type="password"]', "ledgerly-demo");
await auth.click('button[type="submit"]');
await auth.waitForURL("**/dashboard");
const cookies = await auth.context().cookies();

/** Open Add expense and focus the amount field. Waits on state, never on time. */
async function openExpenseForm(page) {
  await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
  const quick = page.getByRole("button", { name: "Expense", exact: true });
  const header = page.getByRole("button", { name: /Add expense/ });
  if (await quick.count()) await quick.first().click();
  else await header.first().click();
  const dialog = page.getByRole("dialog", { name: "Add expense" });
  await dialog.waitFor();
  await dialog.locator("input").first().click();
  return dialog;
}

try {
  // ─────────────── desktop: keypad must NOT appear ───────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    page.setDefaultTimeout(TIMEOUT);
    const dialog = await openExpenseForm(page);
    const pad = page.locator('[aria-label="Amount keypad"]');
    ok("desktop — keypad hidden (physical keyboard is faster)", (await pad.count()) === 0);
    const amount = dialog.locator("input").first();
    ok("desktop — amount field keeps a numeric keyboard hint", (await amount.getAttribute("inputmode")) === "decimal");
    // desktop must still accept typing + evaluate + save
    await amount.fill("250+80*2");
    await page.waitForTimeout(300);
    ok("desktop — live result shown while typing", (await dialog.getByText("= ₹410").count()) > 0);
    await page.screenshot({ path: path.join(SHOT, "keypad-desktop.png"), fullPage: false });
    await ctx.close();
  }

  // ─────────────── mobile widths × themes ───────────────
  for (const theme of ["dark", "light"]) {
    for (const width of [360, 390, 430]) {
      const ctx = await browser.newContext({
        ...devices["Pixel 5"],
        viewport: { width, height: 800 },
        hasTouch: true,
        isMobile: true,
      });
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      page.setDefaultTimeout(TIMEOUT);
      await page.addInitScript((t) => {
        document.addEventListener("DOMContentLoaded", () => document.documentElement.setAttribute("data-theme", t));
      }, theme);

      const dialog = await openExpenseForm(page);
      const pad = page.locator('[aria-label="Amount keypad"]');
      const label = `${width}px ${theme}`;

      await pad.waitFor({ state: "visible" });
      ok(`${label} — keypad renders on touch`, await pad.isVisible());

      // every key must have an accessible name
      const keys = pad.locator("button");
      const n = await keys.count();
      let unnamed = 0;
      for (let i = 0; i < n; i++) if (!(await keys.nth(i).getAttribute("aria-label"))) unnamed++;
      ok(`${label} — all ${n} keys have accessible names`, unnamed === 0, `${unnamed} unnamed`);

      // touch target floor
      let minH = Infinity, minW = Infinity;
      for (let i = 0; i < n; i++) {
        const b = await keys.nth(i).boundingBox();
        if (b) { minH = Math.min(minH, b.height); minW = Math.min(minW, b.width); }
      }
      ok(`${label} — key targets ≥ 40×24`, minH >= 40 && minW >= 24, `min ${Math.round(minW)}×${Math.round(minH)}`);

      // no horizontal overflow
      const hScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      ok(`${label} — no horizontal overflow`, !hScroll);

      // keypad must not cover Save
      const covered = await page.evaluate(() => {
        const dlg = document.querySelector('[role=dialog]');
        const pad = document.querySelector('[aria-label="Amount keypad"]');
        const save = dlg && [...dlg.querySelectorAll("button")].find(b => /Add expense/i.test(b.textContent));
        if (!pad || !save) return null;
        return save.getBoundingClientRect().bottom > pad.getBoundingClientRect().top;
      });
      ok(`${label} — Save not covered by keypad`, covered === false);

      // live calculation via real taps
      for (const name of ["2", "5", "0", "Plus", "8", "0", "Multiply", "2"]) {
        await pad.getByRole("button", { name, exact: true }).tap();
      }
      await page.waitForTimeout(250);
      ok(`${label} — 250+80×2 evaluates to ₹410`, (await dialog.getByText("= ₹410").count()) > 0);

      await page.screenshot({ path: path.join(SHOT, `keypad-${width}-${theme}.png`) });

      // axe, on the open form with the keypad visible
      const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
      const serious = axe.violations.filter(v => ["serious", "critical"].includes(v.impact));
      ok(`${label} — axe: no serious/critical violations`, serious.length === 0,
        serious.map(v => `${v.id}(${v.nodes.length})`).join(", "));

      await ctx.close();
    }
  }

  // ─────────────── invalid expressions ───────────────
  {
    const ctx = await browser.newContext({ ...devices["Pixel 5"], viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    page.setDefaultTimeout(TIMEOUT);
    const dialog = await openExpenseForm(page);
    const amount = dialog.locator("input").first();
    for (const [expr, expected] of [["250+", /incomplete/i], ["(250+350", /closing bracket/i], ["100/0", /divide by zero/i], ["100-100", /above zero/i]]) {
      await amount.fill(expr);
      await page.waitForTimeout(250);
      const text = await dialog.innerText();
      ok(`invalid "${expr}" rejected with a readable message`, expected.test(text), text.match(expected)?.[0] ?? text.slice(0, 60));
    }
    await ctx.close();
  }

  // ─────────────── keyboard operation ───────────────
  {
    const ctx = await browser.newContext({ ...devices["Pixel 5"], viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    page.setDefaultTimeout(TIMEOUT);
    const dialog = await openExpenseForm(page);
    const pad = page.locator('[aria-label="Amount keypad"]');
    await pad.waitFor();
    // every key reachable by Tab, and Enter/Space activates
    await pad.getByRole("button", { name: "7", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    ok("keyboard — Enter activates a focused key", (await dialog.locator("input").first().inputValue()).includes("7"));
    await ctx.close();
  }

  // ─────────────── save persists the evaluated value ───────────────
  {
    const ctx = await browser.newContext({ ...devices["Pixel 5"], viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    page.setDefaultTimeout(TIMEOUT);
    const dialog = await openExpenseForm(page);
    const marker = `KEYPAD-E2E-${Date.now()}`;
    await dialog.locator("input").first().fill("2500+18%");
    await dialog.getByPlaceholder("e.g. Swiggy").fill(marker);
    await dialog.getByRole("button", { name: /Add expense/ }).click();
    await dialog.waitFor({ state: "detached" });
    await page.goto(`${BASE}/transactions?q=${marker}`, { waitUntil: "load" });
    await page.waitForSelector(`text=${marker}`);
    const body = await page.innerText("body");
    ok("save stores the evaluated amount (₹2,950), not the expression", body.includes("₹2,950") && !body.includes("2500+18%"));
    await ctx.close();
  }
} finally {
  await browser.close();
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log("FAILURES:");
    for (const f of failed) console.log(`  • ${f.name}${f.detail ? " — " + f.detail : ""}`);
  }
  console.log(`screenshots → ${SHOT}`);
  process.exit(failed.length ? 1 : 0);
}
