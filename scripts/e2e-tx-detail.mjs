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
page.setDefaultTimeout(15000);

function rupeeToPaise(s) {
  // the app renders negative amounts with U+2212 MINUS SIGN, not ASCII "-",
  // which Number() silently refuses to parse (-> NaN) unless normalized first.
  return Math.round(Number(String(s).replace(/₹|,|\s/g, "").replace(/−/g, "-")) * 100);
}

async function accountBalance(name) {
  await page.goto("http://localhost:3000/accounts?p=all", { waitUntil: "load" });
  const card = page.locator("div.card", { hasText: name }).first();
  await card.waitFor();
  const text = await card.textContent();
  const m = text.match(/(−?₹[\d,]+)/g);
  // first ₹ match is the main balance line; a second (equal or not) is the period-net line
  return rupeeToPaise(m[0]);
}

// "text=Edit"/"text=Delete" would substring-match "CrEDITard" categories or
// "Transaction DELETEd" toasts — always use exact role-based matches instead.
const editBtn = () => page.getByRole("button", { name: "Edit", exact: true });
const cancelBtn = () => page.getByRole("button", { name: "Cancel", exact: true });
const saveBtn = () => page.getByRole("button", { name: "Save changes", exact: true });
const deleteBtn = () => page.getByRole("button", { name: "Delete", exact: true });
const undoBtn = () => page.getByRole("button", { name: "Undo", exact: true });

async function openRow(merchantText) {
  await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
  await page.fill('input[placeholder^="Search"]', merchantText);
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
  await page.goto("http://localhost:3000/sign-in");
  await page.fill('input[type="email"]', "arjun@ledgerly.app");
  await page.fill('input[type="password"]', "ledgerly-demo");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 15000 });

  // ═══════════ Expense: open, edit, cancel-without-mutation, delete+undo ═══════════
  const before1 = await accountBalance("Cash Wallet");

  await page.click('button:has-text("＋ Add expense")');
  await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
  await page.selectOption('select', { label: "💵 Cash Wallet" }).catch(() => {});
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
  await page.waitForSelector('input[placeholder="0"]');
  await page.fill('input[placeholder="0"]', "999");
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
  await page.waitForSelector('input[placeholder="0"]');
  await page.fill('input[placeholder="0"]', "750");
  await saveBtn().click();
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
  const afterUndo1 = await accountBalance("Cash Wallet");
  ok("undo restores the (edited) transaction and re-applies its balance effect", afterUndo1 === afterEdit1, `expected ${afterEdit1}, got ${afterUndo1}`);

  // final delete (no undo this time) — also proves delete reverses the balance effect
  await openRow("E2ETxDetailExpense");
  await confirmAndDelete();
  const afterFinalDelete1 = await accountBalance("Cash Wallet");
  ok("delete from detail view reverses the balance effect", afterFinalDelete1 === before1, `expected back to ${before1}, got ${afterFinalDelete1}`);

  // ═══════════ Income ═══════════
  const beforeInc = await accountBalance("HDFC Savings");
  await page.click('button:has-text("Search")');
  await page.waitForTimeout(250);
  await page.locator("text=Add income").first().click();
  await page.waitForSelector('input[placeholder="e.g. Salary · Acme Corp"]');
  await page.fill('input[placeholder="0"]', "2000");
  await page.fill('input[placeholder="e.g. Salary · Acme Corp"]', "E2ETxDetailIncome");
  await page.getByRole("button", { name: "Add income", exact: true }).click();
  await page.waitForSelector("text=Income added");
  await page.waitForTimeout(500);
  const afterAddInc = await accountBalance("HDFC Savings");

  await openRow("E2ETxDetailIncome");
  await editBtn().click();
  await page.waitForSelector('input[placeholder="0"]');
  await page.fill('input[placeholder="0"]', "3000");
  await saveBtn().click();
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
  // a neutral page with no standalone "Transfer money" button of its own —
  // both Accounts and Dashboard have one, which the palette's own action
  // item would collide with via a plain text locator.
  await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
  await page.click('button:has-text("Search")');
  await page.waitForTimeout(400);
  await page.locator('text=Transfer money').first().click();
  await page.waitForSelector('input[placeholder="0"]');
  // FROM/TO default to the first two accounts in refData order, which isn't
  // guaranteed to be HDFC Savings -> Cash Wallet — pin both explicitly so the
  // balance assertions below check the accounts they claim to.
  const selects = page.locator("select.field");
  await selects.nth(0).selectOption({ label: "🏦 HDFC Savings" }).catch(() => {});
  await selects.nth(1).selectOption({ label: "💵 Cash Wallet" }).catch(() => {});
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
  await page.click("text=👥 Split with friends");
  await page.waitForSelector("text=Karan");
  await page.click('button:has-text("Karan")');
  await page.getByRole("button", { name: "Add expense", exact: true }).click();
  await page.waitForSelector("text=Split expense added");
  await page.waitForTimeout(500);

  await openRow("E2ETxDetailSplit");
  const splitDetailBody = await page.textContent("body");
  ok("split expense detail shows the split breakdown", splitDetailBody.includes("Split") && splitDetailBody.includes("Karan"));

  await editBtn().click();
  await page.getByRole("button", { name: "Exact amounts", exact: true }).click();
  await page.waitForTimeout(200);
  // exact input for Karan should be pre-filled from the original equal share (₹150)
  const exactInput = page.locator('input[placeholder="0"]').last();
  const prefilled = await exactInput.inputValue();
  ok("switching an existing split to Exact mode pre-fills the current owed amount", Number(prefilled) === 150, `got "${prefilled}"`);
  await exactInput.fill("200");
  await saveBtn().click();
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
