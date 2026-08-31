// Calendar & Date Picker Polish sprint: proves the single themed DateField
// component (src/components/shell/date-field.tsx) is used everywhere the
// app asks for a date or a month, that its popover portals to document.body
// (never clipped by, or adding scroll to, a parent dialog), and that it
// applies flip/shift collision handling near viewport edges. Covers every
// consumer named in the sprint brief: Add/Edit Expense, Add/Edit Income,
// Add/Edit Transfer, Pending Intent Edit, the Dashboard/header period
// picker (month field + custom range), and Bills' due-date field.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(SCRIPT_DIR, "..", "e2e-output");
fs.mkdirSync(SHOT, { recursive: true });
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(20000);

const modal = () => page.locator(".fixed.inset-0.z-\\[60\\]").first();
const dateTriggerIn = (scope) => scope.locator('button[aria-haspopup="dialog"]').first();

// Adding or editing a Debit/Credit is the full-screen composer, whose date
// chip opens a sheet holding the SAME DateField. The popover's obligation is
// unchanged and is what this suite measures either way: it must portal out to
// <body> rather than live inside the scrolling container that opened it.
const composer = () => page.locator("div[data-composer]");
const sheet = () => page.getByRole("dialog").last();

/** Open the composer from Spending and tap an amount into its keypad. */
async function openComposer(rupees) {
  await page.click('button:has-text("＋ Add expense")');
  await composer().waitFor({ timeout: 20000 });
  await composer().getByRole("button", { name: "Clear amount" }).click();
  for (const ch of String(rupees)) {
    await composer().getByRole("button", { name: ch, exact: true }).click();
    await page.waitForTimeout(50);
  }
}

/** The merchant lives behind the composer's "Who's it for?" line. */
async function setComposerMerchant(merchant) {
  await composer().getByRole("button", { name: "Merchant and notes" }).click();
  await page.waitForTimeout(400);
  await sheet().locator("input").first().fill(merchant);
  await sheet().getByRole("button", { name: "Done", exact: true }).click();
  await page.waitForTimeout(350);
}

/** Drag the confirm handle the whole way — the composer has no Save button. */
async function saveComposer() {
  const done = sheet().getByRole("button", { name: "Done", exact: true });
  if (await done.count()) {
    await done.click();
    await page.waitForTimeout(350);
  }
  const track = composer().locator("div[role='slider']");
  const box = await track.boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 30, y);
  await page.mouse.down();
  const end = box.x + 30 + (box.width - 62);
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(box.x + 30 + ((end - box.x - 30) * i) / 12, y);
    await page.waitForTimeout(18);
  }
  await page.mouse.up();
  await composer().waitFor({ state: "detached", timeout: 20000 });
  await page.waitForTimeout(400);
}

/** Open the composer's date sheet, where the DateField lives. */
async function openComposerDateSheet() {
  await composer().getByRole("button", { name: /^Date:/ }).click();
  await page.waitForTimeout(500);
}

async function openDateDialog(triggerLocator) {
  await triggerLocator.click();
  await page.waitForSelector('[role="dialog"][aria-label="Choose date"]');
}

async function portalCheck(dialogSelector, label) {
  const parentTag = await page.locator(dialogSelector).evaluate((el) => el.parentElement?.tagName);
  ok(`${label}: popover is portaled directly under <body>`, parentTag === "BODY", `parent=${parentTag}`);
}

try {
  await page.goto("http://localhost:3000/sign-in", { waitUntil: "load" });
  await page.fill('input[type="email"]', "arjun@ledgerly.app");
  await page.fill('input[type="password"]', "ledgerly-demo");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 20000 });

  // ══════════════ 1. Portal + no-scrollbar, from the Add Expense modal ══════════════
  await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
  await openComposer("100");
  await openComposerDateSheet();
  await openDateDialog(dateTriggerIn(sheet()));
  await portalCheck('[role="dialog"][aria-label="Choose date"]', "Add Expense");
  // The container that must not swallow it is the date SHEET now — that is
  // the scrolling panel the trigger sits inside. Same bug, same shape: a
  // calendar rendered as a child of a scroll container either clips or
  // inflates it.
  const isInsideSheet = await page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')];
    const cal = document.querySelector('[role="dialog"][aria-label="Choose date"]');
    const host = dialogs.find((d) => d !== cal && d.getAttribute("aria-label") === "Date");
    return host ? host.contains(cal) : null;
  });
  ok("Add Expense: popover is NOT a DOM descendant of the sheet that opened it", isInsideSheet === false, `contains=${isInsideSheet}`);
  const scrollInfo = await page.evaluate(() => {
    const panel = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.getAttribute("aria-label") === "Date");
    return panel ? { scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight } : null;
  });
  ok(
    "Add Expense: opening the calendar never inflates the sheet's scrollHeight",
    scrollInfo && scrollInfo.scrollHeight <= scrollInfo.clientHeight + 1,
    JSON.stringify(scrollInfo)
  );
  const styleInfo = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Choose date"]');
    const cs = getComputedStyle(dialog);
    return { borderRadius: cs.borderRadius, hasShadow: cs.boxShadow !== "none" };
  });
  ok("calendar popover uses the app's .card border-radius (14px)", styleInfo?.borderRadius === "14px", JSON.stringify(styleInfo));
  ok("calendar popover has an elevation shadow, matching other floating UI", styleInfo?.hasShadow === true);
  await page.screenshot({ path: path.join(SHOT, "datepicker-open.png") });
  // Escape closes the whole modal (a pre-existing, app-wide handler this
  // sprint doesn't touch) — each subsequent check re-navigates rather than
  // assuming the modal survives it.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);

  // ══════════════ 2. Flip: reduced viewport height forces the popover above the trigger ══════════════
  // Bills' shorter form puts the date trigger close enough to a reduced
  // viewport's bottom edge to force a flip without tripping any responsive
  // hide rules the header's own buttons have.
  await page.setViewportSize({ width: 1280, height: 650 });
  await page.goto("http://localhost:3000/bills", { waitUntil: "load" });
  // The bills page has no add button of its own any more — the section's FAB
  // is the entry point, and its single action opens the same form.
  // The bills page has no add button of its own — the section's FAB is the
  // entry point. It has a single action, so it usually opens the form
  // directly; if a chooser appears instead, take its action. Waiting on the
  // form's own field keeps this from clicking the modal's "Add bill" SUBMIT,
  // which shares the FAB's name.
  await page.getByRole("button", { name: /Add bill/i }).filter({ visible: true }).first().click();
  await page.waitForTimeout(500);
  if (!(await page.locator('input[placeholder="e.g. ACT Fibernet"]').isVisible().catch(() => false))) {
    const chooser = page.getByRole("dialog").last();
    if (await chooser.getByRole("button", { name: /Add bill/i }).count()) {
      await chooser.getByRole("button", { name: /Add bill/i }).first().click();
    }
  }
  await page.waitForSelector('input[placeholder="e.g. ACT Fibernet"]', { timeout: 15000 });
  await openDateDialog(dateTriggerIn(modal()));
  await page.waitForTimeout(150); // let the layout-effect position settle
  const flipRects = await page.evaluate(() => {
    const trigger = [...document.querySelectorAll('button[aria-haspopup="dialog"]')].find((b) => b.closest(".fixed.inset-0"));
    const dialog = document.querySelector('[role="dialog"][aria-label="Choose date"]');
    if (!trigger || !dialog) return null;
    const t = trigger.getBoundingClientRect();
    const d = dialog.getBoundingClientRect();
    return { triggerTop: t.top, dialogTop: d.top, dialogBottom: d.bottom };
  });
  ok("Bills: with no room below, the calendar flips to render ABOVE the trigger", flipRects && flipRects.dialogBottom <= flipRects.triggerTop + 1, JSON.stringify(flipRects));
  ok("Bills: the flipped calendar stays fully within the viewport (no clipped top)", flipRects && flipRects.dialogTop >= 0, JSON.stringify(flipRects));
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(150);

  // ══════════════ 3. Shift: reduced viewport width clamps the popover to stay on-screen ══════════════
  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto("http://localhost:3000/bills", { waitUntil: "load" });
  // The bills page has no add button of its own any more — the section's FAB
  // is the entry point, and its single action opens the same form.
  // The bills page has no add button of its own — the section's FAB is the
  // entry point. It has a single action, so it usually opens the form
  // directly; if a chooser appears instead, take its action. Waiting on the
  // form's own field keeps this from clicking the modal's "Add bill" SUBMIT,
  // which shares the FAB's name.
  await page.getByRole("button", { name: /Add bill/i }).filter({ visible: true }).first().click();
  await page.waitForTimeout(500);
  if (!(await page.locator('input[placeholder="e.g. ACT Fibernet"]').isVisible().catch(() => false))) {
    const chooser = page.getByRole("dialog").last();
    if (await chooser.getByRole("button", { name: /Add bill/i }).count()) {
      await chooser.getByRole("button", { name: /Add bill/i }).first().click();
    }
  }
  await page.waitForSelector('input[placeholder="e.g. ACT Fibernet"]', { timeout: 15000 });
  ok("Bills: no native date/month input anywhere in the form", (await modal().locator('input[type="date"], input[type="month"]').count()) === 0);
  await openDateDialog(dateTriggerIn(modal()));
  await portalCheck('[role="dialog"][aria-label="Choose date"]', "Bills");
  await page.waitForTimeout(150);
  const shiftRect = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"][aria-label="Choose date"]').getBoundingClientRect();
    return { left: d.left, right: d.right, viewportW: window.innerWidth };
  });
  ok("Bills: the calendar never renders past the right edge of a narrow viewport", shiftRect.right <= shiftRect.viewportW, JSON.stringify(shiftRect));
  ok("Bills: the calendar never renders past the left edge of the viewport", shiftRect.left >= 0, JSON.stringify(shiftRect));
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(150);

  // ══════════════ 4. Period picker: month grid, portal, and no native inputs ══════════════
  // The period picker is now a single "Change period" trigger opening a themed
  // selector (bottom sheet on mobile, popover on desktop). Month selection is a
  // sub-view with a data-month grid; custom range is another sub-view. No part
  // of it uses a native <input type=month|date>.
  await page.goto("http://localhost:3000/dashboard", { waitUntil: "load" });
  await page
    .getByText(/^(TOTAL BALANCE|BALANCE · .+)$/)
    .filter({ visible: true })
    .first()
    .waitFor({ timeout: 20000 });
  ok("no native type=month/date input anywhere on Dashboard", (await page.locator('input[type="date"], input[type="month"]').count()) === 0);
  await page.getByRole("button", { name: "Change period" }).click();
  await page.waitForSelector('[role="dialog"][aria-label="Select period"]');
  await portalCheck('[role="dialog"][aria-label="Select period"]', "Period picker");
  await page.getByRole("button", { name: /Pick a month/ }).click();
  await page.waitForSelector('[aria-label="Previous year"]');
  await page.click('[aria-label="Previous year"]');
  await page.waitForTimeout(100);
  await page.click('[data-month="3"]');
  await page.waitForURL("**/dashboard?p=**", { timeout: 10000 });
  ok("picking a month in the themed grid navigates via ?p=YYYY-MM", page.url().includes("p="), page.url());

  // ══════════════ 5. Period picker: custom range (Start/End), min/max enforcement ══════════════
  await page.goto("http://localhost:3000/dashboard", { waitUntil: "load" });
  await page
    .getByText(/^(TOTAL BALANCE|BALANCE · .+)$/)
    .filter({ visible: true })
    .first()
    .waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Change period" }).click();
  await page.waitForSelector('[role="dialog"][aria-label="Select period"]');
  await page.getByRole("button", { name: /Custom range/ }).click();
  await page.waitForSelector('button[aria-label="Start date"]');
  await page.click('button[aria-label="Start date"]');
  await page.waitForSelector('[role="dialog"][aria-label="Choose date"]');
  // Step back a month so days 5/10 are always in the past regardless of what
  // day-of-month the suite runs on (max is capped at today).
  await page.click('[aria-label="Previous month"]');
  await page.waitForTimeout(80);
  await page.click('[data-day="5"]');
  await page.waitForTimeout(150);
  await page.click('button[aria-label="End date"]');
  await page.waitForSelector('[role="dialog"][aria-label="Choose date"]');
  await page.click('[aria-label="Previous month"]');
  await page.waitForTimeout(80);
  const toDay3Disabled = await page.locator('[data-day="3"]').isDisabled(); // 3 < Start's 5 -> must be blocked by min
  ok("Custom range: End-date field disables days before the Start-date (min enforced)", toDay3Disabled);
  await page.click('[data-day="10"]'); // between Start(5) and today, always valid
  await page.waitForTimeout(150);
  const applyBtn = page.getByRole("button", { name: "Apply range", exact: true });
  ok("Custom range: Apply enables once both Start/End are themed-picked", await applyBtn.isEnabled());
  await applyBtn.click();
  await page.waitForURL("**/dashboard?from=**", { timeout: 10000 });
  ok("applying a custom range navigates with from=/to= params", page.url().includes("from=") && page.url().includes("to="), page.url());

  // ══════════════ 6. Edit Expense / Edit Income / Edit Transfer date fields ══════════════
  const suffix = Date.now().toString(36);

  async function createAndEdit(kind, setup, merchantOrLabel) {
    await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
    await setup();
    // The composer confirms a create with its success wash rather than a
    // toast; `setup()` already waited for it to close. Transfers still open
    // the classic form and still raise one.
    if (kind === "transfer") await page.waitForSelector("text=Transfer added");
    await page.waitForTimeout(600);
    await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
    // Search is a collapsed <details> — opt-in, so it has to be opened first.
    {
      const field = page.locator('input[placeholder^="Search"]');
      if (!(await field.isVisible())) await page.locator("summary").filter({ hasText: "Search" }).first().click();
      await field.waitFor({ state: "visible", timeout: 15000 });
      await page.waitForTimeout(200);
      await field.fill(merchantOrLabel);
    }
    await page.waitForTimeout(500);
    await page.locator(`button:has-text("${merchantOrLabel}")`).first().click();
    await page.getByRole("button", { name: "Edit", exact: true }).waitFor();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
  }

  await createAndEdit(
    "expense",
    async () => {
      await openComposer("111");
      await setComposerMerchant(`DPExpense-${suffix}`);
      await saveComposer();
    },
    `DPExpense-${suffix}`
  );
  await composer().waitFor({ timeout: 20000 });
  ok("Edit Expense: date field has no native input", (await page.locator('input[type="date"]').count()) === 0);
  await openComposerDateSheet();
  await openDateDialog(dateTriggerIn(sheet()));
  await portalCheck('[role="dialog"][aria-label="Choose date"]', "Edit Expense");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  if (await composer().count()) {
    await composer().getByRole("button", { name: "Close" }).click();
    await page.waitForTimeout(300);
  }

  await createAndEdit(
    "income",
    async () => {
      await page.click('button:has-text("＋ Add expense")');
      await composer().waitFor({ timeout: 20000 });
      // Credit is one tap inside the composer — the same screen, the other
      // half of its type control.
      await composer().getByRole("button", { name: /Credit/ }).click();
      await page.waitForTimeout(300);
      await composer().getByRole("button", { name: "Clear amount" }).click();
      for (const ch of "222") {
        await composer().getByRole("button", { name: ch, exact: true }).click();
        await page.waitForTimeout(50);
      }
      await setComposerMerchant(`DPIncome-${suffix}`);
      await saveComposer();
    },
    `DPIncome-${suffix}`
  );
  await composer().waitFor({ timeout: 20000 });
  ok("Edit Income: date field has no native input", (await page.locator('input[type="date"]').count()) === 0);
  await openComposerDateSheet();
  await openDateDialog(dateTriggerIn(sheet()));
  await portalCheck('[role="dialog"][aria-label="Choose date"]', "Edit Income");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  if (await composer().count()) {
    await composer().getByRole("button", { name: "Close" }).click();
    await page.waitForTimeout(300);
  }

  await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
  await page.getByRole("button", { name: /quick add/i }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "⇄ Transfer" }).click();
  await page.waitForSelector('input[placeholder="0"]');
  await page.fill('input[placeholder="0"]', "333");
  await page.getByRole("button", { name: "Transfer", exact: true }).click();
  await page.waitForSelector("text=Transfer recorded");
  await page.waitForTimeout(600);
  await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
  // two "Transfers" buttons exist (sidebar nav link + in-page type tab) — the tab is the last one
  await page.getByRole("button", { name: "Transfers", exact: true }).last().click();
  await page.waitForTimeout(300);
  // transfer rows show account names, not a merchant — the row's aria-label
  // includes its amount, and ₹333 is this test's distinctive value
  await page.getByRole("button", { name: /₹333/ }).first().click();
  await page.getByRole("button", { name: "Edit", exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.waitForTimeout(300);
  ok("Edit Transfer: date field has no native input", (await modal().locator('input[type="date"]').count()) === 0);
  await openDateDialog(dateTriggerIn(modal()));
  await portalCheck('[role="dialog"][aria-label="Choose date"]', "Edit Transfer");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);

  // clean up the ₹333 transfer immediately — it has no distinguishing name
  // to find again later the way the labeled expense/income/pending do
  await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
  await page.getByRole("button", { name: "Transfers", exact: true }).last().click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: /₹333/ }).first().click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForSelector("text=Delete this transaction?");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForTimeout(300);

  // ══════════════ 7. Pending Intent Edit date field ══════════════
  // navigate to a fully-loaded page first — going offline mid-navigation
  // would fail the load itself; the outbox only kicks in for in-page actions
  await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
  await context.setOffline(true);
  await openComposer("444");
  await setComposerMerchant(`DPPending-${suffix}`);
  await saveComposer();
  await page.waitForTimeout(500);
  await page.click(`button:has-text("DPPending-${suffix}")`);
  await page.waitForSelector("text=Edit");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
  ok("Pending Intent Edit: date field has no native input", (await modal().locator('input[type="date"]').count()) === 0);
  await dateTriggerIn(modal()).click();
  await page.waitForSelector('[role="dialog"][aria-label="Choose date"]');
  await portalCheck('[role="dialog"][aria-label="Choose date"]', "Pending Intent Edit");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  await page.getByRole("button", { name: "Cancel", exact: true }).click().catch(() => {});
  await context.setOffline(false);
  await page.waitForSelector("text=Waiting to sync", { state: "detached", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);

  // cleanup: delete every transaction this script created
  for (const label of [`DPExpense-${suffix}`, `DPIncome-${suffix}`, `DPPending-${suffix}`]) {
    await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
    const search = page.locator('input[placeholder^="Search"]');
    if (!(await search.isVisible())) await page.locator("summary").filter({ hasText: "Search" }).first().click();
    await search.waitFor({ state: "visible", timeout: 15000 });
    await page.waitForTimeout(200);
    await search.fill(label);
    await page.waitForTimeout(500);
    const row = page.locator(`button:has-text("${label}")`).first();
    if (await row.isVisible().catch(() => false)) {
      await row.click();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page.waitForSelector("text=Delete this transaction?");
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page.waitForTimeout(300);
    }
  }
} catch (e) {
  ok("script error", false, String(e).slice(0, 800));
  await page.screenshot({ path: path.join(SHOT, "datepicker-error.png"), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
