// Ledgerly Phase 2.5 (Finance Hub / Product Integration) — Prisma-direct
// setup plus real-browser UI flows: dashboard sections, unified search,
// cross-module navigation, timeline grouping, mobile hub strip. Follows the
// hybrid pattern established in e2e-group-expenses.ts / e2e-lending.ts.
// Run: npx tsx scripts/e2e-finance-hub.ts
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
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

    // Lending activity for Rohan, created before anything below needs it.
    // /lending lists only people with at least one entry, and the demo seed
    // creates none — so without this the contact deep-link and the "via
    // account" cross-link have no contact to open.
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

    // ══════════════ 1. Dashboard: every Finance Hub section present ══════════════
    //
    // Located, not read out of a text blob. `body.innerText()` returns only
    // what the browser considers rendered, and on this page it stops short of
    // the sections below the fold — Financial health, Recent activity and the
    // rest are present, visible and `content-visibility: visible` at
    // offsetTop 1147+, yet absent from innerText. Every "missing section"
    // here was a reading artefact, not a missing section.
    await page.getByRole("heading", { name: "Needs your attention" }).waitFor({ timeout: 20000 });
    for (const label of ["Financial health", "Needs your attention", "Recent activity", "Lending", "Upcoming bills"]) {
      ok(`dashboard shows "${label}" section`, (await page.getByText(label, { exact: true }).count()) > 0);
    }
    // #193 deleted the dashboard's "Settlements" section: it repeated rows the
    // attention surface above it already showed, and /shared owns the full
    // list. Asserting its absence keeps the de-duplication from silently
    // regressing back into a third copy.
    ok('dashboard no longer repeats a "Settlements" section (#193)', (await page.getByText("Settlements", { exact: true }).count()) === 0);

    // The health widget's stats, as the product defines them now. #194 removed
    // "Net Position" deliberately — it was a second balance figure, 400px
    // below the hero's Total Balance and disagreeing with it — and what was
    // "Outstanding Loans" reads "Pending to Receive".
    for (const label of ["Pending to Receive", "Upcoming Bills", "Credit Exposure"]) {
      ok(`Financial health widget shows "${label}"`, (await page.getByText(label, { exact: true }).count()) > 0);
    }
    ok(
      "the dashboard states one balance — no second Net Position figure (#194)",
      (await page.getByText("Net Position", { exact: true }).count()) === 0
    );

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
    // "Opened" means the ledger pane is on screen, which its own quick actions
    // prove — asserted by role rather than by a bare text match.
    await page.getByRole("button", { name: "+ You gave", exact: true }).first().waitFor({ timeout: 20000 });
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

    // ══════════════ 5. Cross-nav: a loan's funding source → Accounts ══════════════
    // The ledger row used to carry a "via HDFC Savings" slot of its own. That
    // was deliberately removed: it is metadata for one transaction, not
    // something you scan a list by, so it lives in the detail sheet the row
    // opens, as the Funding Source. The cross-navigation it provides is
    // unchanged and is what this still asserts — just from where the product
    // now offers it.
    await page.goto(`${BASE}/lending`, { waitUntil: "load" });
    await page.getByRole("button", { name: /Rohan/ }).first().click();
    await page.getByRole("button", { name: "+ You gave", exact: true }).first().waitFor({ timeout: 20000 });
    // The ledger is tabbed: Overview carries the summary and quick actions,
    // the entry rows live under Transactions.
    await page.getByRole("tab", { name: /transactions/i }).first().click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: new RegExp(`View details .*E2EHubLoan-${suffix}`) }).first().click();
    await page.getByText("Funding Source", { exact: true }).waitFor({ timeout: 15000 });
    ok("a loan's detail names the account it came from", (await page.getByText(hdfc.name, { exact: true }).count()) > 0);
    await page.getByText(hdfc.name, { exact: true }).first().click();
    await page.waitForURL("**/accounts**", { timeout: 15000 });
    ok("and that funding source opens Accounts", page.url().includes("/accounts"));

    // ══════════════ 6. Cross-nav: a person → their Lending ledger ══════════════
    // This used to start on /shared, whose balance rows linked straight to
    // /lending?contact=. #207 introduced People as the place that answers
    // "what does this person owe me, in total?" — the question Lending and
    // Shared each answered half of — and the per-person cross-link lives
    // there now. Same destination, same contract, one hop from where a person
    // actually looks it up.
    // Straight to the person's own page: /people lists everyone, and picking
    // "the first link whose name matches" is ambiguous with the nav beside it.
    await page.goto(`${BASE}/people/${rohan.id}`, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    const lendingLink = page.locator(`a[href="/lending?contact=${rohan.id}"]`);
    ok("a person's page links through to their Lending ledger", (await lendingLink.count()) > 0);
    if ((await lendingLink.count()) > 0) {
      await lendingLink.first().click();
      await page.waitForURL("**/lending?contact=**", { timeout: 15000 });
      await page.getByRole("button", { name: "+ You gave", exact: true }).first().waitFor({ timeout: 20000 });
      ok("and that opens the contact's ledger", true);
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
    // Search is a collapsed <details> — opt-in, so it has to be opened first.
    const txSearch = page.locator('input[placeholder^="Search"]');
    if (!(await txSearch.isVisible())) await page.locator("summary").filter({ hasText: "Search" }).first().click();
    await txSearch.waitFor({ state: "visible", timeout: 15000 });
    await txSearch.fill(`E2EHubSplit-${suffix}`);
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: new RegExp(`E2EHubSplit-${suffix}`) }).first().click();
    // Scoped to the open transaction sheet: an unscoped /Rohan/ also resolves
    // ledger rows behind it whose aria-label reads "… paid by Rohan …".
    const txSheet = page.getByRole("dialog").last();
    const rohanSplitBtn = txSheet.getByRole("button", { name: /Rohan/ }).first();
    await rohanSplitBtn.waitFor({ timeout: 15000 });
    await rohanSplitBtn.click();
    await page.getByRole("button", { name: "+ You gave", exact: true }).first().waitFor({ timeout: 20000 });
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
    // Each card is a Link to the module it summarises — asserted as links, not
    // read out of body.innerText(), which does not reach this strip.
    const stripHrefs = { Lending: "/lending", Bills: "/bills", Shared: "/shared", "Net position": "/accounts" };
    for (const [label, href] of Object.entries(stripHrefs)) {
      const card = page.locator(`a[href="${href}"]`).filter({ hasText: label });
      ok(`mobile hub strip offers the ${label} card`, (await card.count()) > 0);
    }
    // "Hidden on mobile" is a LAYOUT claim, not a DOM one: the widget's row is
    // `hidden md:flex`, so it stays in the markup and is simply not laid out.
    // count() would find it either way — visibility is the thing being tested.
    ok(
      "Financial health widget is hidden on mobile (desktop-only per the confirmed trim)",
      (await page.getByText("MONTHLY SPENDING TREND", { exact: true }).first().isVisible().catch(() => false)) === false
    );
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
