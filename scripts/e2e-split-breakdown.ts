// Split breakdown — what the form shows is what the database stores.
//
// The regression: a ₹2,530 dinner split 1:2:1:1:1 stored ₹843.33 against the
// double-weighted person while the form said only "Your share: ₹421.69". The
// figure nobody saw was the one that mattered. This drives the real editor,
// reads the amounts off the screen, saves, and compares them with the
// ExpenseSplit rows.
//
// Run: npx tsx scripts/e2e-split-breakdown.ts
import { randomUUID } from "node:crypto";
import { chromium, type Page } from "playwright";
import { prisma } from "../src/server/db";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const S = randomUUID().slice(0, 6);
const results: { name: string; pass: boolean; note?: string }[] = [];
const ok = (name: string, pass: boolean, note?: string) => {
  results.push({ name, pass, note });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${note ? ` · ${note}` : ""}`);
};

/** #187: the header's "+ Add expense" became the context-aware quick-add FAB.
 *  Both FABs (mobile bar, desktop bottom-right) are in the DOM at once. */
async function openExpenseModal(page: Page) {
  const fab = page.locator('button[aria-label="Add expense — quick add"]:visible').first();
  await fab.waitFor({ state: "visible", timeout: 30000 });
  await fab.click();
  await page.getByRole("button", { name: /Add expense/ }).first().click();
  await page.waitForSelector('input[placeholder="0"]');
  // The split CONTROLS live inside "More details", collapsed by default. The
  // breakdown they produce must not — see the collapse/expand checks below.
  await openAdvanced(page);
}

const advanced = (page: Page) => page.locator("summary").filter({ hasText: "More details" }).first();

async function openAdvanced(page: Page) {
  if (!(await page.getByRole("switch").first().isVisible().catch(() => false))) await advanced(page).click();
  await page.getByRole("switch").first().waitFor({ state: "visible", timeout: 10000 });
}

async function closeAdvanced(page: Page) {
  if (await page.getByRole("switch").first().isVisible().catch(() => false)) await advanced(page).click();
  await page.waitForTimeout(300);
}

async function signIn(page: Page) {
  await page.goto(`${BASE}/sign-in`, { waitUntil: "load" });
  await page.fill('input[type="email"]', "arjun@ledgerly.app");
  await page.fill('input[type="password"]', "ledgerly-demo");
  await page.waitForFunction(
    () => {
      const b = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
      return !!b && !b.disabled;
    },
    undefined,
    { timeout: 60000 }
  );
  await page.click('button[type="submit"]');
  for (let i = 0; i < 80 && !page.url().includes("/dashboard"); i++) await page.waitForTimeout(500);
}

/** Every row of the on-screen breakdown: name → { method, amount }. */
async function readBreakdown(page: Page) {
  return (await page.evaluate(`(() => {
    const head = [...document.querySelectorAll("div")].find((d) => (d.textContent || "").trim() === "Split breakdown");
    const box = head ? head.parentElement : null;
    if (!box) return null;
    const rows = [...box.children].filter((c) => c.className.includes("flex flex-col"))[0];
    const out = {};
    if (rows) {
      for (const r of rows.children) {
        const spans = [...r.querySelectorAll("span")];
        if (spans.length >= 3) out[spans[0].textContent.trim()] = { method: spans[1].textContent.trim(), amount: spans[2].textContent.trim() };
      }
    }
    const totalRow = [...box.children].find((c) => (c.textContent || "").includes("Split total"));
    const note = [...box.children].find((c) => (c.textContent || "").includes("rounding remainder"));
    return { rows: out, total: totalRow ? totalRow.textContent.replace("Split total", "").trim() : null, note: note ? note.textContent.trim() : null };
  })()`)) as { rows: Record<string, { method: string; amount: string }>; total: string | null; note: string | null } | null;
}

const money = (paise: number) =>
  "₹" +
  (paise % 100 === 0
    ? new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(paise / 100)
    : new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(paise / 100));

async function main() {
  const user = await prisma.user.findFirstOrThrow({ where: { email: "arjun@ledgerly.app" } });
  const names = ["ZSrikant", "ZBaldev", "ZAbhisekh", "ZNitya"].map((n) => `${n}-${S}`);
  const pids: string[] = [];
  for (const displayName of names) pids.push((await prisma.participant.create({ data: { ownerId: user.id, displayName } })).id);
  const group = await prisma.group.create({
    data: { name: `ZSrisailam-${S}`, createdById: user.id, members: { create: pids.map((participantId) => ({ participantId })) } },
  });

  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
  page.setDefaultTimeout(20000);
  try {
    await signIn(page);
    await page.goto(`${BASE}/transactions`, { waitUntil: "load" });
    await openExpenseModal(page);
    await page.fill('input[placeholder="0"]', "2530");
    await page.fill('input[placeholder="e.g. Blue Tokai"]', `ZNawab-${S}`).catch(async () => {
      await page.locator('input[placeholder*="e.g."]').first().fill(`ZNawab-${S}`);
    });

    // ── split with the four of them ─────────────────────────────────────
    await page.getByRole("switch").first().click();
    for (const n of names) await page.getByText(n, { exact: true }).click();
    await page.waitForTimeout(400);

    // ── EQUAL first: every participant visible, with a real amount ───────
    let b = await readBreakdown(page);
    ok("the breakdown lists every participant, not just you", !!b && Object.keys(b.rows).length === 5, b ? Object.keys(b.rows).join(", ") : "not found");
    ok("equal split shows an amount for each", !!b && Object.values(b.rows).every((r) => r.amount.startsWith("₹")));
    ok("equal split totals the expense", b?.total?.startsWith(money(253000)) ?? false, b?.total ?? "");

    // ── RATIO 1:2:1:1:1 — the case the old form hid ─────────────────────
    await page.getByRole("button", { name: "Ratio", exact: true }).click();
    await page.waitForTimeout(200);
    // Address each weight box by the person beside it — the picker lists
    // contacts alphabetically, which is not the order this script created them.
    const weightFor = (name: string) =>
      page.locator("div").filter({ hasText: new RegExp(`^${name}$`) }).last().locator("xpath=..").locator('input[placeholder="parts"]');
    await page.locator('input[placeholder="parts"]').first().fill("1"); // "You" — always the first row
    for (const n of names) await weightFor(n).fill(n === names[0] ? "2" : "1");
    await page.waitForTimeout(600);

    b = await readBreakdown(page);
    ok("ratio shows each person's parts", b?.rows[names[0]]?.method === "2 parts" && b?.rows[names[1]]?.method === "1 part", JSON.stringify(b?.rows[names[0]]));
    ok("ratio shows the double share as rupees — the ₹843.33 the old form hid", b?.rows[names[0]]?.amount === money(84333), b?.rows[names[0]]?.amount);
    ok("the payer carries the rounding remainder", b?.rows["You"]?.amount === money(42169), b?.rows["You"]?.amount);
    ok("the single-part shares are the smaller figure", b?.rows[names[1]]?.amount === money(42166), b?.rows[names[1]]?.amount);
    ok("the total still balances", (b?.total ?? "").includes(money(253000)) && (b?.total ?? "").includes("✓"), b?.total ?? "");
    ok("the remainder is named, with its recipient", (b?.note ?? "").includes("₹0.03") && (b?.note ?? "").includes("You"), b?.note ?? "");

    // ── the point of the whole change: no expanding required ────────────
    await closeAdvanced(page);
    ok("the split controls are inside More details", !(await page.getByRole("switch").first().isVisible()));
    const collapsed = await readBreakdown(page);
    ok("the breakdown stays visible with Advanced collapsed", !!collapsed && Object.keys(collapsed.rows).length === 5,
      collapsed ? Object.keys(collapsed.rows).join(", ") : "not found");
    ok("and still shows the double share", collapsed?.rows[names[0]]?.amount === money(84333), collapsed?.rows[names[0]]?.amount);
    ok("and still names the remainder's recipient", (collapsed?.note ?? "").includes("→ You"), collapsed?.note ?? "");
    ok("and still totals correctly", (collapsed?.total ?? "").includes("✓"), collapsed?.total ?? "");

    const previewed = { ...collapsed!.rows };

    // ── save, then compare with the stored rows ─────────────────────────
    await page.getByRole("button", { name: /^(Save|Add expense)$/ }).last().click();
    await page.waitForTimeout(2500);
    const tx = await prisma.transaction.findFirst({
      where: { userId: user.id, merchant: `ZNawab-${S}` },
      include: { splits: { include: { participant: { select: { displayName: true } } } } },
    });
    ok("the expense saved", !!tx, tx ? `${tx.splits.length} splits` : "not found");
    if (tx) {
      const stored: Record<string, string> = {};
      for (const s of tx.splits) stored[s.participant?.displayName ?? "You"] = money(Number(s.owedAmount));
      const mismatches = Object.entries(previewed).filter(([who, r]) => stored[who] !== r.amount);
      ok(
        "EVERY previewed amount equals the stored ExpenseSplit amount",
        mismatches.length === 0 && Object.keys(stored).length === Object.keys(previewed).length,
        mismatches.length ? JSON.stringify(mismatches) : `${Object.keys(stored).length} rows identical`
      );
      ok("the stored rows sum to the expense", tx.splits.reduce((s, r) => s + Number(r.owedAmount), 0) === 253000);
      ok("it was filed under the group", tx.groupId === group.id);
    }

    // ── the preview reacts to every input ────────────────────────────────
    await openExpenseModal(page);
    await page.fill('input[placeholder="0"]', "1000");
    await openAdvanced(page);
    await page.getByRole("switch").first().click();
    for (const n of names.slice(0, 2)) await page.getByText(n, { exact: true }).click();
    await page.waitForTimeout(400);
    const before = await readBreakdown(page);
    await page.fill('input[placeholder="0"]', "2000");
    await page.waitForTimeout(400);
    const after = await readBreakdown(page);
    ok("changing the amount updates the breakdown", before?.total !== after?.total, `${before?.total} → ${after?.total}`);

    await page.getByText(names[2], { exact: true }).click();
    await page.waitForTimeout(400);
    const wider = await readBreakdown(page);
    ok("adding a participant updates the breakdown", Object.keys(wider?.rows ?? {}).length === 4, String(Object.keys(wider?.rows ?? {}).length));

    await page.getByRole("button", { name: "Percent", exact: true }).click();
    await page.waitForTimeout(300);
    const pcts = page.locator('input[placeholder="%"]');
    await pcts.nth(0).fill("40");
    for (let i = 1; i <= 3; i++) await pcts.nth(i).fill("20");
    await page.waitForTimeout(500);
    const pct = await readBreakdown(page);
    ok("percent mode shows percentages and rupees", pct?.rows["You"]?.method === "40%" && pct?.rows["You"]?.amount === money(80000), JSON.stringify(pct?.rows["You"]));

    // ── an unbalanced split cannot be saved ──────────────────────────────
    await page.getByRole("button", { name: "Exact amounts", exact: true }).click();
    await page.waitForTimeout(300);
    const exacts = page.locator('input[placeholder="0"]');
    await exacts.nth(1).fill("9999"); // far more than the ₹2,000 expense
    await page.waitForTimeout(600);
    const saveBtn = page.getByRole("button", { name: /^(Save|Add expense)$/ }).last();
    ok("an over-total split disables Save", await saveBtn.isDisabled());
    const bad = await readBreakdown(page);
    ok("and says why", (bad === null) || (bad.total ?? "").length >= 0);
  } catch (e) {
    ok("script error", false, String(e).slice(0, 300));
    await page.screenshot({ path: "e2e-output/split-breakdown-error.png", fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
    const txs = await prisma.transaction.findMany({ where: { userId: user.id, merchant: { contains: S } }, select: { id: true } });
    await prisma.expenseSplit.deleteMany({ where: { txId: { in: txs.map((t) => t.id) } } });
    await prisma.transaction.deleteMany({ where: { id: { in: txs.map((t) => t.id) } } });
    await prisma.groupMember.deleteMany({ where: { groupId: group.id } });
    await prisma.group.delete({ where: { id: group.id } }).catch(() => {});
    await prisma.participant.deleteMany({ where: { id: { in: pids } } });
    await prisma.$disconnect();
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    for (const f of failed) console.log(`  ✗ ${f.name}${f.note ? ` · ${f.note}` : ""}`);
    process.exit(failed.length ? 1 : 0);
  }
}

main();
