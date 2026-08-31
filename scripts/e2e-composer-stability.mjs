// Does the entry screen settle, or does it flicker on the way in?
//
// The composer derives a lot at mount — group categories arrive from a server
// action, the split roster comes from a prefill, the inference may move the
// group — and each of those can repaint. A screen that visibly rewrites itself
// in the first half-second reads as broken even when every final value is
// right, and it is the kind of thing no locator-based suite notices.
//
// Measured two ways: layout shift (the browser's own CLS entries) and the
// literal text of the screen sampled repeatedly, so a value that appears and
// then changes shows up as a transition rather than a still frame.
//
// Run: node scripts/db-local.mjs --shell "node scripts/e2e-composer-stability.mjs"
import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? ` · ${detail}` : ""}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.setDefaultTimeout(30000);

/** Start recording layout shifts that happen from now on. */
async function startCls() {
  await page.evaluate(() => {
    window.__cls = 0;
    window.__clsObs?.disconnect();
    window.__clsObs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        // Shifts within 500ms of a real interaction are expected — the reader
        // caused them. Everything else is the page rewriting itself.
        if (!e.hadRecentInput) window.__cls += e.value;
      }
    });
    window.__clsObs.observe({ type: "layout-shift", buffered: false });
  });
}
const readCls = () => page.evaluate(() => Math.round((window.__cls ?? 0) * 1000) / 1000);

/**
 * Sample the screen's text every 60ms for a second and report how many
 * DISTINCT states it passed through. One is a screen that arrived; several is
 * one that argued with itself on the way.
 */
async function settleStates(selector) {
  const seen = [];
  for (let i = 0; i < 16; i++) {
    const t = await page
      .locator(selector)
      .innerText()
      .catch(() => "");
    const norm = t.replace(/\s+/g, " ").trim();
    if (norm && norm !== seen[seen.length - 1]) seen.push(norm);
    await page.waitForTimeout(60);
  }
  return seen;
}

try {
  await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button[type="submit"]');
  await page.waitForTimeout(1200);
  await page.fill('input[type="email"]', "arjun@ledgerly.app");
  await page.fill('input[type="password"]', "ledgerly-demo");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 30000 });
  await page.waitForTimeout(1500);

  const composer = () => page.locator("div[data-composer]");
  const sheet = () => page.getByRole("dialog").last();
  const openQuickAdd = async (action) => {
    await page.getByRole("button", { name: /quick add/i }).filter({ visible: true }).first().click();
    await page.waitForTimeout(500);
    await sheet().getByRole("button", { name: action }).first().click();
  };

  // ── a plain Debit: nothing is fetched, so it must arrive in one state ────
  await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
  await page.waitForTimeout(800);
  await startCls();
  await openQuickAdd(/Add expense/i);
  await composer().waitFor();
  const plain = await settleStates("div[data-composer]");
  ok("a plain Debit screen arrives in one state", plain.length === 1, `${plain.length} states`);
  ok("and shifts nothing after it does", (await readCls()) < 0.1, `cls=${await readCls()}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);

  // ── the group case: categories are fetched, the inference may move the
  //    group, and the split roster comes from the prefill ─────────────────
  await page.goto(`${BASE}/shared`, { waitUntil: "load" });
  await page.waitForTimeout(800);
  await startCls();
  await page.getByRole("button", { name: /Add shared expense/i }).filter({ visible: true }).first().click();
  await composer().waitFor();
  const shared = await settleStates("div[data-composer]");
  // Up to two: the group's category list arrives from a server action, which
  // can legitimately change the Category chip once. More than that means the
  // screen is deciding in public.
  ok("a group entry settles within one visible correction", shared.length <= 2, `${shared.length} states: ${shared.map((s) => s.slice(0, 42)).join(" | ")}`);
  ok("and shifts nothing while it does", (await readCls()) < 0.1, `cls=${await readCls()}`);

  // The final state is the one that has to be right, whatever it passed through.
  const finalText = await composer().innerText();
  ok("it ends on the group, not on Personal", /Flat|Trip|Group/.test(finalText) && !/^Personal$/m.test(finalText.split("\n")[1] ?? ""), finalText.split("\n").slice(0, 4).join(" / "));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);

  // ── Lending ─────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/lending`, { waitUntil: "load" });
  await page.waitForTimeout(800);
  await startCls();
  await page.getByRole("button", { name: /Lending — quick add/ }).filter({ visible: true }).first().click();
  await page.waitForTimeout(500);
  await sheet().getByRole("button", { name: /You got money/ }).first().click();
  await page.locator("div[data-lending]").waitFor();
  const lending = await settleStates("div[data-lending]");
  // A repayment loads its outstanding loans to allocate against, so the
  // Allocation chip can legitimately change once.
  ok("a repayment screen settles within one visible correction", lending.length <= 2, `${lending.length} states`);
  ok("and shifts nothing while it does", (await readCls()) < 0.1, `cls=${await readCls()}`);

  // ── typing must not move the screen ─────────────────────────────────────
  await startCls();
  for (const ch of "12345") {
    await page.locator("div[data-lending]").getByRole("button", { name: ch, exact: true }).click();
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(400);
  ok("the amount growing does not move anything around it", (await readCls()) < 0.05, `cls=${await readCls()}`);
} catch (e) {
  ok("script error", false, String(e).slice(0, 300));
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
