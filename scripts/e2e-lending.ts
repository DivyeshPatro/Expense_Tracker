// Lending module (Phase 1) — Prisma-direct assertions (running balance math,
// contact reuse, funding-source linkage, offline outbox integration) plus
// real-browser UI flows (dashboard, entry form, contact sheet, edit/delete),
// following the hybrid pattern established in e2e-group-expenses.ts.
// Run: npx tsx scripts/e2e-lending.ts
import { randomUUID } from "node:crypto";
import { chromium, type Page } from "playwright";
import { prisma } from "../src/server/db";
import { lendingBalances, lendingDashboardSummary } from "../src/server/services/lending";

const BASE = "http://localhost:3000";
const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

function modal(page: Page) {
  return page.locator(".fixed.inset-0.z-\\[60\\]").first();
}

/** ContactLedgerView renders identically in two hosts: a mobile modal sheet
 * or (Phase 1.5, desktop two-pane) an inline `section.card` — this script
 * runs at desktop viewport for most of its flow, so a contact-row click
 * opens the inline pane, not a modal. Resolve to whichever is actually
 * present rather than assuming a modal every time. */
async function contactPane(page: Page) {
  const overlay = modal(page);
  if ((await overlay.count()) > 0) return overlay;
  // Anchor on the ledger's own tablist, not on a control that only exists on
  // one tab — "+ You gave" lives on Overview, so anchoring there made the pane
  // unresolvable the moment the script switched to Transactions.
  return page.locator("section.card").filter({ has: page.getByRole("tablist", { name: "Contact sections" }) });
}

/** #187 removed the two "＋ You Gave / ＋ You Got" buttons from the Lending
 * page header — they are the context-aware quick-add FAB's job now. Same
 * modal, same fields, same intent; only the entry point moved. Both FABs
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

/** A contact's ledger is tabbed (Overview / Transactions / Reports / Activity).
 * Overview carries the summary card and the quick actions; the entry rows —
 * with their Edit and Delete controls — live under Transactions. */
async function openTransactionsTab(page: Page) {
  await (await contactPane(page)).getByRole("tab", { name: "transactions" }).click();
  await page.waitForTimeout(400);
}

/** Server creates go through the offline outbox before landing in Postgres —
 * the UI's success toast only confirms the intent was queued, not synced.
 * Poll instead of guessing a fixed delay (established pattern, see
 * e2e-group-expenses.ts's waitForSyncedTx). */
async function waitForSyncedEntry(reason: string) {
  for (let i = 0; i < 30; i++) {
    const e = await prisma.loanEntry.findFirst({ where: { reason } });
    if (e) return e;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`loan entry with reason "${reason}" never synced to the server within 9s`);
}

/** Contact-details saves go through a direct server action (no offline
 * outbox), but the dev server has known latency under sustained load — poll
 * instead of a fixed sleep so a slow response doesn't read stale data. */
async function waitForParticipantPhone(participantId: string, phone: string) {
  for (let i = 0; i < 20; i++) {
    const p = await prisma.participant.findUniqueOrThrow({ where: { id: participantId } });
    if (p.phone === phone) return p;
    await new Promise((r) => setTimeout(r, 300));
  }
  return prisma.participant.findUniqueOrThrow({ where: { id: participantId } });
}

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

  try {
    await page.goto(`${BASE}/sign-in`, { waitUntil: "load" });
    await page.fill('input[type="email"]', "arjun@ledgerly.app");
    await page.fill('input[type="password"]', "ledgerly-demo");
    await page.click('button[type="submit"]');
    await page.waitForURL("**/dashboard", { timeout: 20000 });

    // ══════════════ 1. Contact reuse: Rohan is a Shared-Expenses participant — no duplication ══════════════
    const rohanParticipantCount = await prisma.participant.count({ where: { ownerId: alice.id, displayName: "Rohan" } });
    ok("the same Participant row is the one Lending will use — no second person model", rohanParticipantCount === 1, `${rohanParticipantCount} rows named Rohan`);

    // ══════════════ 2. Nav reachability ══════════════
    await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    ok("desktop sidebar has a Lending link", await page.getByRole("link", { name: /Lending/ }).isVisible());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "load" });
    // What matters is that Lending is REACHABLE on a phone, not which slot
    // holds it. #202 tiers Lending "weekly" and #207 made People the daily
    // answer to "what does this person owe me", so with the default six tabs
    // (five plus More) Lending sits in the More sheet by design — and a user
    // can pin it into the bar from Settings → Navigation. Asserting a fixed
    // slot tested a layout decision the product had already moved past.
    const mobileNav = page.locator("nav").filter({ has: page.getByRole("button", { name: "More sections" }) });
    const inBar = await mobileNav.getByText("Lending", { exact: true }).isVisible().catch(() => false);
    if (!inBar) await mobileNav.getByRole("button", { name: "More sections" }).click();
    const lendingLink = inBar ? mobileNav.getByText("Lending", { exact: true }) : page.getByRole("link", { name: "Lending", exact: true });
    await lendingLink.waitFor({ state: "visible", timeout: 10000 });
    ok(`mobile navigation reaches Lending (${inBar ? "bottom-bar slot" : "More sheet"})`, await lendingLink.isVisible());
    // and it actually goes there, rather than merely being listed
    await lendingLink.click();
    await page.waitForURL("**/lending**", { timeout: 15000 });
    ok("tapping it opens Lending", page.url().includes("/lending"), page.url());
    await page.setViewportSize({ width: 1280, height: 900 });

    // ══════════════ 3. Add "You Gave" via the UI, offline-outbox create ══════════════
    await page.goto(`${BASE}/lending`, { waitUntil: "load" });
    // #187 rebuilt the three figures as a ModuleHero: the same three numbers in
    // plain language ("You'll get" / "You'll pay" / "Net") instead of the old
    // YOU ARE OWED / YOU OWE / NET LENDING caps. The two secondary labels
    // render with CSS text-transform: uppercase, so they are compared
    // case-insensitively (the pattern this script already uses below). The hero
    // is server-rendered, so anchor on it first — a fast `load` event can be
    // observed before the RSC payload has painted.
    await page.getByText(/you'll get/i).first().waitFor({ timeout: 20000 });
    const heroBody = (await page.locator("main, body").first().innerText()).toUpperCase();
    const heroLabels = ["You'll get", "You'll pay", "Net"];
    ok("Lending dashboard shows the three summary cards", heroLabels.every((l) => heroBody.includes(l.toUpperCase())), heroLabels.join(" / "));
    await openLendingEntry(page, "GAVE");
    ok("Lending entry form has no native date input", (await modal(page).locator('input[type="date"]').count()) === 0);
    await page.fill('input[placeholder="0"]', "2000");
    await modal(page).locator("select").first().selectOption({ label: "Rohan" });
    const fundingSelect = modal(page).locator("select").nth(1);
    await fundingSelect.selectOption({ label: "🏦 HDFC Savings" });
    await page.fill('input[placeholder="e.g. Dinner, rent help"]', `E2ELent-${suffix}`);
    await page.getByRole("button", { name: "Record You Gave", exact: true }).click();
    await page.waitForSelector("text=Loan recorded");

    const gaveEntry = await waitForSyncedEntry(`E2ELent-${suffix}`);
    entryIds.push(gaveEntry.id);
    ok("the entry is kind=GAVE with the entered amount", gaveEntry.kind === "GAVE" && Number(gaveEntry.amount) === 200000);
    ok("the funding source (Account) linkage is stored — reused, not duplicated", gaveEntry.accountId === hdfc.id);
    ok("the entry is scoped to the correct contact (Rohan)", gaveEntry.participantId === rohan.id);

    // ══════════════ 4. Running balance: sign convention Σ GAVE − Σ GOT, positive ⇒ they owe you ══════════════
    const balancesAfterGave = await lendingBalances(alice.id);
    const rohanBalAfterGave = balancesAfterGave.find((c) => c.id === rohan.id)?.net ?? 0;
    ok("Rohan's lending balance reflects the ₹2,000 GAVE entry (positive ⇒ he owes you)", rohanBalAfterGave === 200000, `net=${rohanBalAfterGave}`);

    await page.goto(`${BASE}/lending`, { waitUntil: "load" });
    const rohanRow = page.getByRole("button", { name: /Rohan/ }).first();
    ok("the dashboard's Contacts list shows Rohan's updated balance", (await rohanRow.innerText()).includes("₹2,000"));

    // ══════════════ 5. Add "You Got" (repayment), balance decreases correctly ══════════════
    // the "+ You Got" quick action also exists on the /lending page header
    // behind the modal — scope to the contact sheet to avoid the ambiguity
    await rohanRow.click();
    await page.waitForSelector("text=+ You Gave");
    await (await contactPane(page)).getByRole("button", { name: "+ You got", exact: true }).click();
    await page.waitForSelector('input[placeholder="0"]');
    await page.fill('input[placeholder="0"]', "500");
    await page.fill('input[placeholder="e.g. Dinner, rent help"]', `E2ERepay-${suffix}`);
    await page.getByRole("button", { name: "Record You Got", exact: true }).click();
    await page.waitForSelector("text=Repayment recorded");

    const gotEntry = await waitForSyncedEntry(`E2ERepay-${suffix}`);
    entryIds.push(gotEntry.id);
    ok("the repayment is kind=GOT", gotEntry.kind === "GOT");

    const balancesAfterRepay = await lendingBalances(alice.id);
    const rohanBalAfterRepay = balancesAfterRepay.find((c) => c.id === rohan.id)?.net ?? 0;
    ok(
      "running balance updates immediately: ₹2,000 GAVE − ₹500 GOT = ₹1,500 still owed",
      rohanBalAfterRepay === 150000,
      `net=${rohanBalAfterRepay}`
    );

    // ══════════════ 6. Dashboard totals aggregate correctly ══════════════
    const summary = await lendingDashboardSummary(alice.id);
    ok("dashboard's youAreOwed includes Rohan's outstanding ₹1,500", summary.youAreOwed >= 150000);
    ok("contacts are sorted by |balance| descending (largest outstanding first)", summary.contacts[0].id === rohan.id || Math.abs(summary.contacts[0].net) >= Math.abs(rohanBalAfterRepay));

    // ══════════════ 7. Edit an entry, offline-outbox update ══════════════
    await page.goto(`${BASE}/lending`, { waitUntil: "load" });
    await page.getByRole("button", { name: /Rohan/ }).first().click();
    await page.waitForSelector("text=+ You Gave");
    // The row's pencil and cross are gone: opening a transaction already
    // offers Edit, Duplicate and Delete, and two more targets per row cost the
    // Notes column the width it needed on a phone. Editing now goes through
    // the transaction itself, which is the path a person actually takes.
    await openTransactionsTab(page);
    await (await contactPane(page)).getByRole("button", { name: new RegExp(`View details .*E2ELent-${suffix}`) }).click({ position: { x: 60, y: 10 } });
    await page.waitForSelector("text=Funding Source", { timeout: 10000 });
    await modal(page).getByRole("button", { name: "Edit", exact: true }).click();
    await page.waitForSelector('input[placeholder="0"]');
    await page.fill('input[placeholder="0"]', "2200");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.waitForTimeout(700);

    const editedEntry = await prisma.loanEntry.findFirstOrThrow({ where: { id: gaveEntry.id } });
    ok("editing an entry updates its amount", Number(editedEntry.amount) === 220000);
    ok("editing an entry bumps its version (offline-sync conflict check)", editedEntry.version === 2);
    const balancesAfterEdit = await lendingBalances(alice.id);
    const rohanBalAfterEdit = balancesAfterEdit.find((c) => c.id === rohan.id)?.net ?? 0;
    ok("running balance reflects the edited amount: ₹2,200 − ₹500 = ₹1,700", rohanBalAfterEdit === 170000, `net=${rohanBalAfterEdit}`);

    // ══════════════ 7b. The row is one target ══════════════
    // The ledger row used to carry a second destination — the funding account
    // — on a line of its own, and before that nested inside the row's own
    // button, where a tap dead-centre navigated to /accounts instead of
    // opening the transaction. The list is a scanning surface now: one target
    // per row, and the account is named in the sheet it opens.
    await page.goto(`${BASE}/lending`, { waitUntil: "load" });
    await page.getByRole("button", { name: /Rohan/ }).first().click();
    await page.waitForSelector("text=+ You gave");
    await openTransactionsTab(page);
    const hitPane = await contactPane(page);
    const rowGroup = hitPane
      .locator("div")
      .filter({ has: page.getByRole("button", { name: new RegExp(`View details .*E2ELent-${suffix}`) }) })
      .last();
    ok("a transaction row exposes exactly one click target", (await rowGroup.getByRole("button").count()) === 1 && (await rowGroup.getByRole("link").count()) === 0);
    ok("the row does not name the funding account", !/via HDFC Savings|Untracked/.test(await rowGroup.innerText()));

    await rowGroup.getByRole("button", { name: new RegExp(`View details .*E2ELent-${suffix}`) }).click();
    await page.waitForSelector("text=Funding Source", { timeout: 10000 });
    const sheet = await modal(page).innerText();
    ok("clicking the row opens that transaction", sheet.includes(`E2ELent-${suffix}`));
    ok("the sheet carries the funding account the list omits", sheet.includes("HDFC Savings"));
    ok("opening the transaction did not navigate away from Lending", page.url().includes("/lending"), page.url());
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(400);

    // ══════════════ 8. Delete + undo ══════════════
    await page.goto(`${BASE}/lending`, { waitUntil: "load" });
    await page.getByRole("button", { name: /Rohan/ }).first().click();
    await page.waitForSelector("text=+ You Gave");
    await openTransactionsTab(page);
    await (await contactPane(page)).getByRole("button", { name: new RegExp(`View details .*E2ERepay-${suffix}`) }).click({ position: { x: 60, y: 10 } });
    await page.waitForSelector("text=Funding Source", { timeout: 10000 });
    // The sheet asks before deleting — a step the row's cross never had.
    await modal(page).getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForSelector("text=Delete this entry?", { timeout: 5000 });
    await modal(page).getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForTimeout(800);
    const afterDelete = await prisma.loanEntry.findFirst({ where: { id: gotEntry.id } });
    ok("deleting an entry soft-deletes it", afterDelete?.deletedAt != null);
    const balancesAfterDelete = await lendingBalances(alice.id);
    const rohanBalAfterDelete = balancesAfterDelete.find((c) => c.id === rohan.id)?.net ?? 0;
    ok("balance updates immediately after delete: back to ₹2,200", rohanBalAfterDelete === 220000, `net=${rohanBalAfterDelete}`);

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.waitForTimeout(500);
    const afterUndo = await prisma.loanEntry.findFirst({ where: { id: gotEntry.id } });
    ok("undo restores the deleted entry", afterUndo?.deletedAt == null);

    // ══════════════ 9. Offline: queue a create while offline, confirm it syncs ══════════════
    await page.goto(`${BASE}/lending`, { waitUntil: "load" });
    await context.setOffline(true);
    await openLendingEntry(page, "GAVE");
    await page.fill('input[placeholder="0"]', "300");
    await modal(page).locator("select").first().selectOption({ label: "Rohan" });
    await page.fill('input[placeholder="e.g. Dinner, rent help"]', `E2EOffline-${suffix}`);
    await page.getByRole("button", { name: "Record You Gave", exact: true }).click();
    await page.waitForSelector("text=Loan recorded");
    const offlineEntryBefore = await prisma.loanEntry.findFirst({ where: { userId: alice.id, reason: `E2EOffline-${suffix}` } });
    ok("a loan entry queued offline does NOT hit the server yet", offlineEntryBefore === null);
    await context.setOffline(false);
    await page.waitForSelector("text=Waiting to sync", { state: "detached", timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const offlineEntryAfter = await prisma.loanEntry.findFirst({ where: { userId: alice.id, reason: `E2EOffline-${suffix}` } });
    ok("the queued entry syncs automatically once back online", offlineEntryAfter !== null);
    if (offlineEntryAfter) entryIds.push(offlineEntryAfter.id);

    // ══════════════ 10. Activity Timeline registration ══════════════
    const loanAuditRows = await prisma.auditLog.findMany({ where: { userId: alice.id, entity: "LoanEntry" }, orderBy: { at: "desc" }, take: 5 });
    ok("LoanEntry mutations write audit rows (Activity Timeline registry)", loanAuditRows.length > 0, `${loanAuditRows.length} rows`);
    await page.goto(`${BASE}/activity`, { waitUntil: "load" });
    await page.getByRole("button", { name: "Lending", exact: true }).click();
    await page.waitForTimeout(500);
    const activityBody = await page.locator("main, body").first().innerText();
    ok('Activity Timeline\'s "Lending" chip shows a lent/repaid event', /lent|repaid/i.test(activityBody));

    // ══════════════ 11. Contact details: name/photo/phone/notes, no duplicate contact system ══════════════
    await page.goto(`${BASE}/lending`, { waitUntil: "load" });
    await page.getByRole("button", { name: /Rohan/ }).first().click();
    await page.waitForSelector("text=+ You Gave");
    await page.getByRole("button", { name: "Edit contact details", exact: true }).click();
    await page.waitForSelector('input[placeholder="Optional"]');
    const pane = await contactPane(page);
    const nameInput = pane.locator('input[value="Rohan"]');
    await nameInput.fill(`Rohan-${suffix}`);
    const phoneInput = pane.locator('input[placeholder="Optional"]').first();
    await phoneInput.fill("+91 98765 43210");
    const notesInput = pane.locator('input[placeholder="Optional"]').nth(1);
    await notesInput.fill("Met at college reunion");
    await page.getByRole("button", { name: "Save contact details", exact: true }).click();
    const updatedRohan = await waitForParticipantPhone(rohan.id, "+91 98765 43210");
    ok("contact name/phone/notes saved onto the SAME Participant row Shared Expenses uses", updatedRohan.phone === "+91 98765 43210" && updatedRohan.notes === "Met at college reunion" && updatedRohan.displayName === `Rohan-${suffix}`);

    // revert the name immediately — other e2e scripts (and the rest of THIS
    // one) look up this participant by the literal seeded name "Rohan"
    await prisma.participant.update({ where: { id: rohan.id }, data: { displayName: "Rohan" } });

    // ══════════════ 12. Search — name, phone, notes, highlighting, empty states ══════════════
    await page.goto(`${BASE}/lending`, { waitUntil: "load" });
    await page.fill('input[aria-label="Search contacts"]', "Rohan");
    await page.waitForTimeout(200);
    ok("contact search filters by name", await page.getByRole("button", { name: /Rohan/ }).first().isVisible());
    const highlightVisible = await page.locator("mark", { hasText: "Rohan" }).first().isVisible().catch(() => false);
    ok("matched text is visually highlighted", highlightVisible);

    await page.fill('input[aria-label="Search contacts"]', "98765 43210");
    await page.waitForTimeout(200);
    ok("contact search also matches phone number", await page.getByRole("button", { name: /Rohan/ }).first().isVisible());

    await page.fill('input[aria-label="Search contacts"]', "college reunion");
    await page.waitForTimeout(200);
    ok("contact search also matches notes content", await page.getByRole("button", { name: /Rohan/ }).first().isVisible());

    await page.fill('input[aria-label="Search contacts"]', "Nonexistent Name Zz");
    await page.waitForTimeout(200);
    ok('contact search shows a no-match state for an unmatched query', await page.getByText(/No contacts match/).isVisible());
    await page.fill('input[aria-label="Search contacts"]', "");

    // clean up phone/notes now that search checks are done
    await prisma.participant.update({ where: { id: rohan.id }, data: { phone: null, notes: null } });

    // ══════════════ 13. Contact Summary Card + timeline grouping ══════════════
    await page.goto(`${BASE}/lending`, { waitUntil: "load" });
    await page.getByRole("button", { name: /Rohan/ }).first().click();
    // The summary card uses plain-language labels for a non-technical audience
    // ("Total Given", not "Total Lent"); this asserts the shipped wording.
    await page.waitForSelector("text=Pending Entries", { timeout: 10000 });
    // labels render with CSS text-transform: uppercase — innerText() reflects
    // the rendered text, not the literal DOM string, so compare case-insensitively
    const summaryBody = (await (await contactPane(page)).innerText()).toUpperCase();
    ok(
      "Contact Summary Card shows Pending Entries / Total Given / Total Received / Largest Given / Received So Far / Last+First Transaction",
      [
        "Pending Entries",
        "Total Given",
        "Average Given",
        "Largest Given",
        "Total Received",
        "Received So Far",
        "Last Transaction",
        "First Transaction",
      ].every((label) => summaryBody.includes(label.toUpperCase()))
    );
    // The timeline moved off Overview and into the Transactions tab, where it
    // groups by month rather than by day. Grouping is what this check is about,
    // so it follows the list; matching "TODAY" in the Overview body was in fact
    // matching the summary card's "Last Transaction · Today", not a header.
    await openTransactionsTab(page);
    const monthHeadings = await (await contactPane(page)).getByText(/^[a-z]{3} \d{4}$/i).count();
    ok("entries are grouped under a date header (month)", monthHeadings > 0, `${monthHeadings} headings`);

    // ══════════════ 14. Desktop two-pane: selecting a contact does NOT open a modal ══════════════
    ok(
      "desktop: viewing a contact's ledger happens inline — no modal overlay opens",
      (await page.locator(".fixed.inset-0.z-\\[60\\]").count()) === 0
    );
    ok("desktop: an inline '← Back to Lending' control is present in the pane", await page.getByRole("button", { name: "Back to Lending" }).isVisible());
    await page.getByRole("button", { name: "Back to Lending" }).click();
    await page.waitForTimeout(300);
    ok("closing the inline pane returns to the Recent entries view", await page.getByText("Recent entries").isVisible());

    // ══════════════ 15. Mobile: selecting a contact opens the modal sheet instead ══════════════
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/lending`, { waitUntil: "load" });
    await page.getByRole("button", { name: /Rohan/ }).first().click();
    await page.waitForSelector("text=Pending Entries", { timeout: 10000 });
    ok("mobile: viewing a contact's ledger opens the modal sheet", (await page.locator(".fixed.inset-0.z-\\[60\\]").count()) === 1);
    await page.setViewportSize({ width: 1280, height: 900 });

    // ══════════════ 13. Card Vault fields exist on Account (Phase 1 schema scope) ══════════════
    const cardAccount = await prisma.account.findFirstOrThrow({ where: { userId: alice.id, type: "CREDIT_CARD" } });
    await prisma.account.update({ where: { id: cardAccount.id }, data: { cardNetwork: "Visa", cardLast4: "4242", statementDay: 3, dueDay: 18 } });
    const cardAccountAfter = await prisma.account.findUniqueOrThrow({ where: { id: cardAccount.id } });
    ok(
      "Account stores Card Vault fields (network/last4/statementDay/dueDay) for Phase 2 billing intelligence to read",
      cardAccountAfter.cardNetwork === "Visa" && cardAccountAfter.cardLast4 === "4242" && cardAccountAfter.statementDay === 3 && cardAccountAfter.dueDay === 18
    );
    await prisma.account.update({ where: { id: cardAccount.id }, data: { cardNetwork: null, cardLast4: null, statementDay: null, dueDay: null } });
  } catch (e) {
    ok("script error", false, String(e).slice(0, 800));
    await page.screenshot({ path: "e2e-output/lending-error.png", fullPage: true }).catch(() => {});
  } finally {
    await prisma.loanEntry.deleteMany({ where: { id: { in: entryIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: entryIds } } });
    await prisma.intent.deleteMany({ where: { entityId: { in: entryIds } } });
    // defensive: reverts every field this script may have touched on the
    // shared demo participant, even if an earlier assertion threw mid-way
    // before its own inline revert ran — other e2e scripts depend on the
    // literal seeded name "Rohan" existing.
    await prisma.participant.update({ where: { id: rohan.id }, data: { displayName: "Rohan", phone: null, notes: null } }).catch(() => {});
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
