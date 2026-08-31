// Driving the full-screen composer from a plain-JS suite.
//
// The sibling of composer-drive.ts, which the TypeScript suites import. Adding
// or editing a Debit/Credit is a screen now: the amount is a keypad, each field
// sits behind its own sheet, and the commit is a swipe rather than a button. A
// suite that still fills `input[placeholder="0"]` is driving a form the app no
// longer opens.
//
// Transfers, settle, bills and every other modal are untouched — they are still
// dialogs, and suites driving those should keep doing exactly what they do.

/** The composer's root. Present only while it is open. */
export const composerOf = (page) => page.locator("div[data-composer]");

/** The topmost sheet — in edit mode the transaction sheet is still mounted
 *  underneath (inert), so "the dialog" alone is ambiguous. */
export const topSheet = (page) => page.getByRole("dialog").last();

const KEY_ARIA = { ".": "Decimal point", "+": "Plus", "-": "Minus", "×": "Multiply", "÷": "Divide" };

/** Clear whatever is there and tap in a new amount. */
export async function typeAmount(page, amount) {
  const c = composerOf(page);
  await c.waitFor({ timeout: 20000 });
  await c.getByRole("button", { name: "Clear amount" }).click();
  await page.waitForTimeout(60);
  for (const ch of String(amount)) {
    await c.getByRole("button", { name: KEY_ARIA[ch] ?? ch, exact: true }).click();
    await page.waitForTimeout(50);
  }
}

/** The merchant lives behind the composer's "Who's it for?" line. */
export async function setMerchant(page, merchant) {
  await composerOf(page).getByRole("button", { name: "Merchant and notes" }).click();
  await page.waitForTimeout(400);
  await topSheet(page).locator("input").first().fill(merchant);
  await topSheet(page).getByRole("button", { name: "Done", exact: true }).click();
  await page.waitForTimeout(350);
}

/** Close whichever sheet is on top, if one is open. */
export async function sheetDone(page) {
  const done = topSheet(page).getByRole("button", { name: "Done", exact: true });
  if (await done.count()) {
    await done.click();
    await page.waitForTimeout(350);
  }
}

/**
 * Drag the confirm handle the whole way — the composer has no Save button.
 *
 * `expectClose` is false for the cases that deliberately test a REFUSED save:
 * the composer stays up and shows why, which is the assertion.
 */
export async function saveComposer(page, { expectClose = true } = {}) {
  await sheetDone(page);
  const track = composerOf(page).locator("div[role='slider']");
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
  if (expectClose) await composerOf(page).waitFor({ state: "detached", timeout: 20000 });
  await page.waitForTimeout(400);
}

/** Open the split editor from the composer's split line, and switch it on. */
export async function openSplitSheet(page) {
  await composerOf(page)
    .getByRole("button", { name: /people ·|Choose who's splitting|Split with someone/ })
    .click();
  await page.waitForTimeout(600);
  const sw = topSheet(page).locator('[role="switch"]').first();
  if ((await sw.getAttribute("aria-checked")) !== "true") {
    await topSheet(page).getByText("👥 Split with friends").first().click();
    await page.waitForTimeout(300);
  }
}
