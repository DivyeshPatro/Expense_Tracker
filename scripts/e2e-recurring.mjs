// E2E: recurring transactions — create from the expense form, manage in Settings.
//
// Non-destructive: everything it creates carries the ZZZ Recurring prefix and is
// cleaned up before each run, so it can run against the demo seed repeatedly.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { config } from "dotenv";
import { PrismaClient } from "@prisma/client";
config();

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || "http://localhost:3000";
const MERCHANT = "ZZZ Recurring Test";
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const prisma = new PrismaClient();
const user = await prisma.user.findUnique({ where: { email: "arjun@ledgerly.app" } });
if (user) {
  // Leftovers from a previous run would make the assertions below ambiguous.
  await prisma.transaction.deleteMany({ where: { userId: user.id, merchant: { contains: MERCHANT } } });
  const stale = await prisma.recurringRule.findMany({ where: { userId: user.id } });
  for (const r of stale) {
    if (String(r.template?.merchant ?? "").includes(MERCHANT)) {
      await prisma.recurringRule.delete({ where: { id: r.id } });
    }
  }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

/** The rule this run created, looked up by its distinctive merchant. */
async function findRule() {
  const rules = await prisma.recurringRule.findMany({ where: { userId: user.id } });
  return rules.find((r) => String(r.template?.merchant ?? "").includes(MERCHANT)) ?? null;
}

/**
 * Expense creates go through the offline outbox, so the modal closing only means
 * the intent was queued — poll for the server state rather than guessing a delay
 * (same reason e2e-lending.ts polls instead of sleeping).
 */
async function waitFor(fn, label, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    const v = await fn();
    if (v) return v;
    await page.waitForTimeout(300);
  }
  console.log(`  (gave up waiting for ${label} after ${(attempts * 300) / 1000}s)`);
  return null;
}

function settingsSection() {
  return page.locator("section.card").filter({ hasText: "Recurring transactions" });
}

/**
 * The row container for our rule specifically. Filtering plain `div`s would also
 * match the list wrapper (which holds every rule) and the inner text spans (which
 * hold no buttons) — with the seed's own Netflix rule present, that ambiguity
 * picks the wrong row's buttons.
 */
function ruleRow() {
  return settingsSection().locator("div.flex.items-center.gap-3").filter({ hasText: MERCHANT });
}

try {
  // ── Sign in (wait for hydration to avoid a native form GET). ──
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
  await page.waitForTimeout(2000);

  // ── Create an expense with "Repeat this" ticked ──
  await page.getByRole("button", { name: /Add expense/ }).first().click();
  const modal = page.getByRole("dialog");
  await modal.waitFor({ timeout: 30000 });
  await page.waitForTimeout(2000); // hydration before interacting

  ok("expense form offers a Repeat option", await modal.getByText("Repeat this").isVisible());

  await modal.locator('input[placeholder="0"]').fill("899");
  await modal.locator('input[placeholder="e.g. Swiggy"]').fill(MERCHANT);
  await modal.getByText("Repeat this").click();
  await page.waitForTimeout(700);
  const repeatText = await modal.innerText();
  ok(
    "the derived next-run date is shown before submitting",
    /the next is scheduled for \d{4}-\d{2}-\d{2}/.test(repeatText),
    (repeatText.match(/the next is scheduled for \d{4}-\d{2}-\d{2}/) ?? [""])[0]
  );

  await modal.getByRole("button", { name: "Add expense", exact: true }).click();
  // The modal closes only on success, so this is the real "submitted" signal.
  await modal.waitFor({ state: "detached", timeout: 30000 });

  const tx = await waitFor(
    () => prisma.transaction.findFirst({ where: { userId: user.id, merchant: MERCHANT } }),
    "the transaction to sync"
  );
  ok("the transaction itself is created", !!tx, tx ? `₹${Number(tx.amount) / 100}` : "missing");

  const rule = await waitFor(findRule, "the recurring rule");
  ok("a recurring rule is created alongside it", !!rule);
  if (!rule || !tx) throw new Error("no rule to continue with");

  // The submitted transaction is the first occurrence, so the schedule must
  // start later — otherwise the next cron run duplicates what was just added.
  const txYmd = tx.occurredAt.toISOString().slice(0, 10);
  const nextYmd = rule.nextRunAt.toISOString().slice(0, 10);
  ok("the schedule starts after the transaction, not on it", nextYmd > txYmd, `tx ${txYmd} → next ${nextYmd}`);
  ok("month-based rules are anchored to the start day", rule.anchorDay === Number(txYmd.slice(8, 10)), `anchorDay=${rule.anchorDay}`);

  // ── It appears in Settings ──
  await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("text=Recurring transactions", { timeout: 30000 });
  await page.waitForTimeout(2500);
  const listed = await settingsSection().innerText();
  ok("the rule is listed in Settings with its cadence", listed.includes(MERCHANT) && /Every month/.test(listed));

  // ── Pause ──
  await ruleRow().getByRole("button", { name: "Pause" }).click();
  const paused = await waitFor(async () => ((await findRule())?.isPaused ? true : null), "the pause to save");
  ok("pausing the rule persists", paused === true);
  // Wait on the badge itself: the database write and the router refresh that
  // re-renders the list complete independently, so a fixed pause between them
  // reads a stale row often enough to fail intermittently.
  const badge = await ruleRow()
    .getByText("PAUSED")
    .waitFor({ timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  ok("a paused rule is labelled as such", badge);

  // ── Resume ──
  await ruleRow().getByRole("button", { name: "Resume" }).click();
  const resumed = await waitFor(async () => ((await findRule())?.isPaused === false ? true : null), "the resume to save");
  ok("resuming the rule persists", resumed === true);
  await ruleRow().getByRole("button", { name: "Pause" }).waitFor({ timeout: 15000 }).catch(() => {});

  // ── Delete — the rule goes, the transaction it already created stays ──
  await ruleRow().getByRole("button", { name: "Delete" }).click();
  await page.waitForTimeout(600);
  // The confirm step replaces the row's buttons with Delete / Keep.
  await ruleRow().getByRole("button", { name: "Delete" }).click();
  const gone = await waitFor(async () => ((await findRule()) === null ? true : null), "the delete to save");

  ok("deleting removes the rule", gone === true);
  const survivor = await prisma.transaction.findFirst({ where: { userId: user.id, merchant: MERCHANT, deletedAt: null } });
  ok("deleting a rule never deletes the transactions it created", !!survivor);
} catch (e) {
  ok("script error", false, String(e).slice(0, 500));
  const outputDir = path.join(SCRIPT_DIR, "..", "e2e-output");
  fs.mkdirSync(outputDir, { recursive: true });
  await page.screenshot({ path: path.join(outputDir, "recurring-error.png"), fullPage: true }).catch(() => {});
}

// Leave the ledger as we found it.
if (user) {
  await prisma.transaction.deleteMany({ where: { userId: user.id, merchant: { contains: MERCHANT } } });
}
await prisma.$disconnect();
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
