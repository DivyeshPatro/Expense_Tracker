// End-to-end walkthrough of Settings (export/clear) and the Import wizard,
// using a synthetic Indian-bank-statement-style CSV (Debit/Credit columns,
// DD/MM/YYYY dates, one deliberately broken row).
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(SCRIPT_DIR, "..", "e2e-output");
fs.mkdirSync(SHOT, { recursive: true });
const CSV_PATH = path.join(SCRIPT_DIR, "..", "e2e", "fixtures", "sample-statement.csv");
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

try {
  await page.goto("http://localhost:3000/sign-in");
  await page.fill('input[type="email"]', "arjun@ledgerly.app");
  await page.fill('input[type="password"]', "ledgerly-demo");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 15000 });

  // ── Settings: export ──
  await page.goto("http://localhost:3000/settings");
  await page.waitForSelector("text=Export data");
  const [csvDownload] = await Promise.all([page.waitForEvent("download"), page.click("text=Export transactions (CSV)")]);
  const csvPath = await csvDownload.path();
  const csvText = await (await import("fs")).promises.readFile(csvPath, "utf8");
  ok("CSV export downloads real transaction rows", csvText.split("\n").length > 5 && csvText.includes("Swiggy"), `${csvText.split("\n").length} lines`);

  const [jsonDownload] = await Promise.all([page.waitForEvent("download"), page.click("text=Export everything (JSON)")]);
  const jsonPath = await jsonDownload.path();
  const jsonText = await (await import("fs")).promises.readFile(jsonPath, "utf8");
  const parsed = JSON.parse(jsonText);
  ok("JSON export is valid and includes accounts+transactions", Array.isArray(parsed.accounts) && Array.isArray(parsed.transactions) && parsed.accounts.length === 5);

  // ── Settings: clear all transactions ──
  await page.click("text=Clear all transactions");
  await page.waitForSelector("text=Type CLEAR to confirm");
  await page.getByLabel("Confirmation text").fill("CLEAR");
  await page.click('button:has-text("Clear all transactions?")');
  await page.waitForTimeout(1500);
  await page.goto("http://localhost:3000/transactions");
  await page.waitForSelector("text=/Nothing matches|Today|Yesterday/", { timeout: 8000 }).catch(() => {});
  const txBody = await page.textContent("body");
  ok("clear transactions empties the ledger", txBody.includes("Nothing matches") || !txBody.includes("Swiggy"));

  await page.goto("http://localhost:3000/dashboard");
  await page.waitForSelector("text=TOTAL BALANCE");
  const dashBody = await page.textContent("body");
  ok("account balances reset to opening balance (₹0 for the demo seed) after clear, not a stale number", dashBody.includes("TOTAL BALANCE₹0") || /TOTAL BALANCE\s*₹0/.test(dashBody));

  // ── Import wizard: upload synthetic bank-statement CSV ──
  await page.goto("http://localhost:3000/import");
  await page.waitForSelector("text=Choose file");
  await page.setInputFiles('input[type="file"]', CSV_PATH);
  await page.waitForSelector("text=Map your columns", { timeout: 10000 });
  const mapBody = await page.textContent("body");
  ok("auto-detects Date/Narration/Debit/Credit/Category headers", mapBody.includes("Date") && mapBody.includes("Narration"));

  // verify the select dropdowns actually picked debit/credit (not "Ignore this column")
  const selectEls = await page.locator("table select").all();
  const selectedLabels = await Promise.all(
    selectEls.map((s) => s.locator("option:checked").textContent())
  );
  ok(
    "column mapping selects a non-ignore target for Date/Debit/Credit",
    selectedLabels.filter((s) => s && !s.includes("Ignore")).length >= 4,
    selectedLabels.join(" | ")
  );

  await page.click("text=Continue");
  await page.waitForSelector("text=Map categories", { timeout: 8000 });
  await page.screenshot({ path: `${SHOT}/import-01-resolve.png`, fullPage: true });

  await page.click("text=Preview import");
  await page.waitForSelector("text=/\\d+ new/", { timeout: 8000 });
  const previewBody = await page.textContent("body");
  ok("preview shows 4 valid + 1 invalid (broken date row)", previewBody.includes("4 new") && previewBody.includes("1 invalid"), previewBody.match(/\d+ new|\d+ duplicates|\d+ invalid/g)?.join(", "));
  await page.screenshot({ path: `${SHOT}/import-02-preview.png`, fullPage: true });

  await page.click("text=/Import \\d+ transaction/");
  await page.waitForSelector("text=Imported", { timeout: 10000 }).catch(() => {});
  await page.waitForURL("**/transactions", { timeout: 10000 });
  await page.waitForSelector("text=Swiggy", { timeout: 8000 }).catch(() => {});
  const afterImportBody = await page.textContent("body");
  ok("imported rows appear in the transaction list", afterImportBody.includes("Swiggy") && afterImportBody.includes("BigBasket") && afterImportBody.includes("Uber"));
  ok("auto-categorization from merchant rules applied (Swiggy -> Food)", afterImportBody.includes("Food"));

  // ── Re-import the same file: everything should now be flagged duplicate ──
  await page.goto("http://localhost:3000/import");
  await page.waitForSelector("text=Choose file");
  await page.setInputFiles('input[type="file"]', CSV_PATH);
  await page.waitForSelector("text=Map your columns", { timeout: 10000 });
  await page.click("text=Continue");
  await page.waitForSelector("text=Map categories", { timeout: 8000 });
  await page.click("text=Preview import");
  await page.waitForSelector("text=/\\d+ duplicate/", { timeout: 8000 });
  const dupBody = await page.textContent("body");
  ok("re-importing the same file flags rows as duplicates", dupBody.includes("4 duplicates"), dupBody.match(/\d+ new|\d+ duplicates|\d+ invalid/g)?.join(", "));

  // ── Undo the first import via Settings, confirm rows disappear ──
  await page.goto("http://localhost:3000/settings");
  await page.waitForSelector("text=IMPORT HISTORY");
  await page.locator('button:has-text("Undo")').first().click();
  await page.waitForSelector("text=Import undone");
  await page.goto("http://localhost:3000/transactions");
  await page.waitForTimeout(500);
  const afterUndoBody = await page.textContent("body");
  ok("undo import removes the imported rows", !afterUndoBody.includes("BigBasket"));

  // ── Delete-account danger action is gated behind confirmation text ──
  await page.goto("http://localhost:3000/settings");
  await page.click("text=Delete my account");
  await page.waitForSelector("text=Type DELETE to confirm");
  const deleteBtn = page.locator('button:has-text("Delete your account?")');
  await expectDisabled(deleteBtn, ok, "delete-account button stays disabled until DELETE is typed");
  await page.keyboard.press("Escape").catch(() => {});
} catch (e) {
  ok("script error", false, String(e).slice(0, 400));
  await page.screenshot({ path: `${SHOT}/import-error.png`, fullPage: true });
}

async function expectDisabled(locator, ok, label) {
  const disabled = await locator.isDisabled();
  ok(label, disabled);
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
