// E2E: Khatabook → Lending migration.
//
// Uploads a real Khatabook-shaped CSV, walks the migration preview → import →
// report, and checks the numbers against both the report and the database, then
// verifies the data shows up in Lending and that Undo removes exactly what was
// added. Non-destructive: works only with its own "ZZZ"-prefixed contacts.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { config } from "dotenv";
import { PrismaClient } from "@prisma/client";
config();

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CSV = path.join(SCRIPT_DIR, "e2e", "fixtures", "khatabook-sample.csv");
const BASE = process.env.BASE_URL || "http://localhost:3000";
const EMAIL = "arjun@ledgerly.app";
const PASSWORD = "ledgerly-demo";

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const prisma = new PrismaClient();
const user = await prisma.user.findUnique({ where: { email: EMAIL } });
if (!user) {
  console.error(`No demo user ${EMAIL} — run npm run db:seed first.`);
  await prisma.$disconnect();
  process.exit(1);
}

async function cleanup() {
  const mine = await prisma.participant.findMany({ where: { ownerId: user.id, displayName: { startsWith: "ZZZ " } }, select: { id: true } });
  const ids = mine.map((p) => p.id);
  if (ids.length) {
    await prisma.loanAllocation.deleteMany({ where: { userId: user.id, gaveEntry: { participantId: { in: ids } } } });
    await prisma.loanEntry.deleteMany({ where: { userId: user.id, participantId: { in: ids } } });
    await prisma.participant.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.importBatch.deleteMany({ where: { userId: user.id, fileName: { contains: "khatabook-sample" } } });
}
await cleanup();

const netFor = async (name) => {
  const p = await prisma.participant.findFirst({ where: { ownerId: user.id, displayName: name } });
  if (!p) return null;
  const entries = await prisma.loanEntry.findMany({ where: { userId: user.id, participantId: p.id, deletedAt: null }, select: { kind: true, amount: true } });
  return entries.reduce((s, e) => s + (e.kind === "GAVE" ? Number(e.amount) : -Number(e.amount)), 0);
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

try {
  // ── Sign in (retry through hydration) ──
  let signedIn = false;
  for (let attempt = 0; attempt < 3 && !signedIn; attempt++) {
    await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector('button[type="submit"]', { timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    try {
      await page.waitForURL("**/dashboard", { timeout: 30000 });
      signedIn = true;
    } catch {
      /* retry */
    }
  }
  if (!signedIn) throw new Error("Could not sign in after 3 attempts");

  // ── Upload the Khatabook file ──
  await page.goto(`${BASE}/import`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("text=Choose file", { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.setInputFiles('input[type="file"]', CSV);

  // ── Detected as a lending ledger, not a CSV to map ──
  await page.waitForSelector("text=Khatabook Lending Import", { timeout: 60000 });
  ok("a Khatabook file is auto-detected as a lending import", true);

  // Preview reconciles: 3 contacts, net outstanding ₹1,800 (3500 gave − 1700 got).
  // Stat labels render through a CSS uppercase transform, which innerText
  // reflects — so these matches are case-insensitive.
  const previewBody = await page.locator("body").innerText();
  ok("preview shows the contacts to create", /contacts to create[\s\S]*?3/i.test(previewBody) || previewBody.includes("ZZZ Ramesh"));
  ok("preview flags the duplicate row", /duplicates[\s\S]*?1/i.test(previewBody));
  ok("preview flags the invalid row", /invalid rows[\s\S]*?1/i.test(previewBody));

  // ── Import ──
  await page.getByRole("button", { name: "Import into Lending" }).click();
  await page.waitForSelector("text=Migration complete", { timeout: 30000 });
  ok("the migration report appears", true);
  const report = await page.locator("body").innerText();
  ok("report: 3 contacts created", /contacts created[\s\S]*?3/i.test(report));
  ok("report: 7 lending entries", /lending entries[\s\S]*?7/i.test(report));

  // ── Database reconciles with the preview ──
  const contacts = await prisma.participant.count({ where: { ownerId: user.id, displayName: { startsWith: "ZZZ " } } });
  ok("3 contacts created in the ledger", contacts === 3, `${contacts}`);
  const entries = await prisma.loanEntry.count({ where: { userId: user.id, participant: { displayName: { startsWith: "ZZZ " } } } });
  ok("7 lending entries created (duplicate + invalid excluded)", entries === 7, `${entries}`);
  ok("Ramesh nets ₹1,200 (1500 − 500 + 200)", (await netFor("ZZZ Ramesh")) === 120000);
  ok("Kiran nets ₹300 with the repayment settled by FIFO", (await netFor("ZZZ Kiran")) === 30000);
  const allocations = await prisma.loanAllocation.count({ where: { userId: user.id, gaveEntry: { participant: { displayName: "ZZZ Kiran" } } } });
  ok("Kiran's repayment produced allocations against his loans", allocations >= 1, `${allocations}`);

  // ── Data appears immediately in Lending ──
  await page.goto(`${BASE}/lending`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  ok("an imported contact appears in Lending straight away", (await page.locator("body").innerText()).includes("ZZZ Ramesh"));

  // ── One lending event on the Activity Timeline ──
  await page.goto(`${BASE}/activity`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  ok("the migration shows as a lending import on the Activity Timeline", /imported\s+7\s+lending entr/i.test(await page.locator("body").innerText()));

  // ── Undo removes exactly what was imported ──
  const batch = await prisma.importBatch.findFirst({ where: { userId: user.id, fileName: { contains: "khatabook-sample" } }, orderBy: { createdAt: "desc" } });
  ok("an import batch was recorded for history/undo", !!batch);
  if (batch) {
    // Undo from Import History (where the report's "View Import History" leads),
    // targeting this batch's own row so ordering can't undo the wrong one.
    await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("text=IMPORT HISTORY", { timeout: 30000 });
    await page.waitForTimeout(1000);
    const row = page.locator("div").filter({ hasText: "khatabook-sample.csv" }).filter({ has: page.locator('button:has-text("Undo")') }).last();
    await row.getByRole("button", { name: "Undo" }).click();
    await page.waitForTimeout(2500);
    const remaining = await prisma.loanEntry.count({ where: { userId: user.id, participant: { displayName: { startsWith: "ZZZ " } }, deletedAt: null } });
    const remainingContacts = await prisma.participant.count({ where: { ownerId: user.id, displayName: { startsWith: "ZZZ " } } });
    ok("undo removed the imported entries", remaining === 0, `${remaining} left`);
    ok("undo removed the contacts it created", remainingContacts === 0, `${remainingContacts} left`);
  }
} catch (e) {
  ok("script error", false, String(e).slice(0, 500));
  const outputDir = path.join(SCRIPT_DIR, "e2e-output");
  fs.mkdirSync(outputDir, { recursive: true });
  await page.screenshot({ path: path.join(outputDir, "lending-import-error.png"), fullPage: true }).catch(() => {});
}

await cleanup();
await prisma.$disconnect();
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
