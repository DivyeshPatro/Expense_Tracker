// E2E: budget lifecycle — edit the limit, delete the budget, and confirm the
// spending it tracked (and any stale threshold alerts) end up in the right state.
//
// Non-destructive: works on its own ZZZ category/budget and cleans up after.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { config } from "dotenv";
import { PrismaClient } from "@prisma/client";
config();

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || "http://localhost:3000";
const CATEGORY = "ZZZ Budgeted";
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const prisma = new PrismaClient();
const user = await prisma.user.findUnique({ where: { email: "arjun@ledgerly.app" } });
// The app reckons months in IST (see toYMD in src/lib/dates.ts), so the
// fixture must too. Built from UTC, this fixture dated its spending into the
// PREVIOUS month for the five and a half hours each day when the two calendars
// disagree — and the budget, which sums the current month, then correctly
// showed ₹0 spent. A suite that flips red at a month boundary is not one you
// can trust the rest of the year.
const monthKey = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date()).slice(0, 7);

async function cleanup() {
  const cats = await prisma.category.findMany({ where: { userId: user.id, name: { contains: "ZZZ " } } });
  for (const c of cats) {
    await prisma.budget.deleteMany({ where: { userId: user.id, categoryId: c.id } });
    await prisma.transaction.deleteMany({ where: { userId: user.id, categoryId: c.id } });
    await prisma.category.delete({ where: { id: c.id } });
  }
  await prisma.notification.deleteMany({ where: { userId: user.id, dedupeKey: { startsWith: "budget:" } } });
}
await cleanup();

const category = await prisma.category.create({ data: { userId: user.id, name: CATEGORY, kind: "EXPENSE", icon: "🧪" } });
const account = await prisma.account.findFirstOrThrow({ where: { userId: user.id, isArchived: false } });
// Spend 9,000 against a 10,000 limit → 90%, past the 80% alert.
await prisma.transaction.create({
  data: {
    userId: user.id, type: "EXPENSE", amount: 900_000, accountId: account.id, categoryId: category.id,
    merchant: "ZZZ Budget Spend", occurredAt: new Date(`${monthKey}-02T06:30:00Z`),
  },
});
const budget = await prisma.budget.create({
  data: { userId: user.id, categoryId: category.id, period: "MONTHLY", limit: 1_000_000 },
});
// An alert already on file, as if the threshold had been crossed.
await prisma.notification.create({
  data: {
    userId: user.id, kind: "BUDGET_WARNING", dedupeKey: `budget:${budget.id}:${monthKey}:80`,
    payload: { budgetId: budget.id, category: CATEGORY, spent: 900_000, limit: 1_000_000, monthKey },
  },
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

const budgetAlerts = () =>
  prisma.notification.count({ where: { userId: user.id, dedupeKey: { startsWith: `budget:${budget.id}:` } } });

async function gotoBudgets() {
  await page.goto(`${BASE}/budgets`, { waitUntil: "domcontentloaded", timeout: 60000 });
  // #209 moved this page's create action off the header and into the quick-add
  // FAB. The gate below waited on the old header button, so every run timed out
  // before its first assertion — the suite has been reporting 0/1 rather than
  // testing anything. Wait on something the page always renders instead, and
  // assert the action separately in its new home.
  await page.getByRole("navigation", { name: "Section views" }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500);
}

/** Clicks until the expected element appears — a pre-hydration click is a no-op. */
async function clickUntil(button, expected, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    await button.click();
    const appeared = await expected.waitFor({ timeout: 4000 }).then(() => true).catch(() => false);
    if (appeared) return true;
    await page.waitForTimeout(1000);
  }
  return false;
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

  await gotoBudgets();
  const listed = await page.locator("body").innerText();
  ok("the budget shows its spending progress", listed.includes(CATEGORY) && listed.includes("₹9,000"), "₹9,000 of ₹10,000");

  // ── Edit the limit ──
  const limitField = page.getByLabel(`Monthly limit for ${CATEGORY}`);
  ok("the edit form opens", await clickUntil(page.getByRole("button", { name: `Edit ${CATEGORY} limit` }), limitField));
  await limitField.fill("20000");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const raised = await waitFor(
    async () => ((await prisma.budget.findUniqueOrThrow({ where: { id: budget.id } })).limit === 2_000_000n ? true : null),
    "the new limit to save"
  );
  ok("editing the limit persists", raised === true);

  const spendKept = await prisma.transaction.count({ where: { userId: user.id, categoryId: category.id, deletedAt: null } });
  ok("editing preserves the spending it tracks", spendKept === 1);

  // Raising the budget past the alert should retire the alert it had already fired.
  const clearedOnRaise = await waitFor(async () => ((await budgetAlerts()) === 0 ? true : null), "the stale alert to clear");
  ok("raising the budget clears the alert that no longer applies", clearedOnRaise === true);

  await gotoBudgets();
  const afterEdit = await page.locator("body").innerText();
  ok("progress is recalculated against the new limit", afterEdit.includes("₹11,000 left"), "₹9,000 of ₹20,000");

  // ── Delete ──
  await clickUntil(
    page.getByRole("button", { name: `Delete ${CATEGORY} budget` }),
    page.getByText("Delete this budget?")
  );
  ok(
    "the confirmation promises spending history is kept",
    (await page.locator("body").innerText()).includes("transactions and spending history stay exactly as they are")
  );
  await page.getByRole("button", { name: `Confirm delete ${CATEGORY} budget` }).click();
  const deleted = await waitFor(
    async () => ((await prisma.budget.count({ where: { id: budget.id } })) === 0 ? true : null),
    "the delete to save"
  );
  ok("deleting the budget persists", deleted === true);

  const txAfter = await prisma.transaction.count({ where: { userId: user.id, categoryId: category.id, deletedAt: null } });
  ok("deleting a budget leaves its transactions untouched", txAfter === 1);
  ok("the category itself survives", (await prisma.category.count({ where: { id: category.id } })) === 1);
  ok("no threshold alerts outlive the budget", (await budgetAlerts()) === 0);
} catch (e) {
  ok("script error", false, String(e).slice(0, 500));
  const outputDir = path.join(SCRIPT_DIR, "..", "e2e-output");
  fs.mkdirSync(outputDir, { recursive: true });
  await page.screenshot({ path: path.join(outputDir, "budgets-error.png"), fullPage: true }).catch(() => {});
}

await cleanup();
await prisma.$disconnect();
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
