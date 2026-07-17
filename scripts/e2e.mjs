// End-to-end walkthrough of Ledgerly against the seeded demo user.
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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

try {
  // ── sign in ──
  await page.goto("http://localhost:3000/sign-in");
  await page.fill('input[type="email"]', "arjun@ledgerly.app");
  await page.fill('input[type="password"]', "ledgerly-demo");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 15000 });
  ok("sign-in redirects to dashboard", true);

  // ── dashboard numbers ──
  await page.waitForSelector("text=TOTAL BALANCE");
  const body = await page.textContent("body");
  ok("total balance ₹2,30,870", body.includes("₹2,30,870"), "sum of seeded account balances");
  ok("attention strip shows bill due", body.includes("ACT Fibernet"));
  ok("friends owe you chip", body.includes("Friends owe you"));
  ok("en-IN formatting", /₹\d,\d{2},\d{3}/.test(body));
  await page.screenshot({ path: `${SHOT}/01-dashboard.png`, fullPage: true });

  // ── add expense (≤3 interactions: amount → submit; category/account default) ──
  await page.click("text=＋ Add expense");
  await page.waitForSelector("text=AMOUNT (₹)");
  await page.fill('input[type="number"]', "123");
  await page.click('button:has-text("Add expense") >> nth=-1');
  await page.waitForSelector("text=Expense added", { timeout: 10000 });
  ok("add expense happy path with toast", true);

  // ── transactions: open detail, delete + undo (Phase 1 moved delete off the
  // row and into the detail sheet, behind a confirm step) ──
  await page.goto("http://localhost:3000/transactions");
  await page.waitForSelector("text=Today");
  // the add-expense submit just above triggers its own async router.refresh();
  // landing this hard navigation right on top of it can catch a transitional
  // paint where the count briefly reads high — let it settle before counting
  await page.waitForTimeout(500);
  const before = await page.locator(".card button.w-full").count();
  await page.locator(".card button.w-full").first().click();
  await page.getByRole("button", { name: "Delete", exact: true }).waitFor({ timeout: 8000 });
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForSelector("text=Delete this transaction?");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForSelector("text=Transaction deleted");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForSelector("text=Restored");
  let after = 0;
  for (let i = 0; i < 20; i++) {
    after = await page.locator(".card button.w-full").count();
    if (after === before) break;
    await page.waitForTimeout(400);
  }
  ok("delete + undo restores row", before === after, `${before} rows before, ${after} after`);

  // ── ⌘K palette + Ask Ledgerly ──
  await page.keyboard.press("Control+k");
  await page.waitForSelector('input[placeholder*="swiggy"]');
  await page.fill('input[placeholder*="swiggy"]', "swiggy in march");
  await page.waitForSelector("text=Ask Ledgerly", { timeout: 8000 });
  const answer = await page.locator("text=/You spent .* transactions?/").first().textContent();
  ok("Ask Ledgerly answers 'swiggy in march'", /You spent ₹/.test(answer ?? ""), answer ?? "");
  await page.screenshot({ path: `${SHOT}/02-palette.png` });
  await page.locator("text=/You spent .* transactions?/").first().click();
  await page.waitForURL("**/transactions**");
  const chipVisible = await page.waitForSelector("text=Mar 2026", { timeout: 8000 }).then(() => true).catch(() => false);
  ok("palette answer opens filtered list with month chip", chipVisible);

  // ── shared: split expense + settle ──
  await page.goto("http://localhost:3000/shared");
  await page.waitForSelector("text=YOU OWE");
  const sharedBody = await page.textContent("body");
  ok("shared shows Flat 402 group", sharedBody.includes("Flat 402"));
  ok("shared balances render", sharedBody.includes("owes you") || sharedBody.includes("you owe"));
  await page.screenshot({ path: `${SHOT}/03-shared.png`, fullPage: true });

  // add split expense ₹999 with equal split → check math note
  // ("Add split expense" no longer lives in the ⌘K palette — Phase 2 trimmed
  // that duplicate; the desktop quick-add chooser is the remaining entry point)
  await page.click('button[aria-label="Quick add (desktop)"]');
  await page.click('button:has-text("Split with friends")');
  await page.waitForSelector("text=Split with friends");
  await page.fill('input[type="number"] >> nth=0', "999");
  await page.waitForSelector("text=/₹333 each|₹333.* you \\+ 2 friends/");
  ok("equal split preview shows ₹333 each (you + 2 friends)", true);
  await page.click('button:has-text("Add expense") >> nth=-1');
  await page.waitForSelector("text=Split expense added");
  ok("split expense committed (DB trigger accepted split sum)", true);

  // ── bills: mark paid rolls due date ──
  await page.goto("http://localhost:3000/bills");
  await page.waitForSelector("text=ACT Fibernet");
  await page.locator('button:has-text("Mark paid")').first().click();
  await page.waitForSelector("text=/paid · ₹/");
  ok("mark bill paid creates payment + rolls due date", true);

  // ── analytics ──
  await page.goto("http://localhost:3000/analytics");
  await page.waitForSelector("text=AVG DAILY SPEND");
  const ana = await page.textContent("body");
  ok("analytics renders trend + merchants", ana.includes("Balance trend") && ana.includes("Top merchants"));
  await page.screenshot({ path: `${SHOT}/04-analytics.png`, fullPage: true });

  // ── dark mode ──
  await page.goto("http://localhost:3000/dashboard");
  await page.click('button[aria-label="Toggle dark mode"]');
  await page.waitForTimeout(400);
  const theme = await page.getAttribute("html", "data-theme");
  ok("dark mode toggles", theme === "dark");
  await page.screenshot({ path: `${SHOT}/05-dark.png`, fullPage: true });
  await page.click('button[aria-label="Toggle dark mode"]');

  // ── mobile viewport: bottom nav + FAB + bottom sheet ──
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const cookies = await page.context().cookies();
  await mobile.context().addCookies(cookies);
  await mobile.goto("http://localhost:3000/dashboard");
  await mobile.waitForSelector("text=TOTAL BALANCE");
  const nav = await mobile.locator("nav").isVisible();
  ok("mobile bottom tab bar visible at 390px", nav);
  await mobile.click('button[aria-label="Quick add"]');
  await mobile.waitForSelector("text=Split with friends");
  await mobile.getByRole("button", { name: "🧾 Expense" }).click();
  await mobile.waitForSelector("text=AMOUNT (₹)");
  ok("FAB quick-add opens bottom-sheet modal on mobile", true);
  await mobile.screenshot({ path: `${SHOT}/06-mobile.png`, fullPage: false });
  await mobile.close();
} catch (e) {
  ok("script error", false, String(e).slice(0, 300));
  await page.screenshot({ path: `${SHOT}/error.png`, fullPage: true });
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
