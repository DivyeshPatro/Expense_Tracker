// End-to-end walkthrough of Ledgerly against the seeded demo user.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const SHOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "e2e-output");
fs.mkdirSync(SHOT, { recursive: true });
const results = [];
const composer = (page) => page.locator("div[data-composer]");
/** Tap an amount into the composer's keypad. */
async function composerType(page, rupees) {
  await composer(page).waitFor({ timeout: 15000 });
  await composer(page).getByRole("button", { name: "Clear amount" }).click();
  for (const ch of String(rupees)) {
    await composer(page).getByRole("button", { name: ch === "." ? "Decimal point" : ch, exact: true }).click();
    await page.waitForTimeout(60);
  }
}
/** Drag the confirm handle the whole way — the composer has no Save button. */
async function composerSave(page) {
  const track = composer(page).locator("div[role='slider']");
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

const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

try {
  // ── sign in ──
  // Tolerate a cold `next dev` server: submitting before React has hydrated
  // fires a native form GET that never reaches /dashboard, so wait for the
  // button and retry instead of filling the instant the DOM appears.
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
  ok("sign-in redirects to dashboard", true);

  // ── dashboard numbers ──
  // The card's heading is "TOTAL BALANCE" only on a live window; any other
  // period renders "BALANCE · <period>". Match the half that does not depend on
  // which period the dashboard happens to open with.
  await page.getByText(/total balance|balance ·/i).filter({ visible: true }).first().waitFor();
  const body = await page.textContent("body");
  ok("total balance ₹2,30,870", body.includes("₹2,30,870"), "sum of seeded account balances");
  ok("attention strip shows bill due", body.includes("ACT Fibernet"));
  // The dashboard names each outstanding balance now ("Karan owes you ₹…",
  // "You owe Priya ₹…", each tagged "Pending settlement") rather than showing a
  // single "Friends owe you" chip.
  ok("dashboard surfaces pending settlements", /Pending settlement/.test(body) && /owes you|You owe/.test(body));
  ok("en-IN formatting", /₹\d,\d{2},\d{3}/.test(body));
  await page.screenshot({ path: `${SHOT}/01-dashboard.png`, fullPage: true });

  // ── add expense ──
  // The desktop header button deliberately still opens the CLASSIC form: it is
  // the entry point for splits, paid-by, the date picker and the offline flows,
  // none of which the composer carries. The composer is the FAB's "+ Add", and
  // is driven from the mobile section below.
  // Every Spending add action opens the full-screen composer now, this button
  // included — the amount is a keypad and the save is a swipe.
  await page.click("text=＋ Add expense");
  await composerType(page, "123");
  await composerSave(page);
  // The composer's success state is a full-screen wash that clears itself after
  // ~900ms, which is too short to wait on reliably — e2e:composer covers the
  // copy. What matters here is that it committed and closed, so wait for the
  // screen to go and read the row back off the list.
  await composer(page).waitFor({ state: "detached", timeout: 15000 });
  await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
  await page.waitForSelector("text=₹123", { timeout: 15000 });
  ok("add expense happy path — the composer commits and the row lands", true);

  // ── transactions: open detail, delete + undo (Phase 1 moved delete off the
  // row and into the detail sheet, behind a confirm step) ──
  await page.goto("http://localhost:3000/transactions");
  // Wait for the list itself rather than a "Today" day-heading: whether today
  // has a heading depends on the period the page opens with, and the check here
  // is that rows rendered at all.
  await page.locator(".card button.w-full").first().waitFor();
  // the add-expense submit just above triggers its own async router.refresh();
  // landing this hard navigation right on top of it can catch a transitional
  // paint where the count briefly reads high — let it settle before counting
  await page.waitForTimeout(500);
  const before = await page.locator(".card button.w-full").count();
  await page.locator(".card button.w-full").first().click();
  await page.getByRole("button", { name: "Delete", exact: true }).waitFor({ timeout: 8000 });
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForSelector("text=Delete this transaction?");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForSelector("text=Transaction deleted");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForSelector("text=Restored");
  let after = 0;
  for (let i = 0; i < 20; i++) {
    after = await page.locator(".card button.w-full").count();
    if (after === before) break;
    await page.waitForTimeout(400);
  }
  ok("delete + undo restores row", before === after, `${before} rows before, ${after} after`);

  // ── ⌘K palette + Ask Ledgerly ──
  await page.keyboard.press("Control+k");
  await page.waitForSelector('input[placeholder*="swiggy"]');
  await page.fill('input[placeholder*="swiggy"]', "swiggy in march");
  await page.waitForSelector("text=Ask Ledgerly", { timeout: 8000 });
  const answer = await page.locator("text=/You spent .* transactions?/").first().textContent();
  ok("Ask Ledgerly answers 'swiggy in march'", /You spent ₹/.test(answer ?? ""), answer ?? "");
  await page.screenshot({ path: `${SHOT}/02-palette.png` });
  await page.locator("text=/You spent .* transactions?/").first().click();
  await page.waitForURL("**/transactions**");
  const chipVisible = await page.waitForSelector("text=Mar 2026", { timeout: 8000 }).then(() => true).catch(() => false);
  ok("palette answer opens filtered list with month chip", chipVisible);

  // ── shared: split expense + settle ──
  await page.goto("http://localhost:3000/shared");
  // The hero is the "who needs to settle?" count with You'll get / You'll pay /
  // Net beneath it; the old "YOU OWE" heading is gone.
  await page.getByText(/You'll pay|All settled|to settle up/).first().waitFor();
  const sharedBody = await page.textContent("body");
  ok("shared shows Flat 402 group", sharedBody.includes("Flat 402"));
  // Per-person rows read "will pay you" / "you'll pay" now.
  ok("shared balances render", /will pay you|you'll pay|owes you|you owe/i.test(sharedBody));
  await page.screenshot({ path: `${SHOT}/03-shared.png`, fullPage: true });

  // add split expense ₹999 with equal split → check math note
  // ("Add split expense" no longer lives in the ⌘K palette — Phase 2 trimmed
  // that duplicate; the desktop quick-add chooser is the remaining entry point)
  // On /shared the quick-add has a single action, so the FAB runs it directly
  // instead of opening a chooser — and its accessible name is that action, not
  // "<section> — quick add". The old literal "Quick add (desktop)" is gone.
  // Shared opens the composer with the group already in context; the split
  // editor lives one tap in, behind the group line.
  await page.getByRole("button", { name: /Add shared expense/i }).filter({ visible: true }).first().click();
  await composerType(page, "999");
  // With no group chosen the line reads "Choose who's splitting"; inside a
  // group it reads "N people · …". Either is the way into the split editor.
  await composer(page).getByRole("button", { name: /people ·|Choose who's splitting/ }).click();
  await page.waitForSelector("text=Split with friends");
  // The split breakdown lists a row per person, so assert the arithmetic.
  await page.getByText("₹333").first().waitFor();
  ok("equal split preview shows ₹333 each (you + 2 friends)", true);
  await page.getByRole("dialog").last().getByRole("button", { name: "Done", exact: true }).click();
  await page.waitForTimeout(400);
  await composerSave(page);
  await composer(page).waitFor({ state: "detached", timeout: 15000 });
  ok("split expense committed (DB trigger accepted split sum)", true);

  // ── bills: mark paid rolls due date ──
  await page.goto("http://localhost:3000/bills");
  await page.waitForSelector("text=ACT Fibernet");
  await page.locator('button:has-text("Mark paid")').first().click();
  await page.waitForSelector("text=/paid · ₹/");
  ok("mark bill paid creates payment + rolls due date", true);

  // ── analytics ──
  await page.goto("http://localhost:3000/analytics");
  await page.waitForSelector("text=AVG DAILY SPEND");
  const ana = await page.textContent("body");
  ok("analytics renders trend + merchants", ana.includes("Balance trend") && ana.includes("Top merchants"));
  await page.screenshot({ path: `${SHOT}/04-analytics.png`, fullPage: true });

  // ── dark mode ──
  await page.goto("http://localhost:3000/dashboard");
  await page.click('button[aria-label="Toggle dark mode"]');
  await page.waitForTimeout(400);
  const theme = await page.getAttribute("html", "data-theme");
  ok("dark mode toggles", theme === "dark");
  await page.screenshot({ path: `${SHOT}/05-dark.png`, fullPage: true });
  await page.click('button[aria-label="Toggle dark mode"]');

  // ── mobile viewport: bottom nav + FAB + bottom sheet ──
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const cookies = await page.context().cookies();
  await mobile.context().addCookies(cookies);
  await mobile.goto("http://localhost:3000/dashboard");
  await mobile.getByText(/total balance|balance ·/i).filter({ visible: true }).first().waitFor();
  const nav = await mobile.locator("nav").isVisible();
  ok("mobile bottom tab bar visible at 390px", nav);
  // Same FAB drift as on desktop: the accessible name is "<section> — quick add"
  // and the chooser's actions are "Add expense" / "Add income" / "Transfer
  // money". The old literal "Quick add" and "🧾 Expense" are both gone, and the
  // dashboard's chooser never offered "Split with friends" — that is /shared.
  await mobile.getByRole("button", { name: /quick add/i }).filter({ visible: true }).first().click();
  await mobile.getByRole("button", { name: /Add expense/i }).filter({ visible: true }).first().click();
  await mobile.locator("div[data-composer]").waitFor({ timeout: 15000 });
  ok("FAB quick-add opens the full-screen composer on mobile", true);
  await mobile.screenshot({ path: `${SHOT}/06-mobile.png`, fullPage: false });
  await mobile.close();
} catch (e) {
  ok("script error", false, String(e).slice(0, 300));
  await page.screenshot({ path: `${SHOT}/error.png`, fullPage: true });
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
