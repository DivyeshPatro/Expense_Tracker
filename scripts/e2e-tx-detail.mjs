// Proves Phase 1 (transaction details/editing): opening detail, editing each
// transaction type (expense, income, transfer, split expense), delete from
// the detail view (confirm required, then undo), cancel-without-mutation,
// and that account balances stay correct through every edit. Self-cleaning —
// every transaction this script creates is deleted (not undone) by the end,
// so re-runs start from the same state.
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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
// 15s was a warm-server budget. This script is the first to visit /accounts and
// /transactions in a run, and `next dev` compiles a route on its first request —
// which alone can outlast it, so the suite failed on the dev server rather than
// on the app. Slow is expected on a cold start; hanging is not.
page.setDefaultTimeout(30000);

function rupeeToPaise(s) {
  // the app renders negative amounts with U+2212 MINUS SIGN, not ASCII "-",
  // which Number() silently refuses to parse (-> NaN) unless normalized first.
  return Math.round(Number(String(s).replace(/₹|,|\s/g, "").replace(/−/g, "-")) * 100);
}

async function accountBalance(name) {
  await page.goto("http://localhost:3000/accounts?p=all", { waitUntil: "load" });
  // Each account is a list item whose link holds icon, name, type (with the
  // period net appended when it is non-zero) and finally the balance. It used
  // to be a `div.card` with the balance first — hence a selector that matched
  // nothing and a parse that would have read the period net as the balance.
  const row = page.getByRole("listitem").filter({ hasText: name }).first();
  await row.waitFor();
  const text = await row.getByRole("link").first().textContent();
  // Decimals matter: a balance of ₹1,234.56 must not be read as ₹1,234.
  const m = text.match(/−?₹[\d,]+(?:\.\d+)?/g);
  // The balance is the last amount in the row; anything before it is the
  // period-net suffix on the type line.
  return rupeeToPaise(m[m.length - 1]);
}

// "text=Edit"/"text=Delete" would substring-match "CrEDITard" categories or
// "Transaction DELETEd" toasts — always use exact role-based matches instead.
const editBtn = () => page.getByRole("button", { name: "Edit", exact: true });
const cancelBtn = () => page.getByRole("button", { name: "Cancel", exact: true });
const saveBtn = () => page.getByRole("button", { name: "Save changes", exact: true });
const deleteBtn = () => page.getByRole("button", { name: "Delete", exact: true });

// An owner's Debit/Credit edit opens the full-screen composer now; a TRANSFER
// edit still opens the classic form, so the helpers below are used only where
// the type is an expense or an income. The composer has no text input for the
// amount by design - it is a keypad - so an amount is cleared and tapped in.
const composer = () => page.locator("div[data-composer]");
const KEY_ARIA = { ".": "Decimal point", "00": "Double zero" };
async function typeComposerAmount(rupees) {
  await composer().waitFor({ timeout: 15000 });
  await composer().getByRole("button", { name: "Clear amount" }).click();
  await page.waitForTimeout(80);
  for (const ch of String(rupees)) {
    await composer().getByRole("button", { name: KEY_ARIA[ch] ?? ch, exact: true }).click();
    await page.waitForTimeout(60);
  }
}
/** Drag the confirm handle the whole way, which is how the composer saves. */
async function composerSave() {
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
  await page.waitForTimeout(900);
}
const undoBtn = () => page.getByRole("button", { name: "Undo", exact: true });

/**
 * Choose an account in an open dialog by NAME.
 *
 * Options are labelled "{icon} {name}", and matching that whole string couples
 * every assertion to an emoji — one invisible variation selector apart and
 * selectOption simply times out with the right element in hand. Read the value
 * off the option whose text contains the name, then select that.
 */
async function chooseAccount(fieldLabel, accountName) {
  const dialog = page.getByRole("dialog");
  const value = await dialog.locator("option").filter({ hasText: accountName }).first().getAttribute("value");
  // force: the dialog's sticky action bar overlays the centre of these
  // controls, so Playwright's actionability check never passes even though the
  // select is visible, enabled and in the viewport. Selecting an option on a
  // native <select> sets the value and fires change without needing a pointer
  // event, so this tests the same code path a user drives. The overlap itself
  // is a layout problem in the modal, not a test problem — see the hit test in
  // the commit message.
  await dialog.getByLabel(fieldLabel).selectOption(value, { force: true });
}

async function openRow(merchantText) {
  await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
  // Search is a collapsed <details> now — the list is the page's job and the
  // field is opt-in — so it has to be opened before it can be typed into.
  const search = page.locator('input[placeholder^="Search"]');
  if (!(await search.isVisible())) await page.locator("summary", { hasText: "Search" }).first().click();
  await search.waitFor();
  await search.fill(merchantText);
  await page.waitForTimeout(500);
  await page.locator(`button:has-text("${merchantText}")`).first().click();
  await editBtn().waitFor({ timeout: 8000 });
}

async function confirmAndDelete() {
  await deleteBtn().click(); // shows the inline "Delete this transaction?" confirm
  await page.waitForSelector("text=Delete this transaction?");
  await deleteBtn().click(); // the confirm step's own Delete button
  await page.waitForSelector("text=Transaction deleted", { timeout: 8000 });
  await page.waitForTimeout(400);
}

try {
  // Tolerate a cold `next dev` server, the same way scripts/e2e.mjs does:
  // submitting before React has hydrated fires a native form GET that never
  // reaches /dashboard, and the first authenticated render has to compile the
  // route before it can answer. Wait for the button, then retry.
  let signedIn = false;
  for (let attempt = 0; attempt < 3 && !signedIn; attempt++) {
    await page.goto("http://localhost:3000/sign-in", { waitUntil: "domcontentloaded", timeout: 60000 });
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

  // ═══════════ Expense: open, edit, cancel-without-mutation, delete+undo ═══════════
  const before1 = await accountBalance("Cash Wallet");

  await page.click('button:has-text("＋ Add expense")');
  await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
  // Field renders an implicit <label>, so address the control by its label
  // inside the dialog — "the first <select> on the page" hit the list behind the
  // modal, and the label alone matches every form that has an ACCOUNT field.
  // And no .catch(): swallowing this put the expense on whichever account
  // happened to be first, leaving the balance assertion below reporting a
  // mystery instead of the reason.
  await chooseAccount("ACCOUNT", "Cash Wallet");
  await page.fill('input[placeholder="0"]', "500");
  await page.fill('input[placeholder="e.g. Swiggy"]', "E2ETxDetailExpense");
  await page.getByRole("button", { name: "Add expense", exact: true }).click();
  await page.waitForSelector("text=Expense added");
  await page.waitForTimeout(500);

  const afterAdd1 = await accountBalance("Cash Wallet");
  ok("expense creation debits the account by the entered amount", afterAdd1 === before1 - 50000, `${before1} -> ${afterAdd1}`);

  // ── open details ──
  await openRow("E2ETxDetailExpense");
  const detailBody = await page.textContent("body");
  ok("transaction detail opens on row tap and shows the correct amount", detailBody.includes("E2ETxDetailExpense") && detailBody.includes("₹500"));

  // ── edit: change amount, cancel without saving ──
  await editBtn().click();
  await typeComposerAmount("999");
  await cancelBtn().click();
  await editBtn().waitFor({ timeout: 5000 }); // back in read-only mode (Edit button visible again)
  // scoped to the modal panel, not the whole page — the transaction list
  // behind it has plenty of unrelated historical amounts containing "999"
  const modalPanel = page.locator(".fixed.inset-0.z-\\[60\\]").first();
  const afterCancelModalText = await modalPanel.textContent();
  ok(
    "cancel returns to read-only view without saving the edited amount",
    afterCancelModalText.includes("₹500") && !afterCancelModalText.includes("999")
  );
  const afterCancelBalance = await accountBalance("Cash Wallet");
  ok("cancel does not mutate the account balance", afterCancelBalance === afterAdd1, `${afterAdd1} vs ${afterCancelBalance}`);

  // ── edit: actually change amount, save ──
  await openRow("E2ETxDetailExpense");
  await editBtn().click();
  await typeComposerAmount("750");
  await composerSave();
  await page.waitForSelector("text=Transaction updated", { timeout: 8000 });
  await page.waitForTimeout(500);

  const afterEdit1 = await accountBalance("Cash Wallet");
  ok(
    "editing an expense's amount updates the account balance atomically (old effect reversed, new applied)",
    afterEdit1 === afterAdd1 - 25000,
    `${afterAdd1} -> ${afterEdit1} (expected -250 more)`
  );

  // ── delete requires confirmation, then undo ──
  // Note: accountBalance() navigates the page, which would tear down the
  // toast (and its undo closure) if called before Undo is clicked — so undo
  // happens first, immediately, while still on this page; balance checks
  // (which need a navigation) happen only once nothing further is pending.
  await openRow("E2ETxDetailExpense");
  await deleteBtn().click();
  await page.waitForTimeout(200);
  const confirmBody = await page.textContent("body");
  ok("delete shows an inline confirm step rather than deleting immediately", confirmBody.includes("Delete this transaction?"));
  await deleteBtn().click();
  await page.waitForSelector("text=Transaction deleted", { timeout: 8000 });

  await undoBtn().click();
  await page.waitForSelector("text=Restored", { timeout: 8000 });
  await page.waitForTimeout(400);
  // Restoring writes the row and re-applies the balance in the background; a
  // single read right after the toast catches it mid-flight, which made this
  // check fail about one run in three. Poll for the settled value instead.
  let afterUndo1 = 0;
  for (let i = 0; i < 10; i++) {
    afterUndo1 = await accountBalance("Cash Wallet");
    if (afterUndo1 === afterEdit1) break;
    await page.waitForTimeout(500);
  }
  ok("undo restores the (edited) transaction and re-applies its balance effect", afterUndo1 === afterEdit1, `expected ${afterEdit1}, got ${afterUndo1}`);

  // final delete (no undo this time) — also proves delete reverses the balance effect
  await openRow("E2ETxDetailExpense");
  await confirmAndDelete();
  const afterFinalDelete1 = await accountBalance("Cash Wallet");
  ok("delete from detail view reverses the balance effect", afterFinalDelete1 === before1, `expected back to ${before1}, got ${afterFinalDelete1}`);

  // ═══════════ Income ═══════════
  // Add income/Transfer no longer live in the ⌘K palette (Phase 2 trimmed
  // those duplicate rows) — use the desktop quick-add chooser instead, the
  // remaining non-form entry point for these two types.
  const beforeInc = await accountBalance("HDFC Savings");
  // accountBalance() leaves us on /accounts, whose quick-add offers Transfer
  // and Add account — the FAB's actions follow the section it is on, so the
  // income entry point only exists back on the spending screen.
  await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
  await page.getByRole("button", { name: /quick add/i }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: /Add income/i }).filter({ visible: true }).first().click();
  // The FAB opens the composer, which starts on Debit - Credit is one tap, the
  // amount is the keypad, and the description lives behind the merchant line.
  await composer().waitFor({ timeout: 15000 });
  await composer().getByRole("button", { name: /Credit/ }).click();
  await page.waitForTimeout(400);
  await typeComposerAmount("2000");
  await composer().getByRole("button", { name: "Merchant and notes" }).click();
  await page.waitForTimeout(500);
  await page.getByRole("dialog").last().locator("input").first().fill("E2ETxDetailIncome");
  await page.getByRole("dialog").last().getByRole("button", { name: "Done", exact: true }).click();
  await page.waitForTimeout(400);
  await composerSave();
  await page.waitForSelector("text=Credit added, text=Income added", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(900);
  await page.waitForTimeout(500);
  const afterAddInc = await accountBalance("HDFC Savings");

  await openRow("E2ETxDetailIncome");
  await editBtn().click();
  await typeComposerAmount("3000");
  await composerSave();
  await page.waitForSelector("text=Transaction updated");
  await page.waitForTimeout(500);
  const afterEditInc = await accountBalance("HDFC Savings");
  ok("editing income updates the account balance correctly", afterEditInc === afterAddInc + 100000, `${afterAddInc} -> ${afterEditInc}`);

  await openRow("E2ETxDetailIncome");
  await confirmAndDelete();
  const afterDelInc = await accountBalance("HDFC Savings");
  ok("deleting the edited income reverses its (edited) balance effect", afterDelInc === beforeInc, `expected ${beforeInc}, got ${afterDelInc}`);

  // ═══════════ Transfer ═══════════
  const beforeFrom = await accountBalance("HDFC Savings");
  const beforeTo = await accountBalance("Cash Wallet");
  await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
  // The FAB's accessible name is built from the section it is on
  // ("<section> — quick add"), and Transfer is one of its menu actions rather
  // than a header button — "Quick add (desktop)" and "⇄ Transfer" are both gone.
  await page.getByRole("button", { name: /quick add/i }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: /Transfer money/i }).filter({ visible: true }).first().click();
  await page.waitForSelector('input[placeholder="0"]');
  // FROM/TO default to the first two accounts in refData order, which isn't
  // guaranteed to be HDFC Savings -> Cash Wallet — pin both explicitly so the
  // balance assertions below check the accounts they claim to.
  await chooseAccount("FROM", "HDFC Savings");
  await chooseAccount("TO", "Cash Wallet");
  await page.fill('input[placeholder="0"]', "1000");
  await page.getByRole("button", { name: "Transfer", exact: true }).click();
  await page.waitForSelector("text=Transfer recorded");
  await page.waitForTimeout(500);

  await openRow("HDFC Savings → Cash Wallet");
  const transferDetailBody = await page.textContent("body");
  ok("transfer detail shows From and To accounts", transferDetailBody.includes("From") && transferDetailBody.includes("To") && transferDetailBody.includes("₹1,000"));

  await editBtn().click();
  await page.waitForSelector('input[placeholder="0"]');
  await page.fill('input[placeholder="0"]', "1500");
  await saveBtn().click();
  await page.waitForSelector("text=Transaction updated");
  await page.waitForTimeout(500);
  const afterFrom = await accountBalance("HDFC Savings");
  const afterTo = await accountBalance("Cash Wallet");
  ok(
    "editing a transfer's amount updates both accounts correctly",
    afterFrom === beforeFrom - 150000 && afterTo === beforeTo + 150000,
    `from ${beforeFrom}->${afterFrom}, to ${beforeTo}->${afterTo}`
  );

  await openRow("HDFC Savings → Cash Wallet");
  await confirmAndDelete();
  const cleanFrom = await accountBalance("HDFC Savings");
  const cleanTo = await accountBalance("Cash Wallet");
  ok("deleting the edited transfer reverses both account effects", cleanFrom === beforeFrom && cleanTo === beforeTo, `${cleanFrom} vs ${beforeFrom}, ${cleanTo} vs ${beforeTo}`);

  // ═══════════ Split / shared expense ═══════════
  await page.click('button:has-text("＋ Add expense")');
  await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
  await page.fill('input[placeholder="0"]', "300");
  await page.fill('input[placeholder="e.g. Swiggy"]', "E2ETxDetailSplit");
  // A role="switch". The dialog's sticky action bar overlays it, and a forced
  // click is NOT the answer — force skips the hit check but still dispatches at
  // the coordinate, so the event lands on the action bar and closes the modal.
  // Dispatch the click on the element itself, which drives the same handler.
  await page.locator('[role="switch"]').filter({ hasText: "Split with friends" }).first().dispatchEvent("click");
  // Scoped to the dialog: a bare text= match also finds occurrences in the list
  // behind the modal, and waits on whichever it happens to resolve first.
  // The picker sits below the fold in a tall dialog, so it has to be scrolled
  // to before it can be interacted with. dispatchEvent for the same reason as
  // the switch above: the sticky action bar sits over this part of the form.
  const karan = page.getByRole("dialog").locator("button").filter({ hasText: "Karan" }).first();
  await karan.scrollIntoViewIfNeeded();
  await karan.dispatchEvent("click");
  await page.getByRole("button", { name: "Add expense", exact: true }).click();
  await page.waitForSelector("text=Split expense added");
  await page.waitForTimeout(500);

  await openRow("E2ETxDetailSplit");
  const splitDetailBody = await page.textContent("body");
  ok("split expense detail shows the split breakdown", splitDetailBody.includes("Split") && splitDetailBody.includes("Karan"));

  await editBtn().click();
  // The split lives behind the composer's group line, and the per-person
  // inputs are the split sheet's own number fields.
  await composer().waitFor({ timeout: 15000 });
  await composer().getByRole("button", { name: /people ·/ }).click();
  await page.waitForTimeout(700);
  const splitSheet = page.getByRole("dialog").last();
  await splitSheet.getByRole("button", { name: "Exact amounts", exact: true }).click();
  await page.waitForTimeout(300);
  // Karan's exact input is pre-filled from the original equal share (₹150).
  const exactInput = splitSheet.locator("input[type='number']").last();
  const prefilled = await exactInput.inputValue();
  ok("switching an existing split to Exact mode pre-fills the current owed amount", Number(prefilled) === 150, `got "${prefilled}"`);
  await exactInput.fill("200");
  await exactInput.blur();
  await page.waitForTimeout(250);
  await splitSheet.getByRole("button", { name: "Done", exact: true }).click();
  await page.waitForTimeout(400);
  await composerSave();
  await page.waitForSelector("text=Transaction updated");
  await page.waitForTimeout(500);

  await openRow("E2ETxDetailSplit");
  const afterSplitEditBody = await page.textContent("body");
  ok("edited split amounts are reflected in the detail view (Karan owes ₹200, your share is the remainder)", afterSplitEditBody.includes("₹200") && afterSplitEditBody.includes("₹100"));

  await confirmAndDelete();
} catch (e) {
  ok("script error", false, String(e).slice(0, 500));
  await page.screenshot({ path: `${SHOT}/tx-detail-error.png`, fullPage: true });
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
