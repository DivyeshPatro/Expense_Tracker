// E2E: bill lifecycle — edit, delete, and the guarantee that deleting a paid
// bill leaves its payment transaction alone.
//
// Non-destructive: creates its own ZZZ-prefixed bills and cleans them up.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { config } from "dotenv";
import { PrismaClient } from "@prisma/client";
config();

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || "http://localhost:3000";
const UNPAID = "ZZZ Unpaid Bill";
const PAID = "ZZZ Paid Bill";
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const prisma = new PrismaClient();
const user = await prisma.user.findUnique({ where: { email: "arjun@ledgerly.app" } });

async function cleanup() {
  await prisma.bill.deleteMany({ where: { userId: user.id, name: { contains: "ZZZ " } } });
  await prisma.transaction.deleteMany({ where: { userId: user.id, merchant: { contains: "ZZZ " } } });
}
await cleanup();

const account = await prisma.account.findFirstOrThrow({ where: { userId: user.id, isArchived: false } });
await prisma.bill.create({
  data: { userId: user.id, name: UNPAID, amount: 120_000, dueDate: new Date("2026-08-15T06:30:00Z"), cadence: "MONTHLY", anchorDay: 15 },
});
// A settled one-off with a real payment behind it.
const paymentTx = await prisma.transaction.create({
  data: {
    userId: user.id, type: "EXPENSE", amount: 150_000, accountId: account.id,
    merchant: PAID, occurredAt: new Date("2026-07-05T06:30:00Z"),
  },
});
await prisma.bill.create({
  data: {
    userId: user.id, name: PAID, amount: 150_000, dueDate: new Date("2026-07-05T06:30:00Z"),
    status: "PAID", paidTxId: paymentTx.id,
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

const billRow = (name) => page.locator("div.flex.items-center.gap-3").filter({ hasText: name }).first();
const settledCard = () => page.locator("div.card").filter({ hasText: "Settled bills" });

async function gotoBills() {
  await page.goto(`${BASE}/bills`, { waitUntil: "domcontentloaded", timeout: 60000 });
  // #209 moved this page's create action off the header and into the quick-add
  // FAB. The gate below waited on the old header button, so every run timed out
  // before its first assertion — the suite has been reporting 0/1 rather than
  // testing anything. Wait on something the page always renders instead, and
  // assert the action separately in its new home.
  await page.getByRole("navigation", { name: "Section views" }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500); // hydration
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

  await gotoBills();
  ok("an unpaid bill is listed with edit and delete", (await billRow(UNPAID).getByRole("button", { name: "Edit" }).count()) === 1);

  // ── Edit ──
  const opened = await clickUntil(billRow(UNPAID).getByRole("button", { name: "Edit" }), page.getByLabel("Bill name"));
  ok("the edit form opens", opened);
  await page.getByLabel("Bill name").fill(`${UNPAID} Renamed`);
  await page.getByRole("button", { name: "Save changes" }).click();
  const renamed = await waitFor(
    () => prisma.bill.findFirst({ where: { userId: user.id, name: `${UNPAID} Renamed` } }),
    "the bill rename to save"
  );
  ok("editing a bill persists", !!renamed);

  // ── Delete an unpaid bill ──
  await gotoBills();
  await billRow(`${UNPAID} Renamed`).getByRole("button", { name: "Delete" }).click();
  await page.waitForTimeout(600);
  ok(
    "the confirmation for an unpaid bill is a plain delete",
    (await billRow(`${UNPAID} Renamed`).innerText()).includes("Delete this bill?")
  );
  await billRow(`${UNPAID} Renamed`).getByRole("button", { name: "Delete" }).click();
  const unpaidGone = await waitFor(
    async () => ((await prisma.bill.count({ where: { userId: user.id, name: `${UNPAID} Renamed` } })) === 0 ? true : null),
    "the unpaid delete"
  );
  ok("an unpaid bill deletes", unpaidGone === true);

  // ── Settled bills remain reachable ──
  await gotoBills();
  const sectionOpened = await clickUntil(
    page.getByRole("button", { name: /Settled bills/ }),
    settledCard().getByRole("button", { name: "Delete" }).first()
  );
  ok("settled one-off bills are still reachable", sectionOpened);

  // ── Delete a paid bill: the payment must survive ──
  await settledCard().getByRole("button", { name: "Delete" }).first().click();
  await page.waitForTimeout(600);
  ok(
    "the confirmation promises the payment is kept",
    (await settledCard().innerText()).includes("Payment stays in your transactions")
  );
  await settledCard().getByRole("button", { name: "Delete" }).first().click();
  const paidGone = await waitFor(
    async () => ((await prisma.bill.count({ where: { userId: user.id, name: PAID } })) === 0 ? true : null),
    "the paid delete"
  );
  ok("a paid bill's reminder deletes", paidGone === true);

  const survivor = await prisma.transaction.findUnique({ where: { id: paymentTx.id } });
  ok(
    "deleting a paid bill leaves the payment transaction intact",
    !!survivor && survivor.deletedAt === null && Number(survivor.amount) === 150_000,
    survivor ? `₹${Number(survivor.amount) / 100} still recorded` : "payment missing"
  );
} catch (e) {
  ok("script error", false, String(e).slice(0, 500));
  const outputDir = path.join(SCRIPT_DIR, "..", "e2e-output");
  fs.mkdirSync(outputDir, { recursive: true });
  await page.screenshot({ path: path.join(outputDir, "bills-error.png"), fullPage: true }).catch(() => {});
}

await cleanup();
await prisma.$disconnect();
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
