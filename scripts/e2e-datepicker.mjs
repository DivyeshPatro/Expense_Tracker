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
  await page.click('button:has-text("＋ Add expense")');
  await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
  await openDateDialog(dateTriggerIn(modal()));
  await portalCheck('[role="dialog"][aria-label="Choose date"]', "Add Expense");
  const isInsideModal = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Choose date"]');
    const modalPanel = document.querySelector(".fixed.inset-0.z-\\[60\\]");
    return modalPanel ? modalPanel.contains(dialog) : null;
  });
  ok("Add Expense: popover is NOT a DOM descendant of the modal panel", isInsideModal === false, `contains=${isInsideModal}`);
  const scrollInfo = await page.evaluate(() => {
    const panel = document.querySelector(".fixed.inset-0.z-\\[60\\] > div");
    return panel ? { scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight } : null;
  });
  ok(
    "Add Expense: opening the calendar never inflates the modal panel's scrollHeight",
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
  await page.click('button:has-text("＋ New bill")');
  await page.waitForSelector('input[placeholder="e.g. ACT Fibernet"]');
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
  await page.click('button:has-text("＋ New bill")');
  await page.waitForSelector('input[placeholder="e.g. ACT Fibernet"]');
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
  await page.waitForSelector("text=TOTAL BALANCE");
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
  await page.waitForSelector("text=TOTAL BALANCE");
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
    await page.waitForSelector(kind === "income" ? "text=Income added" : kind === "transfer" ? "text=Transfer added" : "text=Expense added");
    await page.waitForTimeout(600);
    await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
    await page.fill('input[placeholder^="Search"]', merchantOrLabel);
    await page.waitForTimeout(500);
    await page.locator(`button:has-text("${merchantOrLabel}")`).first().click();
    await page.getByRole("button", { name: "Edit", exact: true }).waitFor();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
  }

  await createAndEdit(
    "expense",
    async () => {
      await page.click('button:has-text("＋ Add expense")');
      await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
      await page.fill('input[placeholder="0"]', "111");
      await page.fill('input[placeholder="e.g. Swiggy"]', `DPExpense-${suffix}`);
      await page.getByRole("button", { name: "Add expense", exact: true }).click();
    },
    `DPExpense-${suffix}`
  );
  await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
  ok("Edit Expense: date field has no native input", (await modal().locator('input[type="date"]').count()) === 0);
  await openDateDialog(dateTriggerIn(modal()));
  await portalCheck('[role="dialog"][aria-label="Choose date"]', "Edit Expense");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);

  await createAndEdit(
    "income",
    async () => {
      await page.click('button[aria-label="Quick add (desktop)"]');
      await page.getByRole("button", { name: "💰 Income" }).click();
      await page.waitForSelector('input[placeholder="e.g. Salary · Acme Corp"]');
      await page.fill('input[placeholder="0"]', "222");
      await page.fill('input[placeholder="e.g. Salary · Acme Corp"]', `DPIncome-${suffix}`);
      await page.getByRole("button", { name: "Add income", exact: true }).click();
    },
    `DPIncome-${suffix}`
  );
  await page.waitForSelector('input[placeholder="e.g. Salary · Acme Corp"]');
  ok("Edit Income: date field has no native input", (await modal().locator('input[type="date"]').count()) === 0);
  await openDateDialog(dateTriggerIn(modal()));
  await portalCheck('[role="dialog"][aria-label="Choose date"]', "Edit Income");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);

  await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
  await page.click('button[aria-label="Quick add (desktop)"]');
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
  await page.click('button:has-text("＋ Add expense")');
  await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
  await page.fill('input[placeholder="0"]', "444");
  await page.fill('input[placeholder="e.g. Swiggy"]', `DPPending-${suffix}`);
  await page.getByRole("button", { name: "Add expense", exact: true }).click();
  await page.waitForSelector("text=Expense added");
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
    await page.fill('input[placeholder^="Search"]', label);
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
