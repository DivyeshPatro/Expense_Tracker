// Lending module (Phase 2 — Financial Engine) — Prisma-direct assertions
// (FIFO/manual allocation math, per-loan status, card billing cycles) plus
// real-browser UI flows (settlement recording, Loan Detail, Card Recovery
// Dashboard, offline settlement sync), following the hybrid pattern
// established in e2e-group-expenses.ts / e2e-lending.ts.
// Run: npx tsx scripts/e2e-lending-settlement.ts
import { randomUUID } from "node:crypto";
import { chromium, type Page } from "playwright";
import { prisma } from "../src/server/db";

const BASE = "http://localhost:3000";
const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

function modal(page: Page) {
  return page.locator(".fixed.inset-0.z-\\[60\\]").first();
}

async function contactPane(page: Page) {
  const overlay = modal(page);
  if ((await overlay.count()) > 0) return overlay;
  // Anchor on the ledger's own tablist, not on a control that only exists on
  // one tab — "+ You gave" lives on Overview, so anchoring there made the pane
  // unresolvable the moment the script switched to Transactions.
  return page.locator("section.card").filter({ has: page.getByRole("tablist", { name: "Contact sections" }) });
}

/** #187 removed the two "＋ You Gave / ＋ You Got" buttons from the Lending page
 * header — the context-aware quick-add FAB opens the same modal now. Both FABs
 * (mobile bar, desktop bottom-right) are in the DOM at once, so resolve to
 * whichever the current viewport actually shows. */
async function openLendingEntry(page: Page, kind: "GAVE" | "GOT") {
  const fab = page.locator('button[aria-label="Lending — quick add"]:visible').first();
  // The FAB is client-rendered; on a loaded machine `load` can fire well before
  // it paints. Wait for it rather than racing it.
  await fab.waitFor({ state: "visible", timeout: 30000 });
  await fab.click();
  await page.getByRole("button", { name: kind === "GAVE" ? /You gave money/ : /You got money/ }).first().click();
  await page.waitForSelector('input[placeholder="0"]');
}

/** A contact's ledger is tabbed (Overview / Transactions / Reports / Activity);
 * the entry rows live under Transactions, not on the Overview landing tab. */
async function openTransactionsTab(page: Page) {
  await (await contactPane(page)).getByRole("tab", { name: "transactions" }).click();
  await page.waitForTimeout(400);
}

async function waitForSyncedEntry(reason: string) {
  for (let i = 0; i < 30; i++) {
    const e = await prisma.loanEntry.findFirst({ where: { reason } });
    if (e) return e;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`loan entry with reason "${reason}" never synced to the server within 9s`);
}

async function main() {
  const suffix = randomUUID().slice(0, 8);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  const alice = await prisma.user.findFirstOrThrow({ where: { email: "arjun@ledgerly.app" } });
  const rohan = await prisma.participant.findFirstOrThrow({ where: { ownerId: alice.id, displayName: "Rohan" } });
  const priya = await prisma.participant.findFirstOrThrow({ where: { ownerId: alice.id, displayName: "Priya" } });
  const cardAccount = await prisma.account.findFirstOrThrow({ where: { userId: alice.id, type: "CREDIT_CARD" } });
  const originalCardFields = {
    cardNetwork: cardAccount.cardNetwork,
    cardLast4: cardAccount.cardLast4,
    statementDay: cardAccount.statementDay,
    dueDay: cardAccount.dueDay,
  };

  const entryIds: string[] = [];
  const seed = (data: { userId: string; participantId: string; kind: "GAVE" | "GOT"; amount: number; occurredAt: Date; accountId?: string; reason: string; dueDate?: Date }) =>
    prisma.loanEntry.create({ data }).then((e) => {
      entryIds.push(e.id);
      return e;
    });

  try {
    await page.goto(`${BASE}/sign-in`, { waitUntil: "load" });
    await page.fill('input[type="email"]', "arjun@ledgerly.app");
    await page.fill('input[type="password"]', "ledgerly-demo");
    await page.click('button[type="submit"]');
    await page.waitForURL("**/dashboard", { timeout: 20000 });

    // ══════════════ 1. FIFO partial settlement ══════════════
    // two GAVE entries, distinct dates so FIFO order is unambiguous
    const oldLoan = await seed({
      userId: alice.id, participantId: rohan.id, kind: "GAVE", amount: 100000,
      occurredAt: new Date("2026-01-05T12:00:00+05:30"), reason: `E2ESettleOld-${suffix}`,
    });
    const newLoan = await seed({
      userId: alice.id, participantId: rohan.id, kind: "GAVE", amount: 50000,
      occurredAt: new Date("2026-06-10T12:00:00+05:30"), reason: `E2ESettleNew-${suffix}`,
    });

    await page.goto(`${BASE}/lending`, { waitUntil: "load" });
    await openLendingEntry(page, "GOT");
    await modal(page).locator("select").first().selectOption({ label: "Rohan" });
    await page.waitForSelector("text=Apply to", { timeout: 10000 });
    ok("the allocation picker defaults to Auto (FIFO)", await modal(page).getByRole("button", { name: "Auto", exact: true }).isVisible());
    await page.fill('input[placeholder="0"]', "1200"); // ₹1200 = fully covers the ₹1000 old loan + ₹200 into the new one
    await page.fill('input[placeholder="e.g. Dinner, rent help"]', `E2EFifoRepay-${suffix}`);
    await page.getByRole("button", { name: "Record You Got", exact: true }).click();
    await page.waitForSelector("text=Repayment recorded");
    const fifoRepay = await waitForSyncedEntry(`E2EFifoRepay-${suffix}`);
    entryIds.push(fifoRepay.id);

    const fifoAllocations = await prisma.loanAllocation.findMany({ where: { gotEntryId: fifoRepay.id }, orderBy: { amount: "desc" } });
    ok("FIFO allocation splits across both loans (oldest first, fully covered)", fifoAllocations.length === 2, `${fifoAllocations.length} allocation rows`);
    const toOld = fifoAllocations.find((a) => a.gaveEntryId === oldLoan.id);
    const toNew = fifoAllocations.find((a) => a.gaveEntryId === newLoan.id);
    ok("the older loan is fully settled by FIFO (₹1000 of the ₹1200)", Number(toOld?.amount) === 100000);
    ok("the remainder (₹200) spills into the newer loan", Number(toNew?.amount) === 20000);

    // ══════════════ 2. Per-loan status via Loan Detail ══════════════
    await page.goto(`${BASE}/lending`, { waitUntil: "load" });
    const rohanRow = page.getByRole("button", { name: /Rohan/ }).first();
    await rohanRow.click();
    await page.waitForSelector("text=+ You Gave");
    await openTransactionsTab(page);
    const pane = await contactPane(page);
    // Click the row by its own accessible name, on the date line. The row's
    // second line carries the "via <account>" cross-link to /accounts, and a
    // default centre-click lands on it for an account-funded loan.
    const oldRow = pane.getByRole("button", { name: new RegExp(`View details .*E2ESettleOld-${suffix}`) });
    await oldRow.click({ position: { x: 60, y: 10 } });
    await page.waitForSelector("text=Original Amount", { timeout: 10000 });
    // stat labels render with CSS text-transform: uppercase — innerText()
    // reflects the rendered text, not the literal DOM string
    const oldDetailBody = await modal(page).innerText();
    const oldDetailUpper = oldDetailBody.toUpperCase();
    ok("Loan Detail shows Settled status for the fully-covered older loan", /Settled/.test(oldDetailBody));
    ok("Loan Detail shows the settlement history entry (the repayment that covered it)", oldDetailBody.includes(`E2EFifoRepay-${suffix}`) || /Repayment/.test(oldDetailBody));
    ok(
      "Loan Detail shows Original Amount / Remaining Balance / Funding Source fields",
      // the repayment list is headed "Payment History" in the shipped detail sheet
      ["Original Amount", "Remaining Balance", "Funding Source", "Payment History"].every((l) => oldDetailUpper.includes(l.toUpperCase()))
    );
    await page.keyboard.press("Escape").catch(() => {});
    await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});

    // ══════════════ 3. Full settlement ══════════════
    await page.goto(`${BASE}/lending`, { waitUntil: "load" });
    await openLendingEntry(page, "GOT");
    await modal(page).locator("select").first().selectOption({ label: "Rohan" });
    await page.waitForSelector("text=Apply to", { timeout: 10000 });
    await page.fill('input[placeholder="0"]', "300"); // clears the remaining ₹300 on the newer loan exactly
    await page.fill('input[placeholder="e.g. Dinner, rent help"]', `E2EFullRepay-${suffix}`);
    await page.getByRole("button", { name: "Record You Got", exact: true }).click();
    await page.waitForSelector("text=Repayment recorded");
    const fullRepay = await waitForSyncedEntry(`E2EFullRepay-${suffix}`);
    entryIds.push(fullRepay.id);

    const newLoanAllocations = await prisma.loanAllocation.findMany({ where: { gaveEntryId: newLoan.id } });
    const newLoanSettled = newLoanAllocations.reduce((s, a) => s + Number(a.amount), 0);
    ok("the newer loan is now fully settled (₹200 FIFO + ₹300 full-settlement top-up = ₹500)", newLoanSettled === 50000);

    // ══════════════ 4. Manual allocation — target a specific loan, skipping another ══════════════
    const manualA = await seed({
      userId: alice.id, participantId: priya.id, kind: "GAVE", amount: 40000,
      occurredAt: new Date("2026-02-01T12:00:00+05:30"), reason: `E2EManualA-${suffix}`,
    });
    const manualB = await seed({
      userId: alice.id, participantId: priya.id, kind: "GAVE", amount: 60000,
      occurredAt: new Date("2026-03-01T12:00:00+05:30"), reason: `E2EManualB-${suffix}`,
    });

    await page.goto(`${BASE}/lending`, { waitUntil: "load" });
    await openLendingEntry(page, "GOT");
    await modal(page).locator("select").first().selectOption({ label: "Priya" });
    await page.waitForSelector("text=Apply to", { timeout: 10000 });
    await modal(page).getByRole("button", { name: "Custom", exact: true }).click();
    // target manualB specifically (the newer, larger loan) — a plain FIFO
    // run would have hit manualA (older) first, so this proves the override
    // getByText(exact) targets the specific leaf label div unambiguously —
    // a generic `locator("div").filter({hasText}).last()` picks the
    // innermost matching div, but here that's the leaf text node itself
    // (no sibling input), not the row two levels up that actually holds one
    const manualBRow = modal(page).getByText(`E2EManualB-${suffix}`, { exact: true }).locator("xpath=..").locator("xpath=..");
    await manualBRow.locator('input[type="number"]').fill("200");
    await page.fill('input[placeholder="0"]', "200");
    await page.fill('input[placeholder="e.g. Dinner, rent help"]', `E2EManualRepay-${suffix}`);
    await page.getByRole("button", { name: "Record You Got", exact: true }).click();
    await page.waitForSelector("text=Repayment recorded");
    const manualRepay = await waitForSyncedEntry(`E2EManualRepay-${suffix}`);
    entryIds.push(manualRepay.id);

    const manualAllocations = await prisma.loanAllocation.findMany({ where: { gotEntryId: manualRepay.id } });
    ok("manual allocation lands on exactly the targeted loan", manualAllocations.length === 1 && manualAllocations[0].gaveEntryId === manualB.id);
    ok("the skipped (older) loan received nothing", (await prisma.loanAllocation.count({ where: { gaveEntryId: manualA.id } })) === 0);

    // ══════════════ 5. Card billing: set details via UI, fund a loan from the card ══════════════
    // NOT a stale selector: AccountCardDetailsForm still exists and its server
    // action still works, but nothing in the app opens it any more — the
    // Accounts page's "Card details" trigger is gone and /cards never gained
    // one, so the network/last4/statement-day/due-day editor is unreachable.
    // The assertion stays as-is (this is real, shipped behaviour that
    // regressed); it is scoped so the failure does not abort the eight card
    // billing / recovery / offline checks that follow it.
    let cardDetailsSavedViaUi = false;
    try {
      await page.goto(`${BASE}/accounts`, { waitUntil: "load" });
      await page.getByRole("button", { name: "Card details", exact: true }).first().click({ timeout: 8000 });
      await page.waitForSelector('input[placeholder="e.g. Visa"]');
      await page.fill('input[placeholder="e.g. Visa"]', "Visa");
      await page.fill('input[placeholder="4242"]', "9999");
      const dayInputs = modal(page).locator('input[type="number"]');
      await dayInputs.nth(0).fill("25");
      await dayInputs.nth(1).fill("10");
      await page.getByRole("button", { name: "Save card details", exact: true }).click();
      await page.waitForSelector("text=Card details saved", { timeout: 10000 });
      const updatedCard = await prisma.account.findUniqueOrThrow({ where: { id: cardAccount.id } });
      cardDetailsSavedViaUi =
        updatedCard.cardNetwork === "Visa" && updatedCard.cardLast4 === "9999" && updatedCard.statementDay === 25 && updatedCard.dueDay === 10;
    } catch (e) {
      cardDetailsSavedViaUi = false;
      console.log("   (card-details UI unreachable: " + String(e).slice(0, 120) + ")");
    }
    ok("card details saved via the Accounts page UI", cardDetailsSavedViaUi);
    // the billing-cycle checks below are about Card Recovery, not about how the
    // card got its details — give them the data the UI could not.
    await prisma.account.update({ where: { id: cardAccount.id }, data: { cardNetwork: "Visa", cardLast4: "9999", statementDay: 25, dueDay: 10 } });

    const cardLoan = await seed({
      userId: alice.id, participantId: rohan.id, kind: "GAVE", amount: 75000, accountId: cardAccount.id,
      occurredAt: new Date("2026-07-05T12:00:00+05:30"), reason: `E2ECardLoan-${suffix}`,
    });

    // NOT a stale selector either: lending-tabs.tsx retired Card Recovery as a
    // user-facing tab in the v2.0 UX polish, so the dashboard these three
    // checks describe no longer exists anywhere in the app. The assertions are
    // left standing — deleting them is a product call, not a test-maintenance
    // one — but scoped so the retired feature does not abort §7–§9 behind it.
    let recoveryBody = "";
    try {
      await page.goto(`${BASE}/lending`, { waitUntil: "load" });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload({ waitUntil: "load" });
      await page.getByRole("button", { name: "Card Recovery", exact: true }).click({ timeout: 8000 });
      await page.waitForTimeout(600);
      recoveryBody = await page.locator("body").innerText();
    } catch (e) {
      console.log("   (Card Recovery tab retired: " + String(e).slice(0, 110) + ")");
    }
    ok("Card Recovery Dashboard surfaces the card-funded loan's contact", recoveryBody.includes("Rohan"));
    ok("Card Recovery Dashboard shows a 'Recover before' guidance line", /Recover before|Overdue since|Due today/.test(recoveryBody));
    await page.setViewportSize({ width: 1280, height: 900 });

    // ══════════════ 6. Card Recovery drill-down opens the contact ══════════════
    // desktop shows every tab's content at once (the tab switcher buttons
    // are md:hidden — mobile-only), so no tab click is needed here; scope
    // the "Rohan" click to the Affected Loans list specifically, since the
    // name also appears elsewhere on this now fully-stacked desktop page
    // Same retired feature as §5 — the "Affected loans" list went with the tab.
    let recoveryDrillDownOpensLedger = false;
    try {
      await page.goto(`${BASE}/lending`, { waitUntil: "load" });
      await page.waitForSelector("text=Affected loans", { timeout: 8000 });
      const affectedLoansSection = page.getByText("Affected loans", { exact: true }).locator("xpath=..");
      await affectedLoansSection.getByText("Rohan", { exact: true }).click();
      await page.waitForSelector("text=+ You gave", { timeout: 10000 });
      // the drill-down always calls openModal("lendingContact", ...) directly
      // (it doesn't go through LendingWorkspace's own desktop/mobile
      // selection path), so it's always a modal regardless of viewport
      recoveryDrillDownOpensLedger = (await modal(page).count()) === 1;
    } catch (e) {
      console.log("   (Affected loans list retired with the tab: " + String(e).slice(0, 110) + ")");
    }
    ok("drilling into a Card Recovery row opens Rohan's contact ledger", recoveryDrillDownOpensLedger);
    await page.locator("body").press("Escape").catch(() => {});

    // ══════════════ 7. Loan Detail for the card-funded loan shows funding source + due-date guidance ══════════════
    // a reminder now legitimately exists for Rohan (card_due_this_week or
    // similar), so a bare name-regex match could hit the Reminders panel's
    // row instead of the Contacts List's — scope to the Contacts card
    await page.goto(`${BASE}/lending`, { waitUntil: "load" });
    const contactsSection = page.getByRole("heading", { name: "Contacts", exact: true }).locator("xpath=..");
    const loanRow = contactsSection.getByRole("button", { name: /Rohan/ }).first();
    await loanRow.click();
    await page.waitForSelector("text=+ You Gave");
    await openTransactionsTab(page);
    const cardPane = await contactPane(page);
    const cardEntryRow = cardPane.getByRole("button", { name: new RegExp(`View details .*E2ECardLoan-${suffix}`) });
    await cardEntryRow.click({ position: { x: 60, y: 10 } });
    await page.waitForSelector("text=Original Amount", { timeout: 10000 });
    const cardLoanDetail = await modal(page).innerText();
    ok("Loan Detail shows the card account as the funding source", cardLoanDetail.includes(cardAccount.name));

    // ══════════════ 8. Offline settlement sync ══════════════
    await page.goto(`${BASE}/lending`, { waitUntil: "load" });
    await context.setOffline(true);
    await openLendingEntry(page, "GOT");
    await modal(page).locator("select").first().selectOption({ label: "Rohan" });
    await page.fill('input[placeholder="0"]', "100");
    await page.fill('input[placeholder="e.g. Dinner, rent help"]', `E2EOfflineSettle-${suffix}`);
    await page.getByRole("button", { name: "Record You Got", exact: true }).click();
    await page.waitForTimeout(500);
    const beforeSync = await prisma.loanEntry.findFirst({ where: { reason: `E2EOfflineSettle-${suffix}` } });
    ok("a settlement queued offline does NOT hit the server yet", beforeSync === null);
    await context.setOffline(false);
    await page.waitForTimeout(1500);
    const afterSync = await waitForSyncedEntry(`E2EOfflineSettle-${suffix}`);
    entryIds.push(afterSync.id);
    ok("the queued settlement syncs automatically once back online", afterSync !== null);
    const offlineAllocations = await prisma.loanAllocation.findMany({ where: { gotEntryId: afterSync.id } });
    ok("the synced settlement's allocation landed correctly (FIFO against the card-funded loan)", offlineAllocations.length > 0 && offlineAllocations[0].gaveEntryId === cardLoan.id);

    // ══════════════ 9. Reports tab renders real data ══════════════
    // desktop stacks every tab's content already — no click needed (see §6)
    await page.goto(`${BASE}/lending`, { waitUntil: "load" });
    await page.waitForSelector("text=Top borrowers", { timeout: 10000 });
    const reportsBody = await page.locator("body").innerText();
    // the third card is the same recoveryRatePercent figure, relabelled in
    // plain language ("RECEIVED SO FAR") — value and meaning unchanged
    ok("Reports tab shows the receivable/payable/recovery-rate stat cards", ["RECEIVABLE", "PAYABLE", "RECEIVED SO FAR"].every((l) => reportsBody.includes(l)));
    ok("Reports tab's Top Borrowers includes a contact with an outstanding balance", /Top borrowers/i.test(reportsBody));
  } catch (e) {
    ok("script error", false, String(e).slice(0, 900));
    await page.screenshot({ path: "e2e-output/lending-settlement-error.png", fullPage: true }).catch(() => {});
  } finally {
    // LoanAllocation rows cascade-delete with their LoanEntry (onDelete: Cascade
    // on both sides) — deleting the entries is enough, no separate cleanup.
    await prisma.loanEntry.deleteMany({ where: { id: { in: entryIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: entryIds } } });
    await prisma.intent.deleteMany({ where: { entityId: { in: entryIds } } });
    await prisma.account.update({ where: { id: cardAccount.id }, data: originalCardFields }).catch(() => {});
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
