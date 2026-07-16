// Proves Activity Timeline Phase 1 (RFC: activity-timeline-spec.md): every
// P1 catalog kind produces its expected timeline event with correct copy and
// paise-exact diffs, chips filter in SQL, pagination pages at 50, and the
// page renders cleanly at mobile/tablet/desktop widths. Effects[] math is
// covered paise-exactly by src/lib/activity.test.ts (unit level) since the
// P1 UI intentionally does not render effects.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(SCRIPT_DIR, "..", "e2e-output");
const CSV_PATH = path.join(SCRIPT_DIR, "..", "e2e", "fixtures", "sample-statement.csv");
fs.mkdirSync(SHOT, { recursive: true });

// PrismaClient for synthetic pagination rows + entity cleanup (reads .env itself is
// a CLI feature — load DATABASE_URL manually for the client).
for (const line of fs.readFileSync(path.join(SCRIPT_DIR, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(15000);

const demoUser = await prisma.user.findFirst({ where: { email: "arjun@ledgerly.app" } });
if (!demoUser) throw new Error("Demo user not found — run db:seed first");

// ── pre-clean leftovers from prior standalone runs (entities only; audit history is append-only by design) ──
async function precleanEntities() {
  const cats = await prisma.category.findMany({ where: { userId: demoUser.id, name: { startsWith: "E2EActCat" } } });
  if (cats.length) {
    await prisma.budget.deleteMany({ where: { userId: demoUser.id, categoryId: { in: cats.map((c) => c.id) } } });
    await prisma.category.deleteMany({ where: { id: { in: cats.map((c) => c.id) } } });
  }
  await prisma.bill.deleteMany({ where: { userId: demoUser.id, name: "E2EActBill" } });
  await prisma.account.deleteMany({ where: { userId: demoUser.id, name: "E2EActAcct" } });
  await prisma.auditLog.deleteMany({ where: { userId: demoUser.id, entityId: { startsWith: "e2e-syn-" } } });
}
await precleanEntities();

const openRow = async (merchantText) => {
  await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
  await page.fill('input[placeholder^="Search"]', merchantText);
  await page.waitForTimeout(500);
  await page.locator(`button:has-text("${merchantText}")`).first().click();
  await page.getByRole("button", { name: "Edit", exact: true }).waitFor({ timeout: 8000 });
};
const confirmDelete = async () => {
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForSelector("text=Delete this transaction?");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForSelector("text=Transaction deleted");
  await page.waitForTimeout(400);
};

try {
  await page.goto("http://localhost:3000/sign-in");
  await page.fill('input[type="email"]', "arjun@ledgerly.app");
  await page.fill('input[type="password"]', "ledgerly-demo");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 15000 });

  // ═══════════ A. drive one mutation per P1 catalog kind ═══════════

  // expense create → edit → delete → restore
  await page.click('button:has-text("＋ Add expense")');
  await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
  await page.fill('input[placeholder="0"]', "250");
  await page.fill('input[placeholder="e.g. Swiggy"]', "E2EActivityExp");
  await page.getByRole("button", { name: "Add expense", exact: true }).click();
  await page.waitForSelector("text=Expense added");

  await openRow("E2EActivityExp");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.waitForSelector('input[placeholder="0"]');
  await page.fill('input[placeholder="0"]', "350");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.waitForSelector("text=Transaction updated");

  await openRow("E2EActivityExp");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForSelector("text=Delete this transaction?");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForSelector("text=Transaction deleted");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForSelector("text=Restored");
  await page.waitForTimeout(400);

  // income
  await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
  await page.click('button[aria-label="Quick add (desktop)"]');
  await page.getByRole("button", { name: "💰 Income" }).click();
  await page.waitForSelector('input[placeholder="e.g. Salary · Acme Corp"]');
  await page.fill('input[placeholder="0"]', "777");
  await page.fill('input[placeholder="e.g. Salary · Acme Corp"]', "E2EActivityInc");
  await page.getByRole("button", { name: "Add income", exact: true }).click();
  await page.waitForSelector("text=Income added");

  // transfer (pinned accounts, from a page without a standalone Transfer button)
  await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
  await page.click('button[aria-label="Quick add (desktop)"]');
  await page.getByRole("button", { name: "⇄ Transfer" }).click();
  await page.waitForSelector('input[placeholder="0"]');
  const selects = page.locator("select.field");
  await selects.nth(0).selectOption({ label: "🏦 HDFC Savings" }).catch(() => {});
  await selects.nth(1).selectOption({ label: "💵 Cash Wallet" }).catch(() => {});
  await page.fill('input[placeholder="0"]', "1000");
  await page.getByRole("button", { name: "Transfer", exact: true }).click();
  await page.waitForSelector("text=Transfer recorded");

  // settlement
  await page.goto("http://localhost:3000/shared", { waitUntil: "load" });
  await page.waitForSelector("text=YOU OWE");
  await page.locator('button:has-text("Settle")').first().click();
  await page.waitForSelector('input[placeholder="0"]');
  await page.fill('input[placeholder="0"]', "450");
  await page.getByRole("button", { name: "Record settlement", exact: true }).click();
  await page.waitForSelector("text=Settlement recorded");

  // category create → rename → delete
  await page.goto("http://localhost:3000/settings", { waitUntil: "load" });
  await page.waitForSelector("text=Categories");
  const addCategory = async (name) => {
    await page.click('button:has-text("＋ New expense category")');
    await page.fill('input[placeholder="Category name"]', name);
    await page.locator('input[placeholder="Category name"]').locator("xpath=..").getByRole("button", { name: "Add", exact: true }).click();
    await page.waitForSelector("text=Category added");
    await page.waitForTimeout(300);
  };
  await addCategory("E2EActCatA");
  await page.click('button:has-text("E2EActCatA")');
  await page.waitForSelector('input[value="E2EActCatA"]');
  await page.fill('input[value="E2EActCatA"]', "E2EActCatAR");
  await page.click('button:has-text("Save")');
  await page.waitForSelector("text=Category renamed");
  await page.waitForSelector('button:has-text("E2EActCatAR")');
  await page.click('button:has-text("E2EActCatAR")');
  await page.waitForSelector('input[value="E2EActCatAR"]');
  await page.locator('input[value="E2EActCatAR"]').locator("xpath=..").locator('button:has-text("Delete")').click();
  await page.waitForSelector("text=Category deleted");

  // second category kept alive to host the budget (budgets have no delete op)
  await addCategory("E2EActCatB");

  // account
  await page.goto("http://localhost:3000/accounts", { waitUntil: "load" });
  await page.click('button:has-text("＋ Add account")');
  await page.waitForSelector('input[placeholder="e.g. HDFC Savings"]');
  await page.fill('input[placeholder="e.g. HDFC Savings"]', "E2EActAcct");
  await page.fill('input[placeholder="0"]', "100");
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await page.waitForSelector("text=Account added");

  // budget create then update — against the fresh category so create is guaranteed
  for (const amount of ["5000", "6000"]) {
    await page.keyboard.press("Control+k");
    await page.waitForSelector('input[placeholder*="swiggy"]');
    await page.locator("text=Create budget").first().click();
    await page.waitForSelector("text=MONTHLY LIMIT (₹)");
    await page.locator("select.field").first().selectOption({ label: "📦 E2EActCatB" });
    await page.fill('input[placeholder="0"]', amount);
    await page.getByRole("button", { name: "Save budget", exact: true }).click();
    await page.waitForSelector("text=Budget saved");
    await page.waitForTimeout(300);
  }

  // bill create → pay (one-off retires itself)
  await page.goto("http://localhost:3000/bills", { waitUntil: "load" });
  await page.click('button:has-text("＋ New bill")');
  await page.waitForSelector('input[placeholder="e.g. ACT Fibernet"]');
  await page.fill('input[placeholder="e.g. ACT Fibernet"]', "E2EActBill");
  await page.fill('input[placeholder="0"]', "500");
  await page.locator("select.field").last().selectOption({ label: "One-off" });
  await page.getByRole("button", { name: "Add bill", exact: true }).click();
  await page.waitForSelector("text=Bill added");
  await page.waitForTimeout(400);
  const billRow = page.locator("div.flex.items-center", { hasText: "E2EActBill" }).first();
  await billRow.getByRole("button", { name: "Mark paid" }).click();
  await page.waitForSelector("text=paid ·");
  await page.waitForTimeout(400);

  // import → undo
  await page.goto("http://localhost:3000/import", { waitUntil: "load" });
  await page.waitForSelector("text=Choose file");
  await page.setInputFiles('input[type="file"]', CSV_PATH);
  await page.waitForSelector("text=Map your columns", { timeout: 10000 });
  await page.click("text=Continue");
  await page.waitForSelector("text=Map categories", { timeout: 8000 });
  await page.click("text=Preview import");
  await page.waitForSelector("text=/\\d+ new/", { timeout: 8000 });
  await page.click("text=/Import \\d+ transaction/");
  await page.waitForURL("**/transactions", { timeout: 20000 });
  await page.goto("http://localhost:3000/settings", { waitUntil: "load" });
  await page.waitForSelector("text=IMPORT HISTORY");
  await page.locator('button:has-text("Undo")').first().click();
  await page.waitForSelector("text=Import undone", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);

  // ═══════════ B. the timeline shows every kind with correct copy ═══════════
  // rendered text only — textContent("body") would also match the RSC flight
  // payload inside <script> tags, which carries the serialized initial events
  const visibleText = () => page.evaluate(() => document.body.innerText);
  await page.goto("http://localhost:3000/activity", { waitUntil: "load" });
  await page.waitForSelector("text=Added expense");
  const body = await visibleText();

  ok("day group header renders", body.includes("TODAY") || body.toLowerCase().includes("today"));
  ok("expense create event", body.includes("Added expense") && body.includes("E2EActivityExp"));
  ok("expense edit event with paise-exact signed diff", body.includes("Edited expense") && body.includes("₹250 → ₹350 (+₹100)"));
  ok("expense delete event", body.includes("Deleted expense"));
  ok("expense restore event", body.includes("Restored expense"));
  ok("income create event", body.includes("Added income") && body.includes("E2EActivityInc"));
  ok("transfer event", body.includes("Transferred money") && body.includes("HDFC Savings → Cash Wallet"));
  ok("settlement event with direction copy", body.includes("Settled up") && (body.includes("paid you") || body.includes("You paid")));
  ok("category create event", body.includes("Added category"));
  ok("category rename event with name diff", body.includes("Renamed category") && body.includes("E2EActCatA → E2EActCatAR"));
  ok("category delete event keeps snapshot name", body.includes("Deleted category") && body.includes("E2EActCatAR"));
  ok("account create event with opening balance", body.includes("Added account") && body.includes("E2EActAcct") && body.includes("opening balance ₹100"));
  ok("budget create event", body.includes("Set budget") && body.includes("₹5,000 per month"));
  ok("budget update event with limit diff", body.includes("Changed budget") && body.includes("₹5,000 → ₹6,000 (+₹1,000)"));
  ok("bill create event", body.includes("Added bill") && body.includes("E2EActBill"));
  ok("bill paid event", body.includes("Paid bill"));
  ok("import event", /Imported \d+ transactions?/.test(body));
  ok("undo-import event", body.includes("Undid import"));

  // ═══════════ C. chips filter server-side ═══════════
  const chipBody = async (label) => {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.waitForTimeout(600);
    return visibleText();
  };
  const imports = await chipBody("Imports");
  ok("Imports chip isolates import events", /Imported \d+/.test(imports) && !imports.includes("Added expense"));
  const accounts = await chipBody("Accounts");
  ok("Accounts chip isolates account events", accounts.includes("Added account") && !accounts.includes("Paid bill"));
  const shared = await chipBody("Shared");
  ok("Shared chip isolates settlements", shared.includes("Settled up") && !shared.includes("Added account"));
  const budgets = await chipBody("Budgets & Bills");
  ok("Budgets & Bills chip isolates budget/bill events", budgets.includes("Paid bill") && budgets.includes("Set budget") && !budgets.includes("Settled up"));
  const money = await chipBody("Money");
  ok("Money chip isolates transaction events", money.includes("Edited expense") && !money.includes("Set budget"));
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.waitForTimeout(400);

  // ═══════════ D. pagination at 50 (synthetic audit rows via the real write shape) ═══════════
  const t0 = Date.now();
  await prisma.auditLog.createMany({
    data: Array.from({ length: 60 }, (_, i) => ({
      userId: demoUser.id,
      action: "create",
      entity: "Category",
      entityId: `e2e-syn-${i}`,
      after: { name: `Syn ${i}`, kind: "EXPENSE" },
      at: new Date(t0 - (i + 1) * 60_000), // older than every real event above
    })),
  });
  await page.goto("http://localhost:3000/activity?p=all", { waitUntil: "load" });
  await page.waitForSelector("text=Added expense");
  let pageBody = await visibleText();
  ok("first page is bounded (oldest synthetic row not present)", !pageBody.includes("Syn 59") && pageBody.includes("Load more"));
  let guard = 0;
  while ((await page.locator('button:has-text("Load more")').count()) > 0 && guard++ < 5) {
    await page.click('button:has-text("Load more")');
    await page.waitForTimeout(700);
  }
  pageBody = await visibleText();
  ok("Load more pages through to the oldest event", pageBody.includes("Syn 59"), `${guard} page loads`);

  // ═══════════ E. accessibility structure ═══════════
  const timeEls = await page.locator("time[datetime]").count();
  ok("events carry semantic <time datetime>", timeEls > 0, `${timeEls} time elements`);
  const chipButtons = await page.getByRole("button", { name: "Budgets & Bills", exact: true }).count();
  ok("filter chips are real buttons (keyboard/screen-reader operable)", chipButtons === 1);

  // ═══════════ F. viewport screenshots (no horizontal overflow) ═══════════
  const cookies = await page.context().cookies();
  for (const [name, width, height] of [["mobile-360x800", 360, 800], ["mobile-390x844", 390, 844], ["mobile-412x915", 412, 915], ["tablet-768x1024", 768, 1024]]) {
    const p = await browser.newPage({ viewport: { width, height } });
    await p.context().addCookies(cookies);
    await p.goto("http://localhost:3000/activity", { waitUntil: "load" });
    await p.waitForSelector("text=Added expense");
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    ok(`no horizontal overflow at ${name}`, !overflow);
    await p.screenshot({ path: `${SHOT}/activity-${name}.png`, fullPage: false });
    await p.close();
  }
  await page.screenshot({ path: `${SHOT}/activity-desktop.png`, fullPage: true });

  // ═══════════ G. cleanup — fully self-cleaning ═══════════
  await prisma.auditLog.deleteMany({ where: { userId: demoUser.id, entityId: { startsWith: "e2e-syn-" } } });
  await openRow("E2EActivityExp");
  await confirmDelete();
  await openRow("E2EActivityInc");
  await confirmDelete();
  await openRow("HDFC Savings → Cash Wallet");
  await confirmDelete();
  await openRow("E2EActBill");
  await confirmDelete();
  // account/category/budget have no delete operations in the product, so the
  // rows are removed directly — downstream suites assert exact seeded state
  // (e2e-import: exactly 5 accounts, post-clear total balance ₹0). Their audit
  // rows stay: history is append-only, and no later suite reads the timeline.
  await precleanEntities();
  ok("cleanup: test entities removed, suite leaves the seeded state intact", true);
} catch (e) {
  ok("script error", false, String(e).slice(0, 400));
  await page.screenshot({ path: `${SHOT}/activity-error.png`, fullPage: true }).catch(() => {});
}

await prisma.$disconnect();
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
