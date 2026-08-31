// E2E: Ledgerly Backup (.json) restore flow.
// Non-destructive: fixture transactions carry unique merchants + null accountId,
// so restore inserts rows without touching account balances. Undo via Settings
// removes them. Run against a dev server (PORT=3000 by default).
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { config } from "dotenv";
import { PrismaClient } from "@prisma/client";
config();

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(SCRIPT_DIR, "e2e", "fixtures", "backup-restore-sample.json");
const BASE = process.env.BASE_URL || "http://localhost:3000";
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const browser = await chromium.launch({ headless: true });

// Clean slate: remove any ZZZ RestoreTest transactions and Ledgerly Backup
// batches left from previous runs so the assertions are deterministic.
{
  const prisma = new PrismaClient();
  const u = await prisma.user.findUnique({ where: { email: "arjun@ledgerly.app" } });
  if (u) {
    await prisma.transaction.deleteMany({ where: { userId: u.id, merchant: { contains: "ZZZ RestoreTest" } } });
    await prisma.importBatch.deleteMany({ where: { userId: u.id, source: "Ledgerly Backup" } });
  }
  await prisma.$disconnect();
}
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

// `next dev` keeps a long-lived HMR websocket open, so a hard
// `waitUntil: "networkidle"` can never settle and times out on a cold server
// even though the page rendered fine. Navigate on domcontentloaded, then treat
// network quiet as a best-effort settle: the actual hydration guarantee comes
// from waiting on the element we're about to interact with.
async function settle(ms = 6000) {
  await page.waitForLoadState("networkidle", { timeout: ms }).catch(() => {});
}

async function gotoRetry(url, opts = {}) {
  const options = { waitUntil: "domcontentloaded", timeout: 60000, ...opts };
  try {
    await page.goto(url, options);
  } catch (e) {
    if (String(e).includes("ERR_ABORTED") || String(e).includes("Timeout")) {
      await page.waitForTimeout(1000);
      await page.goto(url, options);
    } else {
      throw e;
    }
  }
  await settle();
}

try {
  // ── Sign in (wait for hydration to avoid a native form GET). ──
  let signedIn = false;
  for (let attempt = 0; attempt < 3 && !signedIn; attempt++) {
    await gotoRetry(`${BASE}/sign-in`);
    await page.waitForSelector('button[type="submit"]', { timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.fill('input[type="email"]', "arjun@ledgerly.app");
    await page.fill('input[type="password"]', "ledgerly-demo");
    await page.click('button[type="submit"]');
    try {
      await page.waitForURL("**/dashboard", { timeout: 30000 });
      signedIn = true;
    } catch {
      await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded" }).catch(() => {});
    }
  }
  if (!signedIn) throw new Error("Could not sign in after 3 attempts (hydration race)");

  // ── Pre-check: fixture merchants must not already exist ──
  await gotoRetry(`${BASE}/transactions`);
  await page.waitForSelector("body", { timeout: 20000 });
  const before = await page.textContent("body");
  ok("fixture merchants absent before restore", !before.includes("ZZZ RestoreTest"));

  // ── Import Center: pick the Ledgerly Backup card ──
  await gotoRetry(`${BASE}/import`);
  await page.waitForSelector("text=Ledgerly Backup", { timeout: 20000 });
  await page.getByRole("button", { name: /Ledgerly Backup/ }).click();
  await page.locator("button", { hasText: "Ledgerly Backup" }).filter({ hasText: "✓ Selected" }).waitFor({ timeout: 10000 });
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);

  // ── Backup preview summary should appear ──
  await page.waitForSelector("text=Will restore", { timeout: 20000 });
  const previewBody = await page.textContent("body");
  const compact = previewBody.replace(/\s+/g, " ");
  const numAfter = (label) => {
    const m = compact.match(new RegExp(label + "\\s*(\\d+)"));
    return m ? Number(m[1]) : null;
  };
  ok(
    "backup preview shows 2 transactions to restore",
    numAfter("Transactions") === 2 && numAfter("Will restore") === 2,
    `transactions=${numAfter("Transactions")} willRestore=${numAfter("Will restore")}`
  );
  ok(
    "preview shows matched account (HDFC Savings) + no new accounts",
    numAfter("Matched accounts") === 1 && numAfter("New accounts") === 0,
    `matched=${numAfter("Matched accounts")} new=${numAfter("New accounts")}`
  );

  // ── Commit the restore ──
  await page.click("text=/Restore \\d+ transaction/");
  await page.waitForSelector("text=Restored", { timeout: 30000 }).catch(() => {});
  await page.waitForURL("**/transactions", { timeout: 20000 });

  // ── Verify both merchants landed in the ledger ──
  await page.waitForSelector("text=ZZZ RestoreTest Expense 001", { timeout: 15000 }).catch(() => {});
  const after = await page.textContent("body");
  ok("restored EXPENSE transaction appears in ledger", after.includes("ZZZ RestoreTest Expense 001"));
  ok("restored INCOME transaction appears in ledger", after.includes("ZZZ RestoreTest Income 002"));

  // ── Undo via Settings → Import history (the source is "Ledgerly Backup") ──
  await gotoRetry(`${BASE}/settings/backup`);
  // Settings is an index of sub-pages now; import history sits under
  // "Backup & data". Wait on that page's own heading — a real landmark —
  // rather than on the uppercase label above the list.
  await page.getByRole("heading", { name: "Backup & data" }).waitFor({ timeout: 20000 });
  await page.locator("text=Ledgerly Backup").first().waitFor({ timeout: 10000 });
  // Wait for hydration so the React onClick is attached before clicking (the
  // Undo button has no explicit type, so a too-early click fires a native no-op).
  await settle();
  await page.waitForTimeout(1500);
  const undoButton = page.getByRole("button", { name: "Undo" }).first();
  await undoButton.waitFor({ state: "visible", timeout: 10000 });
  await undoButton.click();
  // Undo now reports what it reversed ("Removed 2 transactions", plus any
  // accounts/categories the restore created), not a flat "Import undone".
  await page.waitForSelector("text=/Removed \\d+ transaction/", { timeout: 15000 }).catch(() => {});

  await gotoRetry(`${BASE}/transactions`);
  await page.waitForTimeout(800);
  const afterUndo = await page.textContent("body");
  ok("undo removes the restored transactions", !afterUndo.includes("ZZZ RestoreTest"), afterUndo.includes("ZZZ RestoreTest") ? "still present" : "absent");
} catch (e) {
  ok("script error", false, String(e).slice(0, 500));
  const outputDir = path.join(SCRIPT_DIR, "e2e-output");
  fs.mkdirSync(outputDir, { recursive: true });
  await page.screenshot({ path: path.join(outputDir, "backup-restore-error.png"), fullPage: true }).catch(() => {});
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
