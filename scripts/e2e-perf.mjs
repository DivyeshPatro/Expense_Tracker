// Proves the performance refactor: category rename/delete (Settings), and
// that the transactions list actually paginates server-side rather than
// loading everything (against the ~2900-row stress file).
import { chromium } from "playwright-core";

const SHOT = "/tmp/claude-0/-home-claude/a52814cf-53bd-5151-b67d-905c3e82b1dd/scratchpad";
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

try {
  await page.goto("http://localhost:3000/sign-in");
  await page.fill('input[type="email"]', "arjun@ledgerly.app");
  await page.fill('input[type="password"]', "ledgerly-demo");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 15000 });

  // ── Category rename ──
  await page.goto("http://localhost:3000/settings");
  await page.waitForSelector("text=Categories");
  await page.click('button:has-text("🍔 Food")');
  await page.waitForSelector('input[value="Food"]');
  await page.fill('input[value="Food"]', "Eating Out");
  await page.click('button:has-text("Save")');
  await page.waitForSelector("text=Category renamed");
  await page.waitForSelector('button:has-text("Eating Out")', { timeout: 8000 });
  const afterRename = await page.textContent("body");
  ok("category rename applies and reflects in Settings", afterRename.includes("Eating Out") && !afterRename.includes("🍔 Food"));

  // rename back so re-runs of this script (and other e2e suites) stay consistent
  await page.click('button:has-text("Eating Out")');
  await page.waitForSelector('input[value="Eating Out"]');
  await page.fill('input[value="Eating Out"]', "Food");
  await page.click('button:has-text("Save")');
  await page.waitForSelector("text=Category renamed");

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
  await page.click("text=＋ New category");
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
  await page.setInputFiles('input[type="file"]', `${SHOT}/monito-large.csv`);
  await page.waitForSelector("text=Map your columns", { timeout: 10000 });
  await page.click("text=Continue");
  await page.waitForSelector("text=Map categories", { timeout: 8000 });
  await page.click("text=Preview import");
  await page.waitForSelector("text=/\\d+ new/", { timeout: 10000 });
  await page.click("text=/Import \\d+ transaction/");
  await page.waitForURL("**/transactions", { timeout: 20000 });

  // ── Transactions list pagination (server-side, not "load everything") ──
  await page.goto("http://localhost:3000/transactions");
  await page.waitForSelector("text=/Today|Yesterday|Jul|Mar/");
  const rowsBefore = await page.locator('button[aria-label="Delete transaction"]').count();
  ok("initial page loads a bounded page, not the whole ledger", rowsBefore <= 50, `${rowsBefore} rows on first load`);

  const hasLoadMore = await page.locator('button:has-text("Load more")').count();
  if (hasLoadMore > 0) {
    await page.click('button:has-text("Load more")');
    await page.waitForFunction(
      (before) => document.querySelectorAll('button[aria-label="Delete transaction"]').length > before,
      rowsBefore,
      { timeout: 10000 }
    ).catch(() => {});
    const rowsAfter = await page.locator('button[aria-label="Delete transaction"]').count();
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
