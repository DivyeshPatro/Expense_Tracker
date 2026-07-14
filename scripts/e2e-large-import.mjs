// Proves the Prisma interactive-transaction-timeout fix: imports ~~475-2900 rows
// (multi-year Monito-shaped history) in one commit — well past what the
// default 5s transaction timeout could survive under the old code.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(SCRIPT_DIR, "..", "e2e-output");
fs.mkdirSync(SHOT, { recursive: true });
const CSV_PATH = path.join(SCRIPT_DIR, "..", "e2e", "fixtures", "monito-large.csv");
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(120_000);

// Category resolution is forced: every raw value that doesn't already match an
// existing category name must be mapped or created before "Preview import"
// unlocks. Create-on-the-spot for whatever's left in this large synthetic file.
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
  await page.click('button:has-text("To date")');
  await page.waitForSelector("text=BALANCE · TO DATE", { timeout: 8000 });
  const balanceBefore = (await page.textContent("body")).match(/(?:TOTAL BALANCE|BALANCE · TO DATE)(−?₹[\d,.]+)/)?.[1];

  await page.goto("http://localhost:3000/import");
  await page.waitForSelector("text=Choose file");
  await page.setInputFiles('input[type="file"]', CSV_PATH);
  await page.waitForSelector("text=Map your columns", { timeout: 15000 });

  await page.click("text=Continue");
  await page.waitForSelector("text=Map categories", { timeout: 10000 });
  await resolveUnresolvedCategories(page);
  await page.click("text=Preview import");
  await page.waitForSelector("text=/\\d+ new/", { timeout: 20000 });
  const previewBody = await page.textContent("body");
  const newMatch = previewBody.match(/(\d+) new/);
  ok("large file (~475-2900 rows) previews without error", !!newMatch, previewBody.match(/\d+ new|\d+ duplicates|\d+ invalid/g)?.join(", "));

  const start = Date.now();
  await page.click("text=/Import \\d+ transaction/");
  // this is the exact call path that used to die with "Transaction not found /
  // old closed transaction" once the per-row loop exceeded Prisma's 5s default
  await page.waitForURL("**/transactions", { timeout: 60_000 });
  const elapsed = Date.now() - start;
  ok(`large import (${newMatch?.[1] ?? "?"} rows) commits successfully without hitting the transaction timeout`, true, `${elapsed}ms`);

  const errorBody = await page.textContent("body").catch(() => "");
  ok("no Prisma transaction-timeout error surfaced anywhere on the page", !errorBody.includes("Transaction not found") && !errorBody.includes("old closed transaction"));

  // Self-cleanup: undo this script's own import so it leaves the DB the way
  // it found it. Without this, e2e-perf.mjs's own import of the same
  // monito-large.csv fixture sees every row flagged as a duplicate ("0 new")
  // when the two suites run back-to-back — this is what makes the suites
  // composable from a single documented command without a manual reseed
  // between them.
  await page.goto("http://localhost:3000/settings");
  await page.waitForSelector("text=IMPORT HISTORY");
  await page.locator('button:has-text("Undo")').first().click();
  await page.waitForSelector("text=Import undone", { timeout: 60_000 });

  await page.goto("http://localhost:3000/dashboard");
  await page.click('button:has-text("To date")');
  await page.waitForSelector("text=BALANCE · TO DATE", { timeout: 8000 });
  const balanceAfter = (await page.textContent("body")).match(/(?:TOTAL BALANCE|BALANCE · TO DATE)(−?₹[\d,.]+)/)?.[1];
  ok(
    "large import cleans up after itself (undo reverses the balance effect, leaving the DB as it found it)",
    !!balanceBefore && balanceBefore === balanceAfter,
    `${balanceBefore} -> ${balanceAfter}`
  );
} catch (e) {
  ok("script error", false, String(e).slice(0, 500));
  await page.screenshot({ path: `${SHOT}/large-import-error.png`, fullPage: true });
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
