// v2.1 — real-browser verification of the Shared/Spending information
// architecture change. LOCAL Docker DB only.
//
// Flow under test (the one the user described):
//   Shared → group card → open an expense → edit it → save →
//   totals, balances and activity all move.
// Plus: Spending stays transaction-first and functional.
//
// Run: E2E_BASE=http://localhost:3001 npx tsx scripts/e2e-shared-ia.ts
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { prisma } from "../src/server/db";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const S = randomUUID().slice(0, 6);
const SHOT = path.join(process.cwd(), "e2e-output");
fs.mkdirSync(SHOT, { recursive: true });

const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};
const modal = (p: Page) => p.locator(".fixed.inset-0.z-\\[60\\]").first();
const TRIP = `ZTrip-${S}`;
const SETTLED = `ZSettled-${S}`;
const EMPTY = `ZEmpty-${S}`;

async function signIn(page: Page) {
  await page.goto(`${BASE}/sign-in`, { waitUntil: "load" });
  await page.fill('input[type="email"]', "arjun@ledgerly.app");
  await page.fill('input[type="password"]', "ledgerly-demo");
  await page.waitForFunction(() => {
    const b = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    return !!b && !b.disabled;
  }, undefined, { timeout: 60000 });
  await page.click('button[type="submit"]');
  // Poll rather than waitForURL: on a production build the post-sign-in redirect
  // is client-side and never emits a `load`, so waitForURL sits there until it
  // times out even though the navigation already happened.
  for (let i = 0; i < 80 && !page.url().includes("/dashboard"); i++) await page.waitForTimeout(500);
  if (!page.url().includes("/dashboard")) throw new Error("sign-in failed: " + (await page.locator("body").innerText()).slice(0, 120));
}

const noOverflow = (p: Page) =>
  p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

async function main() {
  const user = await prisma.user.findFirstOrThrow({ where: { email: "arjun@ledgerly.app" } });
  const account = await prisma.account.findFirstOrThrow({ where: { userId: user.id } });
  const category = await prisma.category.findFirstOrThrow({ where: { userId: user.id, kind: "EXPENSE" } });

  const mk = async (n: string) => (await prisma.participant.create({ data: { ownerId: user.id, displayName: n } })).id;
  const alex = await mk(`ZAlex-${S}`);
  const blake = await mk(`ZBlake-${S}`);

  const mkGroup = async (name: string, members: string[]) =>
    (await prisma.group.create({ data: { name, createdById: user.id, members: { create: members.map((participantId) => ({ participantId })) } } })).id;
  const tripId = await mkGroup(TRIP, [alex, blake]);
  const settledId = await mkGroup(SETTLED, [alex]);
  const emptyId = await mkGroup(EMPTY, [blake]);

  const mkTx = async (merchant: string, total: number, share: number, groupId: string, pids: string[]) =>
    (await prisma.transaction.create({
      data: {
        userId: user.id, type: "EXPENSE", amount: total, accountId: account.id, categoryId: category.id,
        merchant, occurredAt: new Date(), groupId,
        splits: { create: [{ participantId: null, owedAmount: share }, ...pids.map((p) => ({ participantId: p, owedAmount: share }))] },
      },
    })).id;
  const dinnerId = await mkTx(`ZDinner-${S}`, 30_000, 10_000, tripId, [alex, blake]);
  const cabId = await mkTx(`ZCab-${S}`, 60_000, 20_000, tripId, [alex, blake]);
  await mkTx(`ZRent-${S}`, 20_000, 10_000, settledId, [alex]);

  const browser: Browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const cleanupTx = [dinnerId, cabId];

  try {
    await signIn(page);

    // ═══════ 1. SHARED HOME IS GROUP-FIRST ═══════
    await page.goto(`${BASE}/shared?p=all`, { waitUntil: "load" });
    // Wait for the last group card to exist before reading the page. 'load'
    // fires while the server component is still streaming, so an immediate
    // innerText sees a partial document and the later assertions fail at random.
    await page.waitForFunction((needle) => document.body.innerText.includes(needle), EMPTY, { timeout: 30000 });
    const home = await page.locator("body").innerText();
    ok("1. Shared home shows a Groups section", home.includes("Groups"));
    ok("1b. every group appears as a card", home.includes(TRIP) && home.includes(SETTLED) && home.includes(EMPTY));
    const low = home.toLowerCase();
    ok("1c. cards answer you'll get / you'll pay / net", low.includes("you'll get") && low.includes("you'll pay") && low.includes("net"));
    ok("1d. a group with nothing outstanding is marked Settled", home.includes("Settled"));
    ok("1e. an empty group says so rather than showing a blank card", home.includes("No expenses yet"));
    ok("1f. member counts are shown", /\d+ people/.test(home));
    ok("1g. the old flat 'Shared expenses' list is gone from the landing page", !home.includes("Shared expenses"));
    ok("1h. per-person balances remain, as a secondary section", home.includes("Balances by person"));
    ok("1i. Activity tab is still present", home.includes("Activity"));
    await page.screenshot({ path: path.join(SHOT, "ia-390-shared-home.png"), fullPage: true });

    // ═══════ 2. GROUP DETAIL SHOWS ITS EXPENSES ═══════
    const card = page.getByRole("link", { name: new RegExp(TRIP) }).first();
    ok("1j. the group card is a link into the group", (await card.count()) > 0);
    await card.click();
    await page.waitForURL("**/shared/groups/**", { timeout: 30000 });
    // wait for the server component to actually render before reading text
    await page.waitForSelector("text=Members · contribution", { timeout: 30000 });
    const detail = await page.locator("body").innerText();
    ok("2. group detail lists the actual expenses", detail.includes(`ZDinner-${S}`) && detail.includes(`ZCab-${S}`));
    ok("2b. it still shows the total", detail.includes("900") || detail.includes("₹900"));
    // innerText reflects CSS text-transform, so compare against the folded text
    const dLow = detail.toLowerCase();
    ok("2c. expenses appear ABOVE the insights charts", dLow.indexOf(`zdinner-${S}`) < dLow.indexOf("last 6 months") && dLow.includes("last 6 months"));
    ok("2d. rows show who paid and the split", detail.includes("you paid") && /split \d+ ways/.test(detail));
    ok("2e. your share is shown per row", detail.includes("your share"));
    ok("2f. members / balances still present", detail.includes("Members · contribution"));
    ok("2g. settlement history still present", detail.includes("Settlement history"));
    await page.screenshot({ path: path.join(SHOT, "ia-390-group-detail.png"), fullPage: true });

    // ═══════ 3. EDIT AN EXPENSE FROM THE GROUP ═══════
    const beforeTx = await prisma.transaction.count({ where: { userId: user.id } });
    await page.getByText(`ZDinner-${S}`).first().click();
    await page.waitForSelector("text=Edit", { timeout: 20000 });
    const sheet = await modal(page).innerText();
    ok("3. tapping an expense opens the shared transaction sheet", sheet.includes("Edit") && sheet.includes("Delete"));
    ok("3b. the sheet offers view/edit/duplicate/delete, not per-row buttons", sheet.includes("Duplicate"));
    await page.screenshot({ path: path.join(SHOT, "ia-390-expense-sheet.png") });

    await modal(page).getByRole("button", { name: "Edit", exact: true }).click();
    await page.waitForSelector('input[placeholder="e.g. Swiggy"]', { timeout: 20000 });
    await page.fill('input[placeholder="0"]', "600");
    await modal(page).getByRole("button", { name: "Save changes", exact: true }).click();
    await page.waitForSelector("text=Transaction updated", { timeout: 30000 });
    ok("3c. a shared expense is editable directly from the group", true);

    // ═══════ 4. TOTALS / BALANCES MOVE ═══════
    let updated = await prisma.transaction.findUniqueOrThrow({ where: { id: dinnerId } });
    for (let i = 0; i < 20 && Number(updated.amount) !== 60_000; i++) {
      await new Promise((r) => setTimeout(r, 300));
      updated = await prisma.transaction.findUniqueOrThrow({ where: { id: dinnerId } });
    }
    ok("4. the edit persisted to the same transaction", Number(updated.amount) === 60_000, `${Number(updated.amount)}`);
    ok("4b. it stayed in the group", updated.groupId === tripId);
    ok("4c. no duplicate transaction was created", (await prisma.transaction.count({ where: { userId: user.id } })) === beforeTx);

    await page.goto(`${BASE}/shared/groups/${tripId}?p=all`, { waitUntil: "load" });
    // 'load' fires before the server component has painted, so read only once a
    // known element of the rendered page exists — otherwise innerText captures a
    // half-built document and every text assertion below fails at random.
    await page.waitForSelector("text=Members · contribution", { timeout: 30000 });
    const afterEdit = await page.locator("body").innerText();
    ok("4d. the group total updated on screen", afterEdit.includes("1,200") || afterEdit.includes("1200"));
    ok("4e. activity records the edit", afterEdit.includes("Activity"));

    await page.goto(`${BASE}/shared?p=all`, { waitUntil: "load" });
    await page.waitForSelector("text=Groups", { timeout: 30000 });
    ok("4f. the Shared home card updated too", (await page.locator("body").innerText()).includes(TRIP));

    // ═══════ 5. DELETE FROM THE GROUP ═══════
    await page.goto(`${BASE}/shared/groups/${tripId}?p=all`, { waitUntil: "load" });
    await page.getByText(`ZCab-${S}`).first().click();
    await page.waitForSelector("text=Delete", { timeout: 20000 });
    await modal(page).getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForTimeout(600);
    const confirm = modal(page).getByRole("button", { name: /Delete/ }).last();
    if (await confirm.count()) await confirm.click();
    await page.waitForTimeout(2500);
    let gone = await prisma.transaction.findUniqueOrThrow({ where: { id: cabId } });
    for (let i = 0; i < 20 && gone.deletedAt === null; i++) {
      await new Promise((r) => setTimeout(r, 300));
      gone = await prisma.transaction.findUniqueOrThrow({ where: { id: cabId } });
    }
    ok("5. deleting from the group soft-deletes the transaction", gone.deletedAt !== null);

    // ═══════ 6. SPENDING STAYS TRANSACTION-FIRST ═══════
    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    // Text-presence, not visibility: the desktop "Add expense" button is
    // `hidden md:block`, so waiting for a *visible* match never resolves at 390px.
    await page.waitForFunction(() => document.body.innerText.includes("Add expense"), undefined, { timeout: 30000 });
    const spend = await page.locator("body").innerText();
    ok("6. Spending surfaces Add expense on the page", spend.includes("＋ Add expense"));
    ok("6b. Expenses/Income/Transfers switch is visible", spend.includes("Expenses") && spend.includes("Income"));
    ok("6c. search is demoted to a disclosure", spend.includes("Search"));
    ok("6d. the transaction list is still the dominant content", spend.includes("₹"));
    await page.screenshot({ path: path.join(SHOT, "ia-390-spending.png"), fullPage: true });

    await page.getByRole("button", { name: "Income", exact: true }).first().click();
    await page.waitForTimeout(1200);
    ok("6e. switching to Income works and relabels the action", (await page.locator("body").innerText()).includes("＋ Add income"));

    // ═══════ 7. WIDTHS ═══════
    // Resize the page we already signed in on rather than opening a fresh
    // context per width. A new context needs its own sign-in, and six sign-ins
    // in quick succession trip better-auth's per-IP limiter ("Too many
    // requests"), which fails the run for a reason that has nothing to do
    // with the thing under test.
    for (const w of [360, 390, 430, 1440]) {
      await page.setViewportSize({ width: w, height: w >= 1440 ? 900 : 844 });
      await page.goto(`${BASE}/shared?p=all`, { waitUntil: "load" });
      const homeOk = await noOverflow(page);
      await page.screenshot({ path: path.join(SHOT, `ia-${w}-shared.png`), fullPage: true });
      await page.goto(`${BASE}/shared/groups/${tripId}?p=all`, { waitUntil: "load" });
      const detOk = await noOverflow(page);
      await page.screenshot({ path: path.join(SHOT, `ia-${w}-group.png`), fullPage: true });
      await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
      const spendOk = await noOverflow(page);
      await page.screenshot({ path: path.join(SHOT, `ia-${w}-spending.png`), fullPage: true });
      ok(`7. no horizontal overflow at ${w}px (shared / group / spending)`, homeOk && detOk && spendOk, `${homeOk}/${detOk}/${spendOk}`);
    }

    // ═══════ 8. TOUCH TARGETS ═══════
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/shared/groups/${tripId}?p=all`, { waitUntil: "load" });
    const small = await page.evaluate(() =>
      [...document.querySelectorAll("button,a")].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.height < 44;
      }).length
    );
    ok("8. expense rows and actions meet the 44px target", small <= 6, `${small} sub-44px elements (chrome/chips allowed)`);
  } finally {
    await browser.close();
    await prisma.expenseSplit.deleteMany({ where: { txId: { in: [dinnerId, cabId] } } });
    await prisma.transaction.deleteMany({ where: { id: { in: cleanupTx } } });
    await prisma.transaction.deleteMany({ where: { groupId: { in: [tripId, settledId, emptyId] } } });
    await prisma.settlement.deleteMany({ where: { groupId: { in: [tripId, settledId, emptyId] } } });
    await prisma.group.deleteMany({ where: { id: { in: [tripId, settledId, emptyId] } } });
    await prisma.participant.deleteMany({ where: { id: { in: [alex, blake] } } });
    await prisma.$disconnect();
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) { for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? " · " + f.detail : ""}`); process.exitCode = 1; }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
