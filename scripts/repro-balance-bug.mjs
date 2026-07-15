// Reproduces the reported "total balance incorrect" issue: import an
// account-less dataset (like real Monito exports) WITHOUT touching the
// default-account selector, exactly as a user would if they didn't notice it.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(SCRIPT_DIR, "..", "e2e-output");
fs.mkdirSync(SHOT, { recursive: true });
const FIXTURES = path.join(SCRIPT_DIR, "..", "e2e", "fixtures");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

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

await page.goto("http://localhost:3000/sign-in");
await page.fill('input[type="email"]', "arjun@ledgerly.app");
await page.fill('input[type="password"]', "ledgerly-demo");
await page.click('button[type="submit"]');
await page.waitForURL("**/dashboard", { timeout: 15000 });

await page.goto("http://localhost:3000/import");
await page.waitForSelector("text=Choose file");
await page.setInputFiles('input[type="file"]', `${FIXTURES}/monito-large.csv`);
await page.waitForSelector("text=Map your columns", { timeout: 10000 });
await page.click("text=Continue");
await page.waitForSelector("text=Map categories", { timeout: 8000 });
await resolveUnresolvedCategories(page);

// deliberately DON'T touch the default-account selector — leave it at whatever it defaults to
const defaultAccountValue = await page.locator("select").last().inputValue();
console.log("Default account selector left at:", defaultAccountValue);

await page.click("text=Preview import");
await page.waitForSelector("text=/\\d+ new/", { timeout: 10000 });
await page.click("text=/Import \\d+ transaction/");
await page.waitForURL("**/transactions", { timeout: 20000 });
console.log("Import committed.");

await browser.close();
