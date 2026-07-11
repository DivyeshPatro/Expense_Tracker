// Reproduces the reported "total balance incorrect" issue: import an
// account-less dataset (like real Monito exports) WITHOUT touching the
// default-account selector, exactly as a user would if they didn't notice it.
import { chromium } from "playwright-core";

const SHOT = "/tmp/claude-0/-home-claude/a52814cf-53bd-5151-b67d-905c3e82b1dd/scratchpad";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", headless: true });
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
await page.setInputFiles('input[type="file"]', `${SHOT}/monito-large.csv`);
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
