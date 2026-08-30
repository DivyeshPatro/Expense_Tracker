// Driving the full-screen composer from a test.
//
// An owner's Debit/Credit edit opens the composer instead of the classic modal
// form, so several suites that used to fill `input[placeholder="0"]` and press
// "Save changes" now need a keypad and a swipe. One helper rather than five
// copies, because the day the composer's markup moves, it should move in one
// place.
//
// Non-owner edits, transfers, and rows with a queued change still open the
// classic forms — suites driving those are deliberately untouched.

import type { Page } from "playwright";

/** The composer's root. Present only while it is open. */
export const composerOf = (page: Page) => page.locator("div[data-composer]");

/** The topmost sheet. In edit mode the transaction sheet is still mounted
 *  underneath (inert), so "the dialog" alone is ambiguous. */
export const topSheet = (page: Page) => page.getByRole("dialog").last();

const KEY_ARIA: Record<string, string> = {
  ".": "Decimal point",
  "+": "Plus",
  "-": "Minus",
  "×": "Multiply",
  "÷": "Divide",
};

/** Clear whatever is there and tap in a new amount. */
export async function typeAmount(page: Page, amount: string, { clear = true }: { clear?: boolean } = {}) {
  const c = composerOf(page);
  await c.waitFor({ timeout: 20000 });
  if (clear) {
    await c.getByRole("button", { name: "Clear amount" }).click();
    await page.waitForTimeout(80);
  }
  for (const ch of amount) {
    await c.getByRole("button", { name: KEY_ARIA[ch] ?? ch, exact: true }).click();
    await page.waitForTimeout(60);
  }
}

/**
 * Drag the confirm handle the whole way — the composer has no Save button.
 *
 * Waits for the composer to go away afterwards so callers can carry on the way
 * they used to after `waitForSelector("text=Save changes", { state: "detached" })`.
 */
export async function saveComposer(page: Page) {
  const track = composerOf(page).locator("div[role='slider']");
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
  await composerOf(page).waitFor({ state: "detached", timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);
}

/** Open the split editor from the composer's group line. */
export async function openSplitSheet(page: Page) {
  await composerOf(page).getByRole("button", { name: /people ·/ }).click();
  await page.waitForTimeout(700);
}
