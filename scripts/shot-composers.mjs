// Mobile proof for the entry screens: every composer, every sheet it opens, at
// the one width the app is actually used at.
//
// Not a pass/fail suite — the assertions live in e2e:composer, e2e:entry-points
// and e2e:accessibility. This exists so the layout can be LOOKED at, because
// overflow, a chip row that wraps to three lines, or a keypad pushed under the
// fold are things a locator will never notice.
//
// Run: node scripts/db-local.mjs --shell "node scripts/shot-composers.mjs"
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:3000";
const OUT = "e2e-output/composers";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.setDefaultTimeout(30000);

const problems = [];
/** Nothing may scroll sideways, and nothing may sit below the fold. */
async function check(name) {
  // The overlay is position:fixed, so document.body's height is the page
  // BEHIND it — measure the layer that is actually on screen: the topmost
  // sheet if one is open, otherwise the composer itself.
  const m = await page.evaluate(() => {
    const dialogs = document.querySelectorAll('[role="dialog"]');
    const layer = dialogs.length ? dialogs[dialogs.length - 1] : document.querySelector("div[data-composer]");
    if (!layer) return null;
    const r = layer.getBoundingClientRect();
    return {
      overflow: layer.scrollWidth > layer.clientWidth + 1 || document.documentElement.scrollWidth > window.innerWidth,
      overflowsFold: Math.round(r.bottom) > window.innerHeight + 2 || Math.round(r.top) < -2,
      h: Math.round(r.height),
      innerH: window.innerHeight,
    };
  });
  if (!m) {
    problems.push(`${name}: nothing on screen to measure`);
  } else {
    if (m.overflow) problems.push(`${name}: horizontal overflow`);
    if (m.overflowsFold) problems.push(`${name}: extends past the fold (${m.h}px tall in ${m.innerH}px)`);
  }
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${m && !m.overflow && !m.overflowsFold ? "✓" : "✗"} ${name} · ${m ? `${m.h}/${m.innerH}px` : "not measured"}`);
}

const composer = () => page.locator("div[data-composer]");
const sheet = () => page.getByRole("dialog").last();

async function chip(name) {
  await composer().getByRole("button", { name }).click();
  await page.waitForTimeout(600);
}

try {
  await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button[type="submit"]');
  await page.waitForTimeout(1200);
  await page.fill('input[type="email"]', "arjun@ledgerly.app");
  await page.fill('input[type="password"]', "ledgerly-demo");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 30000 });
  await page.waitForTimeout(1500);

  // ── Spending ────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
  await page.getByRole("button", { name: /quick add/i }).filter({ visible: true }).first().click();
  await page.waitForTimeout(500);
  await sheet().getByRole("button", { name: /Add expense/i }).first().click();
  await composer().waitFor();
  await page.waitForTimeout(600);
  await check("01-spending-debit");

  for (const ch of "1250") {
    await composer().getByRole("button", { name: ch, exact: true }).click();
  }
  await composer().getByRole("button", { name: "Plus" }).click();
  for (const ch of "80") {
    await composer().getByRole("button", { name: ch, exact: true }).click();
  }
  await page.waitForTimeout(300);
  await check("02-spending-arithmetic");

  await chip(/^Category:|Choose a category/);
  await check("03-category-sheet");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  await composer().getByRole("button", { name: /^Repeat:|Choose a repeat/ }).click();
  await page.waitForTimeout(600);
  await sheet().getByText("Repeat this").click();
  await page.waitForTimeout(500);
  await check("04-repeat-sheet");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // After Repeat, because turning the split on withdraws the Repeat chip — a
  // rule carries no split, so the composer stops offering one, exactly as the
  // classic form did.
  await composer().getByRole("button", { name: /people ·|Choose who's splitting|Split with someone/ }).click();
  await page.waitForTimeout(700);
  if ((await sheet().locator('[role="switch"]').first().getAttribute("aria-checked")) !== "true") {
    await sheet().getByText("👥 Split with friends").first().click();
    await page.waitForTimeout(600);
  }
  await check("05-split-sheet");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await composer().getByRole("button", { name: "Close" }).click();
  await page.waitForTimeout(500);

  // ── Credit ──────────────────────────────────────────────────────────────
  await page.getByRole("button", { name: /quick add/i }).filter({ visible: true }).first().click();
  await page.waitForTimeout(500);
  await sheet().getByRole("button", { name: /Add income/i }).first().click();
  await composer().waitFor();
  await page.waitForTimeout(600);
  await check("06-spending-credit");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // ── Shared ──────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/shared`, { waitUntil: "load" });
  await page.getByRole("button", { name: /Add shared expense/i }).filter({ visible: true }).first().click();
  await composer().waitFor();
  await page.waitForTimeout(700);
  await check("07-shared-entry");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // ── Lending ─────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/lending`, { waitUntil: "load" });
  await page.getByRole("button", { name: /Lending — quick add/ }).filter({ visible: true }).first().click();
  await page.waitForTimeout(500);
  await sheet().getByRole("button", { name: /You gave money/ }).first().click();
  await page.locator("div[data-lending]").waitFor();
  await page.waitForTimeout(700);
  await check("08-lending-gave");

  await page.locator("div[data-lending]").getByRole("button", { name: /^Contact:|Choose a contact/ }).click();
  await page.waitForTimeout(600);
  await check("09-lending-contacts");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  await page.getByRole("button", { name: /Lending — quick add/ }).filter({ visible: true }).first().click();
  await page.waitForTimeout(500);
  await sheet().getByRole("button", { name: /You got money/ }).first().click();
  await page.locator("div[data-lending]").waitFor();
  await page.waitForTimeout(700);
  await check("10-lending-got");
  await page.locator("div[data-lending]").getByRole("button", { name: /^Allocation:/ }).click();
  await page.waitForTimeout(700);
  await check("11-lending-allocation");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // ── Transfer, deliberately unchanged ────────────────────────────────────
  await page.goto(`${BASE}/accounts`, { waitUntil: "load" });
  await page.getByRole("button", { name: /quick add/i }).filter({ visible: true }).first().click();
  await page.waitForTimeout(500);
  await sheet().getByRole("button", { name: /Transfer money/i }).first().click();
  await page.waitForSelector('input[placeholder="0"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/12-transfer-classic.png` });
  console.log("✓ 12-transfer-classic (classic modal, unchanged)");
} catch (e) {
  // process.exit() in `finally` discards an in-flight rejection, which once
  // let a suite print a clean pass while nothing had run. Record it instead.
  problems.push(`script error: ${String(e).slice(0, 300)}`);
} finally {
  await browser.close();
  console.log(problems.length ? `\n${problems.length} layout problems:\n  ${problems.join("\n  ")}` : "\nno layout problems at 390px");
  process.exit(problems.length ? 1 : 0);
}
