// Ledgerly Phase 2.5 (Finance Hub / Product Integration) — Prisma-direct
// setup plus real-browser UI flows: dashboard sections, unified search,
// cross-module navigation, timeline grouping, mobile hub strip. Follows the
// hybrid pattern established in e2e-group-expenses.ts / e2e-lending.ts.
// Run: npx tsx scripts/e2e-finance-hub.ts
import { randomUUID } from "node:crypto";
import { chromium, type Page } from "playwright";
import { prisma } from "../src/server/db";
import { addExpense } from "../src/server/services/transactions";

const BASE = "http://localhost:3000";
const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

async function main() {
  const suffix = randomUUID().slice(0, 8);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  const alice = await prisma.user.findFirstOrThrow({ where: { email: "arjun@ledgerly.app" } });
  const rohan = await prisma.participant.findFirstOrThrow({ where: { ownerId: alice.id, displayName: "Rohan" } });
  const hdfc = await prisma.account.findFirstOrThrow({ where: { userId: alice.id, name: "HDFC Savings" } });

  const entryIds: string[] = [];
  const txIds: string[] = [];

  try {
    await page.goto(`${BASE}/sign-in`, { waitUntil: "load" });
    await page.fill('input[type="email"]', "arjun@ledgerly.app");
    await page.fill('input[type="password"]', "ledgerly-demo");
    await page.click('button[type="submit"]');
    await page.waitForURL("**/dashboard", { timeout: 20000 });

    // ══════════════ 1. Dashboard: every Finance Hub section present ══════════════
    await page.waitForTimeout(1200);
    const dashBody = await page.locator("body").innerText();
    for (const label of ["Financial health", "Needs your attention", "Recent activity", "Lending", "Upcoming bills", "Settlements"]) {
      ok(`dashboard shows "${label}" section`, dashBody.includes(label));
    }
    ok("Financial health widget shows Net Position / Outstanding Loans / Credit Exposure", ["NET POSITION", "OUTSTANDING LOANS", "CREDIT EXPOSURE"].every((l) => dashBody.toUpperCase().includes(l)));

    // ══════════════ 2. Dashboard stat cards deep-link ══════════════
    await page.getByText("EXPENSE ·", { exact: false }).first().click();
    await page.waitForURL("**/transactions**", { timeout: 10000 });
    ok("Expense stat card deep-links to /transactions", page.url().includes("/transactions"));

    // ══════════════ 3. Unified search: contacts ══════════════
    await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    await page.getByRole("button", { name: /Search/ }).first().click();
    await page.waitForSelector('input[aria-label="Search everything"]', { timeout: 10000 });
    await page.fill('input[aria-label="Search everything"]', "Rohan");
    await page.getByRole("option", { name: /Rohan/ }).first().waitFor({ timeout: 15000 });
    const searchBody = await page.locator('[role="listbox"]').innerText();
    ok("unified search shows a Contacts section header", searchBody.toUpperCase().includes("CONTACTS"));
    await page.getByRole("option", { name: /Rohan/ }).first().click();
    await page.waitForURL("**/lending?contact=**", { timeout: 10000 });
    await page.waitForSelector("text=+ You Gave", { timeout: 15000 });
    ok("clicking a contact search result opens that contact's ledger", true);

    // ══════════════ 4. Unified search: accounts ══════════════
    await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    await page.getByRole("button", { name: /Search/ }).first().click();
    await page.waitForSelector('input[aria-label="Search everything"]', { timeout: 10000 });
    await page.fill('input[aria-label="Search everything"]', "HDFC");
    // debounced (220ms) + a server-action round trip — poll instead of a
    // fixed wait, since a cold code path can take several seconds. Scoped
    // to the results listbox — the dashboard page behind the palette
    // overlay ALSO shows "HDFC Savings" in its own Accounts section, so an
    // unscoped getByText resolves instantly against the wrong element.
    const resultsBox = page.locator('[role="listbox"]');
    await resultsBox.getByText("HDFC Savings", { exact: true }).first().waitFor({ timeout: 15000 });
    const acctSearchBody = await resultsBox.innerText();
    ok("unified search shows an Accounts section for a matching account name", acctSearchBody.toUpperCase().includes("ACCOUNTS"));
    await page.keyboard.press("Escape").catch(() => {});

    // ══════════════ 5. Cross-nav: Lending "via account" → Accounts ══════════════
    const seededEntry = await prisma.loanEntry.create({
      data: {
        userId: alice.id,
        participantId: rohan.id,
        kind: "GAVE",
        amount: 50000,
        accountId: hdfc.id,
        reason: `E2EHubLoan-${suffix}`,
        occurredAt: new Date(),
      },
    });
    entryIds.push(seededEntry.id);

    await page.goto(`${BASE}/lending`, { waitUntil: "load" });
    await page.getByRole("button", { name: /Rohan/ }).first().click();
    await page.waitForSelector("text=+ You Gave", { timeout: 15000 });
    const viaLink = page.locator('span[role="link"]', { hasText: `via ${hdfc.name}` }).first();
    await viaLink.waitFor({ timeout: 10000 });
    await viaLink.click();
    await page.waitForURL("**/accounts", { timeout: 10000 });
    ok("Lending entry's funding-source link opens Accounts", page.url().endsWith("/accounts"));

    // ══════════════ 6. Cross-nav: Shared page member → Lending contact ══════════════
    await page.goto(`${BASE}/shared`, { waitUntil: "load" });
    await page.waitForTimeout(800);
    const memberLinkCount = await page.locator(`a[href="/lending?contact=${rohan.id}"]`).count();
    ok("Shared page links Rohan's balance row to his Lending contact", memberLinkCount > 0);
    if (memberLinkCount > 0) {
      await page.locator(`a[href="/lending?contact=${rohan.id}"]`).first().click();
      await page.waitForURL("**/lending?contact=**", { timeout: 10000 });
      await page.waitForSelector("text=+ You Gave", { timeout: 15000 });
      ok("clicking the Shared member row opens the Lending contact ledger", true);
    }

    // ══════════════ 7. Cross-nav: split transaction participant → Lending contact modal ══════════════
    const txId = await addExpense(alice.id, {
      amount: 60000,
      accountId: hdfc.id,
      categoryId: null,
      merchant: `E2EHubSplit-${suffix}`,
      date: new Date().toISOString().slice(0, 10),
      split: { mode: "EQUAL", participantIds: [rohan.id], payerParticipantId: null },
    });
    txIds.push(txId);

    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await page.fill('input[placeholder*="Search"]', `E2EHubSplit-${suffix}`).catch(() => {});
    await page.waitForTimeout(600);
    await page.getByText(`E2EHubSplit-${suffix}`, { exact: false }).first().click();
    await page.waitForSelector("text=Split", { timeout: 10000 });
    const rohanSplitBtn = page.getByRole("button", { name: /Rohan/ }).first();
    await rohanSplitBtn.waitFor({ timeout: 10000 });
    await rohanSplitBtn.click();
    await page.waitForSelector("text=+ You Gave", { timeout: 15000 });
    ok("clicking a split participant in Transaction Detail opens their Lending contact", true);

    // ══════════════ 8. Timeline: Today/Yesterday/This Week/Earlier grouping ══════════════
    await page.goto(`${BASE}/activity`, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    const activityBody = await page.locator("body").innerText();
    const bucketFound = ["TODAY", "YESTERDAY", "THIS WEEK", "EARLIER"].some((b) => activityBody.toUpperCase().includes(b));
    ok("Activity Timeline groups events into Today/Yesterday/This Week/Earlier buckets", bucketFound);

    // ══════════════ 9. Mobile hub strip ══════════════
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    const mobileBody = await page.locator("body").innerText();
    ok("mobile hub strip shows Lending/Bills/Shared/Net position cards", ["Lending", "Bills", "Shared", "Net position"].every((l) => mobileBody.includes(l)));
    ok("Financial health widget is hidden on mobile (desktop-only per the confirmed trim)", !mobileBody.toUpperCase().includes("MONTHLY SPENDING TREND"));
    await page.setViewportSize({ width: 1280, height: 900 });
  } catch (e) {
    ok("script error", false, String(e).slice(0, 900));
    await page.screenshot({ path: "e2e-output/finance-hub-error.png", fullPage: true }).catch(() => {});
  } finally {
    await prisma.loanEntry.deleteMany({ where: { id: { in: entryIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...entryIds, ...txIds] } } });
    await prisma.intent.deleteMany({ where: { entityId: { in: [...entryIds, ...txIds] } } });
    for (const id of txIds) {
      await prisma.expenseSplit.deleteMany({ where: { txId: id } });
      await prisma.transaction.deleteMany({ where: { id } });
    }
    await browser.close();
  }
}

main()
  .catch((e) => {
    ok("script error", false, String(e).slice(0, 800));
  })
  .finally(async () => {
    await prisma.$disconnect();
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  });
