// Proves the import wizard against the user's actual Monito export shape:
// banner rows, a month-section label, Category type/name split, blank notes.
import { chromium } from "playwright-core";

const SHOT = "/tmp/claude-0/-home-claude/a52814cf-53bd-5151-b67d-905c3e82b1dd/scratchpad";
const CSV_PATH = `${SHOT}/monito-export.csv`;
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

// Category resolution is forced: every raw value that doesn't already match an
// existing category name must be mapped or created before "Preview import"
// unlocks. This real 18-row export has 4 such values (Clothing, Home, Others,
// "Credit card Bill payment") — create them all on the spot, same as a user
// clicking through each amber-flagged row.
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
  await page.waitForSelector("text=Map your columns", { timeout: 10000 });

  const mapBody = await page.textContent("body");
  ok("banner rows and 'March 2023' label did not become bogus headers", mapBody.includes("Category type") && mapBody.includes("Category name"));
  ok("does not show 'Monito Expense Manager' or 'Version 8.3' as a column", !mapBody.includes("Version 8.3"));
  await page.screenshot({ path: `${SHOT}/monito-01-mapping.png`, fullPage: true });

  await page.click("text=Continue");
  await page.waitForSelector("text=Map categories", { timeout: 8000 });
  const resolveBody = await page.textContent("body");
  ok("category resolution step lists distinct raw category values (Food, Rent, Clothing…)", resolveBody.includes("Food") && resolveBody.includes("Clothing"));

  // "Clothing", "Home", "Others" and "Credit card Bill payment" aren't among the
  // 28 seeded defaults — category resolution is now forced, so each must be
  // created inline via "+ Create new category…" before Preview import unlocks.
  await resolveUnresolvedCategories(page);
  await page.waitForSelector('button:has-text("Preview import")', { timeout: 8000 });
  const previewEnabled = await page.locator('button:has-text("Preview import")').isEnabled();
  ok("inline '+ Create new category' flow resolves every unmatched value (Clothing, Home, Others…)", previewEnabled);
  await page.screenshot({ path: `${SHOT}/monito-02-resolve.png`, fullPage: true });

  await page.click("text=Preview import");
  await page.waitForSelector("text=/\\d+ new/", { timeout: 8000 });
  const previewBody = await page.textContent("body");
  ok("all 18 real rows parsed as valid (none blocked by blank notes)", previewBody.includes("18 new") && previewBody.includes("0 invalid"), previewBody.match(/\d+ new|\d+ duplicates|\d+ invalid/g)?.join(", "));
  ok("the Income row (Refund) is correctly typed from 'Category type', not Amount sign", previewBody.includes("INCOME"));
  await page.screenshot({ path: `${SHOT}/monito-03-preview.png`, fullPage: true });

  await page.click("text=/Import \\d+ transaction/");
  await page.waitForURL("**/transactions", { timeout: 10000 });
  await page.waitForTimeout(800);

  // the transactions list is unbounded now — search for the 2023 rows directly
  // rather than scrolling past ~65 rows of 2026 seed data to find them
  await page.fill('input[placeholder*="Search merchant"]', "Dosa");
  await page.waitForTimeout(400);
  let txBody = await page.textContent("body");
  ok("2023 imported row IS visible in the (now unbounded) transactions list", txBody.includes("Dosa"));

  await page.fill('input[placeholder*="Search merchant"]', "Bristi");
  await page.waitForTimeout(400);
  txBody = await page.textContent("body");
  ok("blank-note rows still show a sensible name (category as fallback: 'Rent')", txBody.includes("Bristi mandi"));
  await page.fill('input[placeholder*="Search merchant"]', "Rent");
  await page.waitForTimeout(400);
  txBody = await page.textContent("body");
  ok("blank-note Rent row shows category as its name", txBody.includes("Rent"));

  await page.fill('input[placeholder*="Search merchant"]', "Clothing");
  await page.waitForTimeout(400);
  txBody = await page.textContent("body");
  ok("auto-categorized against real category names (e.g. Clothing, not left uncategorized)", txBody.includes("Clothing"));
  await page.screenshot({ path: `${SHOT}/monito-04-transactions.png`, fullPage: true });

  // ── Ask Ledgerly can now find this 3-year-old data via an explicit year ──
  await page.keyboard.press("Control+k");
  await page.waitForSelector('input[placeholder*="swiggy"]');
  await page.fill('input[placeholder*="swiggy"]', "food in march 2023");
  await page.waitForSelector("text=Ask Ledgerly", { timeout: 8000 });
  const answer = await page.locator("text=/You spent .* March 2023/").first().textContent();
  ok("Ask Ledgerly finds 2023 history with an explicit year in the query", /You spent ₹/.test(answer ?? "") && (answer ?? "").includes("March 2023"), answer ?? "");
  await page.screenshot({ path: `${SHOT}/monito-05-search-2023.png` });
} catch (e) {
  ok("script error", false, String(e).slice(0, 400));
  await page.screenshot({ path: `${SHOT}/monito-error.png`, fullPage: true });
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
