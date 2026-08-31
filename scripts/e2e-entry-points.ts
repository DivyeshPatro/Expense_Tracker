// Every "add money" button in the app, and what it opens.
//
// The migration's whole claim is that a person never meets two different entry
// experiences for the same thing. That is only true if EVERY button was moved,
// so this drives each one and asserts on what appears: the full-screen composer
// (Spending and Shared), the full-screen Lending screen, or — for the two
// deliberate exceptions — the classic modal that was always right for them.
//
// It also checks the things the migration could quietly have broken: repeat,
// which only ever existed on the classic forms, and the group context the
// Shared buttons carry.

import { chromium, type Browser, type Page } from "playwright";
import { randomUUID } from "node:crypto";
import { auth } from "../src/server/auth";
import { prisma } from "../src/server/db";
import { saveComposer, typeAmount } from "./composer-drive";

const BASE = "http://localhost:3000";
const EMAIL = "arjun@ledgerly.app";
const PASSWORD = "ledgerly-demo";
const R = (p: number | bigint) => (Number(p) / 100).toFixed(2);

const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? ` · ${detail}` : ""}`);
};

async function session(browser: Browser, width = 390) {
  const r = (await auth.api.signInEmail({ body: { email: EMAIL, password: PASSWORD }, returnHeaders: true })) as { headers: Headers };
  const cookies = (r.headers.getSetCookie?.() ?? []).map((sc) => {
    const p = sc.split(";")[0];
    const i = p.indexOf("=");
    return { name: p.slice(0, i), value: p.slice(i + 1), domain: "localhost", path: "/" };
  });
  const ctx = await browser.newContext({ viewport: { width, height: width < 700 ? 844 : 900 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  return { ctx, page };
}

const composer = (page: Page) => page.locator("div[data-composer]");
const lending = (page: Page) => page.locator("div[data-composer][data-lending]");
const sheet = (page: Page) => page.getByRole("dialog").last();

/** The classic modal panel — what must NOT appear for a migrated button. */
const classicPanel = (page: Page) => page.locator(".fixed.inset-0.z-\\[60\\]");
const classicAmountField = (page: Page) => page.locator('input[placeholder="0"]');

async function waitFor<T>(read: () => Promise<T | null>, ms = 20000): Promise<T | null> {
  const until = Date.now() + ms;
  for (;;) {
    const row = await read();
    if (row) return row;
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Open a screen, then report which entry experience actually appeared. */
async function openedWhat(page: Page): Promise<"composer" | "lending" | "classic" | "nothing"> {
  const t = Date.now();
  while (Date.now() - t < 12000) {
    if ((await lending(page).count()) > 0) return "lending";
    if ((await composer(page).count()) > 0) return "composer";
    if ((await classicAmountField(page).count()) > 0) return "classic";
    await page.waitForTimeout(200);
  }
  return "nothing";
}

async function closeAnything(page: Page) {
  for (const name of ["Close", "Cancel"]) {
    const b = page.getByRole("button", { name, exact: true });
    if ((await b.count()) > 0) {
      await b.first().click().catch(() => {});
      await page.waitForTimeout(400);
      return;
    }
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);
}

async function fabAction(page: Page, action: RegExp) {
  await page.getByRole("button", { name: /quick add/i }).filter({ visible: true }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: action }).first().click();
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const tag = randomUUID().slice(0, 6);
  let mob, desk;
  try {
    const user = await prisma.user.findFirstOrThrow({ where: { email: EMAIL } });
    const group = await prisma.group.findFirstOrThrow({ where: { createdById: user.id }, include: { members: { include: { participant: true } } } });
    mob = await session(browser, 390);
    desk = await session(browser, 1280);
    const page = mob.page;
    const dpage = desk.page;

    // ══════════ 1. SPENDING — every entry point opens the composer ══════════
    const spending: { name: string; go: () => Promise<void>; on: Page }[] = [
      { name: "mobile FAB → Add expense", on: page, go: async () => { await page.goto(`${BASE}/dashboard`, { waitUntil: "load" }); await page.waitForSelector("text=Total balance"); await fabAction(page, /Add expense/); } },
      { name: "mobile FAB → Add income", on: page, go: async () => { await page.goto(`${BASE}/dashboard`, { waitUntil: "load" }); await page.waitForSelector("text=Total balance"); await fabAction(page, /Add income/); } },
      { name: "mobile dashboard → Expense quick action", on: page, go: async () => { await page.goto(`${BASE}/dashboard`, { waitUntil: "load" }); await page.waitForSelector("text=Total balance"); await page.getByRole("button", { name: "Expense", exact: true }).first().click(); } },
      { name: "mobile dashboard → Income quick action", on: page, go: async () => { await page.goto(`${BASE}/dashboard`, { waitUntil: "load" }); await page.waitForSelector("text=Total balance"); await page.getByRole("button", { name: "Income", exact: true }).first().click(); } },
      { name: "desktop header → ＋ Add expense", on: dpage, go: async () => { await dpage.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" }); await dpage.waitForTimeout(1200); await dpage.click('button:has-text("＋ Add expense")'); } },
      { name: "accounts FAB → Add expense", on: dpage, go: async () => { await dpage.goto(`${BASE}/accounts`, { waitUntil: "load" }); await dpage.waitForTimeout(1200); await fabAction(dpage, /Add expense/); } },
    ];
    for (const s of spending) {
      await s.go();
      const what = await openedWhat(s.on);
      ok(`1. ${s.name} opens the full-screen composer`, what === "composer", what);
      ok(`1. ${s.name} does NOT open the old modal`, (await classicAmountField(s.on).count()) === 0);
      await closeAnything(s.on);
    }

    // ══════════ 2. SHARED — the composer, already in the group ══════════
    const shared: { name: string; go: () => Promise<void> }[] = [
      { name: "group actions → Add expense", go: async () => { await dpage.goto(`${BASE}/shared/groups/${group.id}?p=all`, { waitUntil: "load" }); await dpage.waitForTimeout(1800); await dpage.getByRole("button", { name: "Add expense", exact: true }).first().click(); } },
      { name: "group expenses card → ＋ Add", go: async () => { await dpage.goto(`${BASE}/shared/groups/${group.id}?p=all`, { waitUntil: "load" }); await dpage.waitForTimeout(1800); await dpage.getByRole("button", { name: "＋ Add", exact: true }).first().click(); } },
    ];
    for (const s of shared) {
      await s.go();
      const what = await openedWhat(dpage);
      ok(`2. ${s.name} opens the composer`, what === "composer", what);
      if (what === "composer") {
        const text = (await composer(dpage).innerText()).replace(/\s+/g, " ");
        ok(`2. ${s.name} lands in the group, not Personal`, text.includes(group.name), text.slice(0, 90));
        ok(`2. ${s.name} arrives with the split set up`, /people ·/.test(text), (text.match(/\d+ people[^·]*·[^🗓]*/) ?? [""])[0].slice(0, 50));
      }
      await closeAnything(dpage);
    }

    // ══════════ 3. LENDING — its own screen, with its own fields ══════════
    const lend: { name: string; go: () => Promise<void> }[] = [
      { name: "mobile FAB → You gave", go: async () => { await page.goto(`${BASE}/lending`, { waitUntil: "load" }); await page.waitForTimeout(1500); await fabAction(page, /You gave money/); } },
      { name: "mobile FAB → You got", go: async () => { await page.goto(`${BASE}/lending`, { waitUntil: "load" }); await page.waitForTimeout(1500); await fabAction(page, /You got money/); } },
      { name: "mobile dashboard → Lend", go: async () => { await page.goto(`${BASE}/dashboard`, { waitUntil: "load" }); await page.waitForSelector("text=Total balance"); await page.getByRole("button", { name: "Lend", exact: true }).first().click(); } },
    ];
    for (const s of lend) {
      await s.go();
      const what = await openedWhat(page);
      ok(`3. ${s.name} opens the full-screen Lending screen`, what === "lending", what);
      ok(`3. ${s.name} does NOT open the old modal`, (await classicAmountField(page).count()) === 0);
      await closeAnything(page);
    }

    // ══════════ 4. TRANSFER — deliberately still the classic form ══════════
    await dpage.goto(`${BASE}/accounts`, { waitUntil: "load" });
    await dpage.waitForTimeout(1200);
    await fabAction(dpage, /Transfer money/);
    const transferWhat = await openedWhat(dpage);
    ok("4. Transfer still opens the existing form, not the composer", transferWhat === "classic", transferWhat);
    ok("4. and it is the transfer form", (await classicPanel(dpage).innerText()).includes("FROM"), (await classicPanel(dpage).innerText()).replace(/\s+/g, " ").slice(0, 60));
    await closeAnything(dpage);

    // ══════════ 5. REPEAT — the capability the classic forms had ══════════
    const rep = `ZRepeat-${tag}`;
    await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    await page.waitForSelector("text=Total balance");
    await fabAction(page, /Add expense/);
    await composer(page).waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    await typeAmount(page, "640");
    ok("5a. a personal expense offers Repeat", (await composer(page).getByRole("button", { name: /^Choose a repeat$|^Repeat:/ }).count()) === 1,
      (await composer(page).innerText()).replace(/\s+/g, " ").slice(0, 120));
    await composer(page).getByRole("button", { name: /^Choose a repeat$|^Repeat:/ }).click();
    await page.waitForTimeout(700);
    await sheet(page).getByRole("checkbox").first().check();
    await page.waitForTimeout(500);
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    ok("5b. arming it shows on the chip", /Repeat: /.test(await composer(page).getByRole("button", { name: /^Repeat:/ }).getAttribute("aria-label") ?? ""),
      (await composer(page).getByRole("button", { name: /^Repeat:/ }).getAttribute("aria-label")) ?? "no repeat chip");
    await composer(page).getByRole("button", { name: "Merchant and notes" }).click();
    await page.waitForTimeout(500);
    await sheet(page).locator("input").first().fill(rep);
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await saveComposer(page);
    const repTx = await waitFor(() => prisma.transaction.findFirst({ where: { userId: user.id, merchant: rep } }));
    ok("5c. the expense itself is saved", repTx !== null && Number(repTx.amount) === 64000, repTx ? R(repTx.amount) : "not saved");
    // The rule keeps the transaction it repeats in `template`, so it is matched
    // on the merchant inside that rather than on a column.
    const rule = await waitFor(async () => {
      const rows = await prisma.recurringRule.findMany({ where: { userId: user.id } });
      return rows.find((r) => (r.template as { merchant?: string } | null)?.merchant === rep) ?? null;
    });
    const tpl = (rule?.template ?? {}) as { merchant?: string; amount?: number | string };
    ok("5d. AND the recurring rule was created, as the classic form did", rule !== null, rule ? `${rule.cadence} every ${rule.interval}` : "no rule");
    ok("5e. the rule repeats the same amount", rule !== null && Number(tpl.amount) === 64000, String(tpl.amount ?? "none"));

    // Repeat must NOT be offered where the classic form withheld it.
    await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    await page.waitForSelector("text=Total balance");
    await fabAction(page, /Add expense/);
    await composer(page).waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    await typeAmount(page, "500");
    await composer(page).getByRole("button", { name: "Group", exact: true }).click();
    await page.waitForTimeout(600);
    await sheet(page).getByRole("button", { name: new RegExp(group.name) }).first().click();
    await page.waitForTimeout(900);
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(600);
    ok("5f. a GROUP expense offers no Repeat — the old form did not either",
      (await composer(page).getByRole("button", { name: /^Choose a repeat$|^Repeat:/ }).count()) === 0);
    await closeAnything(page);
  } catch (e) {
    // Loud, and non-zero. A suite that hides its own failure is worse than one
    // that fails.
    ok("script error", false, e instanceof Error ? e.message.split("\n")[0] : String(e));
  } finally {
    await mob?.ctx.close();
    await desk?.ctx.close();
    await browser.close();
    const passed = results.filter((r) => r.pass).length;
    console.log(`\n${passed}/${results.length} checks passed`);
    for (const r of results.filter((x) => !x.pass)) console.log(`  FAIL — ${r.name} · ${r.detail}`);
    await prisma.$disconnect();
    process.exitCode = passed === results.length ? 0 : 1;
  }
}

main();
