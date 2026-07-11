// Proves the Prisma interactive-transaction-timeout fix: imports ~~475-2900 rows
// (multi-year Monito-shaped history) in one commit — well past what the
// default 5s transaction timeout could survive under the old code.
import { chromium } from "playwright-core";

const SHOT = "/tmp/claude-0/-home-claude/a52814cf-53bd-5151-b67d-905c3e82b1dd/scratchpad";
const CSV_PATH = `${SHOT}/monito-large.csv`;
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", headless: true });
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
} catch (e) {
  ok("script error", false, String(e).slice(0, 500));
  await page.screenshot({ path: `${SHOT}/large-import-error.png`, fullPage: true });
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
