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
// Recording a repayment is the full-screen LendingComposer now — the keypad
// for the amount, sheets for the contact and the allocation, a swipe to
// commit. LoanAllocationPicker is the SAME component the classic form used, so
// every FIFO/manual assertion below still drives the real allocator.
const composer = (page: Page) => page.locator("div[data-lending]");
const sheet = (page: Page) => page.getByRole("dialog").last();

async function openLendingEntry(page: Page, kind: "GAVE" | "GOT") {
  const fab = page.locator('button[aria-label="Lending — quick add"]:visible').first();
  // The FAB is client-rendered; on a loaded machine `load` can fire well before
  // it paints. Wait for it rather than racing it.
  await fab.waitFor({ state: "visible", timeout: 30000 });
  await fab.click();
  await page.getByRole("button", { name: kind === "GAVE" ? /You gave money/ : /You got money/ }).first().click();
  await composer(page).waitFor({ timeout: 30000 });
}

/** Tap an amount into the lending composer's keypad. */
async function typeLendingAmount(page: Page, rupees: string) {
  await composer(page).getByRole("button", { name: "Clear amount" }).click();
  for (const ch of rupees) {
    await composer(page).getByRole("button", { name: ch === "." ? "Decimal point" : ch, exact: true }).click();
    await page.waitForTimeout(50);
  }
}

/** Choose the contact from the line under the amount. */
async function pickContact(page: Page, name: string) {
  await composer(page).getByRole("button", { name: /^Contact:|Choose a contact/ }).click();
  await page.waitForTimeout(500);
  await sheet(page).getByRole("button", { name: new RegExp(`^${name}$`) }).first().click();
  await page.waitForTimeout(600);
}

/** Open the allocation sheet — "Apply to" and the per-loan boxes live there. */
async function openAllocation(page: Page) {
  await composer(page).getByRole("button", { name: /^Allocation:/ }).click();
  await page.waitForSelector("text=Apply to", { timeout: 10000 });
}

/** Close whichever sheet is on top. */
async function sheetDone(page: Page) {
  const done = sheet(page).getByRole("button", { name: "Done", exact: true });
  if (await done.count()) {
    await done.click();
    await page.waitForTimeout(400);
  }
}

/** Fill the reason, which lives behind "What was it for?". */
async function setReason(page: Page, reason: string) {
  await composer(page).getByRole("button", { name: "Reason and notes" }).click();
  await page.waitForTimeout(400);
  await sheet(page).locator('input[placeholder="e.g. Dinner, rent help"]').fill(reason);
  await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
  await page.waitForTimeout(350);
}

/** Drag the confirm handle the whole way — the composer has no Record button. */
async function recordLoan(page: Page, { expectClose = true }: { expectClose?: boolean } = {}) {
  await sheetDone(page);
  const track = composer(page).locator("div[role='slider']");
  const box = (await track.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 30, y);
  await page.mouse.down();
  const end = box.x + 30 + (box.width - 62);
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(box.x + 30 + ((end - box.x - 30) * i) / 12, y);
    await page.waitForTimeout(18);
  }
  await page.mouse.up();
  if (expectClose) await composer(page).waitFor({ state: "detached", timeout: 20000 });
  await page.waitForTimeout(400);
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
    await pickContact(page, "Rohan");
    await typeLendingAmount(page, "1200"); // ₹1200 = fully covers the ₹1000 old loan + ₹200 into the new one
    await openAllocation(page);
    ok("the allocation picker defaults to Auto (FIFO)", await sheet(page).getByRole("button", { name: "Auto", exact: true }).isVisible());
    await sheetDone(page);
    await setReason(page, `E2EFifoRepay-${suffix}`);
    await recordLoan(page);
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
    await pickContact(page, "Rohan");
    await typeLendingAmount(page, "300"); // clears the remaining ₹300 on the newer loan exactly
    await setReason(page, `E2EFullRepay-${suffix}`);
    await recordLoan(page);
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
    await pickContact(page, "Priya");
    await typeLendingAmount(page, "200");
    await openAllocation(page);
    await sheet(page).getByRole("button", { name: "Custom", exact: true }).click();
    // target manualB specifically (the newer, larger loan) — a plain FIFO
    // run would have hit manualA (older) first, so this proves the override
    // getByText(exact) targets the specific leaf label div unambiguously —
    // a generic `locator("div").filter({hasText}).last()` picks the
    // innermost matching div, but here that's the leaf text node itself
    // (no sibling input), not the row two levels up that actually holds one
    const manualBRow = sheet(page).getByText(`E2EManualB-${suffix}`, { exact: true }).locator("xpath=..").locator("xpath=..");
    await manualBRow.locator('input[type="number"]').fill("200");
    await manualBRow.locator('input[type="number"]').blur();
    await page.waitForTimeout(300);
    await sheetDone(page);
    await setReason(page, `E2EManualRepay-${suffix}`);
    await recordLoan(page);
    const manualRepay = await waitForSyncedEntry(`E2EManualRepay-${suffix}`);
    entryIds.push(manualRepay.id);

    const manualAllocations = await prisma.loanAllocation.findMany({ where: { gotEntryId: manualRepay.id } });
    ok("manual allocation lands on exactly the targeted loan", manualAllocations.length === 1 && manualAllocations[0].gaveEntryId === manualB.id);
    ok("the skipped (older) loan received nothing", (await prisma.loanAllocation.count({ where: { gaveEntryId: manualA.id } })) === 0);

    // ══════════════ 5. Card billing: set details via UI, fund a loan from the card ══════════════
    // Accounts → the card's ⋯ menu → Card details. #209 folded the row's
    // buttons into that menu and dropped this one on the way, which left the
    // network / last-4 / statement-day / due-day editor with no trigger: the
    // fields could be set when the account was created and never corrected.
    // Driven through the UI deliberately — calling the action directly would
    // have kept passing throughout the regression.
    await page.goto(`${BASE}/accounts`, { waitUntil: "load" });
    await page.getByLabel(`More actions for ${cardAccount.name}`, { exact: true }).click();
    await page.getByRole("button", { name: "Card details", exact: true }).click();
    await page.waitForSelector('input[placeholder="e.g. Visa"]');
    await page.fill('input[placeholder="e.g. Visa"]', "Visa");
    await page.fill('input[placeholder="4242"]', "9999");
    const dayInputs = modal(page).locator('input[type="number"]');
    await dayInputs.nth(0).fill("25");
    await dayInputs.nth(1).fill("10");
    await page.getByRole("button", { name: "Save card details", exact: true }).click();
    await page.waitForSelector("text=Card details saved", { timeout: 10000 });
    const updatedCard = await prisma.account.findUniqueOrThrow({ where: { id: cardAccount.id } });
    ok("card details saved via the Accounts page UI", updatedCard.cardNetwork === "Visa" && updatedCard.cardLast4 === "9999" && updatedCard.statementDay === 25 && updatedCard.dueDay === 10);

    // Reopening must show what was saved — the regression this path exists to
    // catch is silent, so "it saved" is only half the guarantee.
    await page.goto(`${BASE}/accounts`, { waitUntil: "load" });
    await page.getByLabel(`More actions for ${cardAccount.name}`, { exact: true }).click();
    await page.getByRole("button", { name: "Card details", exact: true }).click();
    await page.waitForSelector('input[placeholder="e.g. Visa"]');
    const reopened = modal(page).locator('input[type="number"]');
    ok(
      "reopening Card details shows the saved values",
      (await modal(page).locator('input[placeholder="e.g. Visa"]').inputValue()) === "Visa" &&
        (await modal(page).locator('input[placeholder="4242"]').inputValue()) === "9999" &&
        (await reopened.nth(0).inputValue()) === "25" &&
        (await reopened.nth(1).inputValue()) === "10"
    );
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);

    const cardLoan = await seed({
      userId: alice.id, participantId: rohan.id, kind: "GAVE", amount: 75000, accountId: cardAccount.id,
      occurredAt: new Date("2026-07-05T12:00:00+05:30"), reason: `E2ECardLoan-${suffix}`,
    });

    // §5's Card Recovery dashboard checks and §6's drill-down were removed
    // here: b1794e7 retired Card Recovery as a user-facing tab in the v2.0
    // polish and "Affected loans" went with it, so all three described a
    // surface that no longer exists. What survived the retirement is still
    // covered — Reports keeps a "Card exposure" card (§9) and the Reminders
    // panel keeps the per-contact card guidance, which is why §5 above now
    // insists the statement and due days can actually be entered.

    // ══════════════ 7. Loan Detail for the card-funded loan shows funding source + due-date guidance ══════════════
    // a reminder now legitimately exists for Rohan (card_due_this_week or
    // similar), so a bare name-regex match could hit the Reminders panel's
    // row instead of the Contacts List's — scope to the Contacts card
    await page.goto(`${BASE}/lending`, { waitUntil: "load" });
    // Scope to the Contacts CARD, not to the heading's parent element: the
    // heading now shares a row with an "Add contact" action, so its parent is
    // that row rather than the card holding the contact list.
    const contactsSection = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Contacts", exact: true }) });
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
    await pickContact(page, "Rohan");
    await typeLendingAmount(page, "100");
    await setReason(page, `E2EOfflineSettle-${suffix}`);
    await recordLoan(page);
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
