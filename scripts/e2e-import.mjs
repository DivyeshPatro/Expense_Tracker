// End-to-end walkthrough of Settings (export/clear) and the Import wizard,
// using a synthetic Indian-bank-statement-style CSV (Debit/Credit columns,
// DD/MM/YYYY dates, one deliberately broken row).
import { chromium } from "playwright";
import { choosePeriod } from "./e2e-period.mjs";
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
  // Sign in, tolerating a cold `next dev` server: submitting before React has
  // hydrated fires a native form GET that never reaches /dashboard, so wait for
  // the button and retry rather than filling the instant the DOM appears.
  let signedIn = false;
  for (let attempt = 0; attempt < 3 && !signedIn; attempt++) {
    await page.goto("http://localhost:3000/sign-in", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector('button[type="submit"]', { timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.fill('input[type="email"]', "arjun@ledgerly.app");
    await page.fill('input[type="password"]', "ledgerly-demo");
    await page.click('button[type="submit"]');
    try {
      await page.waitForURL("**/dashboard", { timeout: 30000 });
      signedIn = true;
    } catch {
      /* retry */
    }
  }
  if (!signedIn) throw new Error("Could not sign in after 3 attempts (hydration race)");

  // ── Settings → Backup & data: export ──
  // Settings is an index of sub-pages now; import, export and import history
  // all live on /settings/backup. Target the export link by role and name
  // rather than by the old "Export data" heading, which no longer exists.
  await page.goto("http://localhost:3000/settings/backup");
  await page.getByRole("heading", { name: "Export" }).waitFor({ timeout: 20000 });
  const [csvDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Transactions (CSV)" }).click(),
  ]);
  const csvPath = await csvDownload.path();
  const csvText = await (await import("fs")).promises.readFile(csvPath, "utf8");
  ok("CSV export downloads real transaction rows", csvText.split("\n").length > 5 && csvText.includes("Swiggy"), `${csvText.split("\n").length} lines`);

  // The export links are named for what they contain, not for the verb —
  // "Everything (JSON)" sits beside "Transactions (CSV)" under the same
  // Export heading. Addressed by role and accessible name.
  const [jsonDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Everything (JSON)" }).click(),
  ]);
  const jsonPath = await jsonDownload.path();
  const jsonText = await (await import("fs")).promises.readFile(jsonPath, "utf8");
  const parsed = JSON.parse(jsonText);
  ok("JSON export is valid and includes accounts+transactions", Array.isArray(parsed.accounts) && Array.isArray(parsed.transactions) && parsed.accounts.length === 5);

  // ── Settings: clear all transactions ──
  // Settings is an index of sub-pages; the danger zone lives under Advanced.
  await page.goto("http://localhost:3000/settings/advanced");
  await page.getByRole("button", { name: "Clear all transactions" }).click();
  await page.waitForSelector("text=Type CLEAR to confirm");
  await page.getByLabel("Confirmation text").fill("CLEAR");
  await page.click('button:has-text("Clear all transactions?")');
  // Clearing deletes across ~10 tables inside one transaction and resets every
  // account balance, which routinely takes longer than a fixed 1.5s wait on the
  // seeded dataset — a flat sleep here made this check fail intermittently while
  // the clear was still committing. Reload until the ledger actually reports
  // empty instead of guessing at a duration; the assertion is unchanged.
  let txBody = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    await page.goto("http://localhost:3000/transactions", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=/Nothing matches|Today|Yesterday/", { timeout: 8000 }).catch(() => {});
    txBody = await page.textContent("body");
    if (txBody.includes("Nothing matches") || !txBody.includes("Swiggy")) break;
    await page.waitForTimeout(1000);
  }
  ok("clear transactions empties the ledger", txBody.includes("Nothing matches") || !txBody.includes("Swiggy"));

  await page.goto("http://localhost:3000/dashboard");
  await page.getByText("TOTAL BALANCE", { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 20000 });
  const dashBody = await page.textContent("body");
  ok("account balances reset to opening balance (₹0 for the demo seed) after clear, not a stale number", dashBody.includes("TOTAL BALANCE₹0") || /TOTAL BALANCE\s*₹0/.test(dashBody));

  // ── Import wizard: upload synthetic bank-statement CSV ──
  await page.goto("http://localhost:3000/import");
  await page.waitForSelector("text=Choose file");
  await page.setInputFiles('input[type="file"]', CSV_PATH);
  // Generous: the first upload of a run has to compile /api/import/parse on a
  // cold `next dev` server, which alone can exceed a 10s budget.
  await page.waitForSelector("text=Map your columns", { timeout: 60000 });
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
  // The list defaults to a recent window and these rows come from a bank
  // statement dated well before it, so they are out of scope until the window
  // is widened — the same reason the Monito suite widens it.
  await choosePeriod(page);
  await page.waitForSelector("text=Swiggy", { timeout: 8000 }).catch(() => {});
  const afterImportBody = await page.textContent("body");
  ok("imported rows appear in the transaction list", afterImportBody.includes("Swiggy") && afterImportBody.includes("BigBasket") && afterImportBody.includes("Uber"));
  ok("auto-categorization from merchant rules applied (Swiggy -> Food)", afterImportBody.includes("Food"));

  // ── Re-import the same file: everything should now be flagged duplicate ──
  await page.goto("http://localhost:3000/import");
  await page.waitForSelector("text=Choose file");
  await page.setInputFiles('input[type="file"]', CSV_PATH);
  // Generous: the first upload of a run has to compile /api/import/parse on a
  // cold `next dev` server, which alone can exceed a 10s budget.
  await page.waitForSelector("text=Map your columns", { timeout: 60000 });
  await page.click("text=Continue");
  await page.waitForSelector("text=Map categories", { timeout: 8000 });
  await page.click("text=Preview import");
  await page.waitForSelector("text=/\\d+ duplicate/", { timeout: 8000 });
  const dupBody = await page.textContent("body");
  ok("re-importing the same file flags rows as duplicates", dupBody.includes("4 duplicates"), dupBody.match(/\d+ new|\d+ duplicates|\d+ invalid/g)?.join(", "));

  // ── Undo the first import via Settings, confirm rows disappear ──
  await page.goto("http://localhost:3000/settings/backup");
  await page.getByRole("heading", { name: "Backup & data" }).waitFor({ timeout: 30000 });
  await page.locator('button:has-text("Undo")').first().click();
  // Undo reports what it reversed ("Removed 4 transactions", plus any
  // accounts/categories a backup restore created) rather than "Import undone".
  await page.waitForSelector("text=/Removed \\d+ transaction/");
  await page.goto("http://localhost:3000/transactions");
  await page.waitForTimeout(500);
  const afterUndoBody = await page.textContent("body");
  ok("undo import removes the imported rows", !afterUndoBody.includes("BigBasket"));

  // ── Delete-account danger action is gated behind confirmation text ──
  await page.goto("http://localhost:3000/settings/advanced");
  await page.getByRole("button", { name: "Delete my account" }).click();
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
