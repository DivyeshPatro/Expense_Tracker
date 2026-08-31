// Proves the performance refactor: category rename/delete (Settings), and
// that the transactions list actually paginates server-side rather than
// loading everything (against the ~2900-row stress file).
import { chromium } from "playwright";
import { choosePeriod } from "./e2e-period.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(SCRIPT_DIR, "..", "e2e-output");
fs.mkdirSync(SHOT, { recursive: true });
const FIXTURES = path.join(SCRIPT_DIR, "..", "e2e", "fixtures");
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

// Category resolution is now forced (no silent "auto-detect" fallback): any raw
// value that doesn't already match an existing category name must be either
// mapped or created before "Preview import" unlocks. Create-on-the-spot for
// whatever's left, exactly like a user clicking through the amber-flagged rows.
async function resolveUnresolvedCategories(page) {
  for (let guard = 0; guard < 20; guard++) {
    const rows = await page.locator('div.flex.items-center.gap-2\\.5').all();
    let didWork = false;
    for (const row of rows) {
      const select = row.locator("select");
      if ((await select.count()) === 0) continue;
      if ((await select.locator('option:has-text("Create new category")').count()) === 0) continue;
      const selectedText = (await select.locator("option:checked").textContent())?.trim();
      if (selectedText === "Choose one…") {
        await select.selectOption({ label: "+ Create new category…" });
        await page.waitForSelector('input[placeholder="Category name"]');
        await row.getByRole("button", { name: "Add", exact: true }).click();
        await page.waitForTimeout(500);
        didWork = true;
        break;
      }
    }
    if (!didWork) break;
  }
}

try {
  await page.goto("http://localhost:3000/sign-in");
  await page.fill('input[type="email"]', "arjun@ledgerly.app");
  await page.fill('input[type="password"]', "ledgerly-demo");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 15000 });

  // ── Dashboard period cards (Balance / Income / Expense) ──
  // There is no separate "Carry forward" card: the period cards are Balance,
  // Income and Expense, and carry-forward is a line inside the balance hero on
  // a window that has something to carry forward from.
  await page.getByText("TOTAL BALANCE", { exact: true }).waitFor({ timeout: 15000 });
  const dashBody = await page.textContent("body");
  ok(
    "dashboard shows Balance / Income / Expense cards for the default window",
    dashBody.includes("TOTAL BALANCE") && dashBody.includes("INCOME ·") && dashBody.includes("EXPENSE ·")
  );

  await choosePeriod(page);
  await page.getByText("BALANCE · TO DATE", { exact: true }).waitFor({ timeout: 15000 });
  const allBody = await page.textContent("body");
  // All-time is the window where money that predates tracking shows up, and
  // the hero states it as a carry-forward line rather than a card.
  ok("the all-time window carries the opening balances forward", /Carry forward/i.test(allBody), (allBody.match(/Carry forward[^\n]{0,24}/i) ?? ["not found"])[0]);

  const prevKey = new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString().slice(0, 7);
  await page.goto(`http://localhost:3000/dashboard?p=${prevKey}`);
  await page.waitForSelector("text=/BALANCE · [A-Z]{3} \\d{4}/", { timeout: 8000 });
  ok("a specific past month can be selected and relabels the cards", true);

  await page.goto("http://localhost:3000/dashboard?from=2026-01-01&to=2026-03-31");
  // A custom range labels its cards "BALANCE · <range>", not "TOTAL BALANCE",
  // and there is no separate carry-forward card in any window.
  await page.getByText(/^BALANCE · .+$/).first().waitFor({ timeout: 15000 });
  const customBody = await page.textContent("body");
  ok("custom date range renders period cards", customBody.includes("balance at the end of this period"));

  // ── Category rename ──
  // Settings is an index of sub-pages; categories live under General.
  await page.goto("http://localhost:3000/settings/general");
  await page.getByRole("heading", { name: "Categories" }).waitFor({ timeout: 20000 });
  await page.click('button:has-text("🍔 Food")');
  await page.waitForSelector('input[value="Food"]');
  // Scope Save to the row being edited: the page carries a Save per section,
  // and the first on the page is the Profile one, which is disabled. React
  // sets the value PROPERTY when typing, so the [value="Food"] attribute still
  // identifies this row afterwards.
  await page.fill('input[value="Food"]', "Eating Out");
  // The only ENABLED Save is the row being edited: the Profile one above it
  // stays disabled until its own fields change, and it comes first in the DOM.
  await page.locator("button:not([disabled])").filter({ hasText: /^Save$/ }).first().click();
  await page.waitForSelector("text=Category renamed");
  await page.waitForSelector('button:has-text("Eating Out")', { timeout: 8000 });
  const afterRename = await page.textContent("body");
  ok("category rename applies and reflects in Settings", afterRename.includes("Eating Out") && !afterRename.includes("🍔 Food"));

  // rename back so re-runs of this script (and other e2e suites) stay consistent
  await page.click('button:has-text("Eating Out")');
  await page.waitForSelector('input[value="Eating Out"]');
  await page.fill('input[value="Eating Out"]', "Food");
  await page.locator("button:not([disabled])").filter({ hasText: /^Save$/ }).first().click();
  await page.waitForSelector("text=Category renamed");

  // ── Category kind switch (Expense <-> Income tabs) ──
  await page.click("text=＋ New expense category");
  await page.fill('input[placeholder="Category name"]', "KindSwitchTest");
  await page.locator('input[placeholder="Category name"]').locator('xpath=..').getByRole("button", { name: "Add", exact: true }).click();
  await page.waitForSelector("text=Category added");
  await page.click('button:has-text("📦 KindSwitchTest")');
  await page.waitForSelector('input[value="KindSwitchTest"]');
  await page.click('button:has-text("→ Income")');
  await page.waitForSelector("text=Moved to Income");
  await page.click('button:has-text("💼 Income")');
  const incomeTabBody = await page.textContent("body");
  ok("category kind switch moves it into the Income tab", incomeTabBody.includes("KindSwitchTest"));
  await page.click('button:has-text("KindSwitchTest")');
  await page.waitForSelector('input[value="KindSwitchTest"]');
  await page.locator('input[value="KindSwitchTest"]').locator('xpath=..').locator('button:has-text("Delete")').click();
  await page.waitForSelector("text=Category deleted");
  await page.click('button:has-text("💸 Expense")');

  // ── Category delete is blocked while in use ──
  await page.click('button:has-text("🍔 Food")');
  await page.waitForSelector('input[value="Food"]');
  await page.locator('input[value="Food"]').locator('xpath=..').locator('button:has-text("Delete")').click();
  await page.waitForSelector("text=/is used by/", { timeout: 8000 });
  const blockedBody = await page.textContent("body");
  ok("deleting a category still in use is blocked with a clear reason", /is used by \d+ transaction/.test(blockedBody));

  // a genuinely unused category can be deleted
  await page.screenshot({ path: `${SHOT}/perf-debug-before-add.png`, fullPage: true });
  const foodChipClose = page.locator('input[value="Food"]').locator('xpath=..').locator('button:has-text("✕")');
  if (await foodChipClose.count()) await foodChipClose.click();
  await page.waitForTimeout(200);
  await page.click("text=＋ New expense category");
  await page.fill('input[placeholder="Category name"]', "Throwaway");
  await page.locator('input[placeholder="Category name"]').locator('xpath=..').getByRole("button", { name: "Add", exact: true }).click();
  await page.waitForSelector("text=Category added");
  await page.click('button:has-text("📦 Throwaway")');
  await page.waitForSelector('input[value="Throwaway"]');
  await page.locator('input[value="Throwaway"]').locator('xpath=..').locator('button:has-text("Delete")').click();
  await page.waitForSelector("text=Category deleted", { timeout: 8000 });
  const afterDelete = await page.textContent("body");
  ok("an unused category deletes cleanly", !afterDelete.includes("Throwaway"));

  // ── Import a larger dataset so pagination actually has something to page through ──
  await page.goto("http://localhost:3000/import");
  await page.waitForSelector("text=Choose file");
  await page.setInputFiles('input[type="file"]', `${FIXTURES}/monito-large.csv`);
  await page.waitForSelector("text=Map your columns", { timeout: 10000 });
  await page.click("text=Continue");
  await page.waitForSelector("text=Map categories", { timeout: 8000 });
  await resolveUnresolvedCategories(page);
  await page.click("text=Preview import");
  await page.waitForSelector("text=/\\d+ new/", { timeout: 10000 });
  await page.click("text=/Import \\d+ transaction/");
  await page.waitForURL("**/transactions", { timeout: 20000 });

  // ── Transactions list pagination (server-side, not "load everything") ──
  // Transactions defaults to "this month" now (the shared period picker) —
  // the large import's history is scattered across years, so "To date" is
  // needed to actually see enough rows for a pagination check.
  await page.goto("http://localhost:3000/transactions?p=all");
  // Which months actually appear depends on the current date and on what
  // e2e-import.mjs (which clears the seed's current-month data earlier in
  // the documented e2e:all sequence) left behind — match any date-group
  // heading rather than hardcoding specific months.
  await page.waitForSelector("text=/Today|Yesterday|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/");
  // Phase 1 replaced the per-row delete button with a plain tappable row
  // (`.card button.w-full`, opening the transaction detail sheet) — count
  // those instead of the now-removed `[aria-label="Delete transaction"]`.
  const rowsBefore = await page.locator(".card button.w-full").count();
  ok("initial page loads a bounded page, not the whole ledger", rowsBefore <= 50, `${rowsBefore} rows on first load`);

  const hasLoadMore = await page.locator('button:has-text("Load more")').count();
  if (hasLoadMore > 0) {
    await page.click('button:has-text("Load more")');
    await page.waitForFunction(
      (before) => document.querySelectorAll(".card button.w-full").length > before,
      rowsBefore,
      { timeout: 10000 }
    ).catch(() => {});
    const rowsAfter = await page.locator(".card button.w-full").count();
    ok("'Load more' fetches the next page and appends rows", rowsAfter > rowsBefore, `${rowsBefore} -> ${rowsAfter}`);
  } else {
    ok("'Load more' fetches the next page and appends rows", false, "no Load more button found — dataset too small for this check");
  }

  // tab switch triggers a fresh server-side query
  await page.click('button:has-text("Income")');
  await page.waitForTimeout(500);
  const incomeBody = await page.textContent("body");
  ok("switching tabs re-queries server-side (Income tab shows income rows)", incomeBody.includes("Salary") || incomeBody.includes("+₹"));
} catch (e) {
  ok("script error", false, String(e).slice(0, 400));
  await page.screenshot({ path: `${SHOT}/perf-error.png`, fullPage: true });
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
