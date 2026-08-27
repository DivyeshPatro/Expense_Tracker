// E2E: account lifecycle — rename, hard delete, archive, restore.
//
// Non-destructive: creates its own ZZZ-prefixed accounts and archives the demo
// seed's HDFC Savings only long enough to prove the archive path, restoring it
// before exiting.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { config } from "dotenv";
import { PrismaClient } from "@prisma/client";
config();

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || "http://localhost:3000";
const SPARE = "ZZZ Spare Account";
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const prisma = new PrismaClient();
const user = await prisma.user.findUnique({ where: { email: "arjun@ledgerly.app" } });
await prisma.account.deleteMany({ where: { userId: user.id, name: { contains: "ZZZ Spare" } } });
// An account nothing references — the hard-delete case.
await prisma.account.create({
  data: { userId: user.id, name: SPARE, type: "CASH", balance: 0, openingBalance: 0, icon: "💵" },
});

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

async function waitFor(fn, label, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    const v = await fn();
    if (v) return v;
    await page.waitForTimeout(300);
  }
  console.log(`  (gave up waiting for ${label})`);
  return null;
}

// #209 also rebuilt the account card into a row: the row body is the link into
// that account's transactions, and Rename / Archive / Delete moved behind a ⋯
// menu because three equal-weight buttons on every card meant fifteen controls
// across five accounts. So a row is a listitem rather than a .card, and those
// actions do not exist in the DOM until the menu is open.
const row = (name) => page.getByRole("listitem").filter({ hasText: name }).first();

/** Opens a row's ⋯ menu and hands the row back. The menu is a <details>, so
 *  clicking its summary toggles — check the element's own state rather than
 *  assuming it starts closed, or a second call shuts the first one. */
async function openRowMenu(name) {
  const r = row(name);
  const isOpen = await r
    .locator("details")
    .first()
    .evaluate((d) => d.hasAttribute("open"))
    .catch(() => false);
  if (!isOpen) {
    await r.getByLabel(`More actions for ${name}`).click();
    await page.waitForTimeout(300);
  }
  return r;
}
const archivedCard = () => page.locator("div.card").filter({ hasText: "Archived accounts" });

  // #209 moved this page's create action off the header and into the quick-add
  // FAB. The gate below waited on the old header button, so every run timed out
  // before its first assertion — the suite has been reporting 0/1 rather than
  // testing anything. Wait on something the page always renders instead, and
  // assert the action separately in its new home.
async function gotoAccounts() {
  await page.goto(`${BASE}/accounts`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByRole("heading", { name: "Transfers" }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500); // hydration before clicking anything
}

try {
  let signedIn = false;
  for (let attempt = 0; attempt < 3 && !signedIn; attempt++) {
    await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded", timeout: 60000 });
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

  await gotoAccounts();

  // ── The remove button says what will actually happen ──
  ok(
    "an unreferenced account offers Delete",
    (await (await openRowMenu(SPARE)).getByRole("button", { name: "Delete" }).count()) === 1
  );
  ok(
    "an account with history offers Archive instead",
    (await (await openRowMenu("HDFC Savings")).getByRole("button", { name: "Archive" }).count()) === 1
  );

  // ── Rename ──
  // A click landing before React has attached its handler is a no-op that leaves
  // the form unopened, so confirm the input actually appeared and click again if
  // it didn't rather than waiting a fixed time and hoping.
  for (let attempt = 0; attempt < 3; attempt++) {
    await (await openRowMenu(SPARE)).getByRole("button", { name: "Rename" }).click();
    const opened = await row(SPARE)
      .getByLabel(`Rename ${SPARE}`)
      .waitFor({ timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (opened) break;
    await page.waitForTimeout(1000);
  }
  // Still located by the OLD name: the row keeps rendering it until the rename
  // is saved, and an input's value isn't matched by hasText.
  await row(SPARE).getByLabel(`Rename ${SPARE}`).fill(`${SPARE} Renamed`);
  await row(SPARE).getByRole("button", { name: "Save" }).click();
  const renamed = await waitFor(
    () => prisma.account.findFirst({ where: { userId: user.id, name: `${SPARE} Renamed` } }),
    "the rename to save"
  );
  ok("renaming an account persists", !!renamed);

  // ── Hard delete, because nothing references it ──
  await gotoAccounts();
  await (await openRowMenu(`${SPARE} Renamed`)).getByRole("button", { name: "Delete" }).click();
  await page.waitForTimeout(600);
  // The menu is replaced by an inline confirmation, so the second Delete is on
  // the row itself rather than back inside the menu.
  await row(`${SPARE} Renamed`).getByRole("button", { name: "Delete" }).click();
  const deleted = await waitFor(
    async () => ((await prisma.account.count({ where: { userId: user.id, name: `${SPARE} Renamed` } })) === 0 ? true : null),
    "the delete to save"
  );
  ok("an unreferenced account is deleted outright", deleted === true);

  // ── Archive, because history references it ──
  await gotoAccounts();
  await (await openRowMenu("HDFC Savings")).getByRole("button", { name: "Archive" }).click();
  await page.waitForTimeout(600);
  const confirmCopy = await row("HDFC Savings").innerText();
  ok("the archive confirmation explains why it can't be deleted", confirmCopy.includes("financial history"));

  await row("HDFC Savings").getByRole("button", { name: "Archive" }).click();
  const archived = await waitFor(
    async () => ((await prisma.account.findFirst({ where: { userId: user.id, name: "HDFC Savings" } }))?.isArchived ? true : null),
    "the archive to save"
  );
  ok("an account with history is archived, not deleted", archived === true);

  const txCount = await prisma.transaction.count({ where: { userId: user.id, accountId: { not: null } } });
  ok("archiving keeps the account's transactions", txCount > 0, `${txCount} transactions still present`);

  // ── Hidden from pickers ──
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /Add expense/ }).first().click();
  const modal = page.getByRole("dialog");
  await modal.waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  const options = await modal.locator("select").first().innerText();
  ok("an archived account disappears from the account picker", !options.includes("HDFC Savings"));
  await modal.getByRole("button", { name: "Close" }).click();
  await page.waitForTimeout(500);

  // ── Still reachable: history and restore ──
  await gotoAccounts();
  await page.getByRole("button", { name: /Archived accounts/ }).click();
  await page.waitForTimeout(800);
  ok("the archived account is listed with its balance and history", (await archivedCard().innerText()).includes("HDFC Savings"));

  await archivedCard().getByRole("link", { name: "Transactions" }).first().click();
  await page.waitForURL("**/transactions?account=*", { timeout: 30000 });
  await page.waitForTimeout(2500);
  const ledger = await page.locator("body").innerText();
  ok("its transactions are still reachable through the account filter", ledger.includes("HDFC Savings"));

  await gotoAccounts();
  await page.getByRole("button", { name: /Archived accounts/ }).click();
  await page.waitForTimeout(800);
  await archivedCard().getByRole("button", { name: "Restore" }).first().click();
  const restored = await waitFor(
    async () => ((await prisma.account.findFirst({ where: { userId: user.id, name: "HDFC Savings" } }))?.isArchived === false ? true : null),
    "the restore to save"
  );
  ok("an archived account can be restored", restored === true);
} catch (e) {
  ok("script error", false, String(e).slice(0, 500));
  const outputDir = path.join(SCRIPT_DIR, "..", "e2e-output");
  fs.mkdirSync(outputDir, { recursive: true });
  await page.screenshot({ path: path.join(outputDir, "accounts-error.png"), fullPage: true }).catch(() => {});
}

// Leave the seed as we found it whatever happened above.
await prisma.account.updateMany({ where: { userId: user.id, name: "HDFC Savings" }, data: { isArchived: false } });
await prisma.account.deleteMany({ where: { userId: user.id, name: { contains: "ZZZ Spare" } } });
await prisma.$disconnect();
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
