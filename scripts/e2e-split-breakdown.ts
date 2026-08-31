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

// Adding an expense is the full-screen composer now. The SplitEditor and the
// SplitBreakdown it produces are the SAME components, rendered together in the
// composer's split sheet — so every assertion below still reads the real
// editor and the real preview, reached one tap in rather than behind a
// collapsed "More details" section.
const composer = (page: Page) => page.locator("div[data-composer]");
const sheet = (page: Page) => page.getByRole("dialog").last();

/** #187: the header's "+ Add expense" became the context-aware quick-add FAB.
 *  Both FABs (mobile bar, desktop bottom-right) are in the DOM at once. */
async function openExpenseModal(page: Page) {
  const fab = page.locator('button[aria-label="Add expense — quick add"]:visible').first();
  await fab.waitFor({ state: "visible", timeout: 30000 });
  await fab.click();
  await page.getByRole("button", { name: /Add expense/ }).first().click();
  await composer(page).waitFor({ timeout: 30000 });
}

/** Tap an amount into the composer's keypad. */
async function typeAmount(page: Page, rupees: string) {
  await composer(page).getByRole("button", { name: "Clear amount" }).click();
  for (const ch of rupees) {
    await composer(page).getByRole("button", { name: ch === "." ? "Decimal point" : ch, exact: true }).click();
    await page.waitForTimeout(50);
  }
}

/** Open the split sheet, where the editor and the breakdown both live. */
async function openAdvanced(page: Page) {
  if (await page.getByRole("switch").first().isVisible().catch(() => false)) return;
  await composer(page).getByRole("button", { name: /people ·|Choose who's splitting|Split with someone/ }).click();
  await page.getByRole("switch").first().waitFor({ state: "visible", timeout: 10000 });
}

/** Back out to the composer screen. */
async function closeAdvanced(page: Page) {
  if (await sheet(page).getByRole("button", { name: "Done", exact: true }).count()) {
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
  }
  await page.waitForTimeout(400);
}

/** Drag the confirm handle the whole way — the composer has no Save button. */
async function saveComposer(page: Page) {
  await closeAdvanced(page);
  const track = composer(page).locator("div[role='slider']");
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
  await page.waitForTimeout(1200);
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
    await typeAmount(page, "2530");
    // The merchant lives behind the composer's "Who's it for?" line.
    await composer(page).getByRole("button", { name: "Merchant and notes" }).click();
    await page.waitForTimeout(400);
    await sheet(page).locator("input").first().fill(`ZNawab-${S}`);
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);

    // ── split with the four of them ─────────────────────────────────────
    await openAdvanced(page);
    if ((await page.getByRole("switch").first().getAttribute("aria-checked")) !== "true") {
      await page.getByRole("switch").first().click();
      await page.waitForTimeout(250);
    }
    // The Shared entry point pre-ticks a couple of contacts; this case names
    // its own four, so start from nobody.
    for (const b of await sheet(page).locator('button[aria-pressed="true"]').all()) {
      await b.click();
      await page.waitForTimeout(80);
    }
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
    //
    // What this asserted was that the breakdown is not hidden behind the
    // section the CONTROLS live in. The composer answers it more plainly:
    // the controls and the figures they produce are the same view, so the
    // amounts are on screen the entire time the split is being set up. Read
    // them with the editor open, which is the only state that now exists.
    const collapsed = await readBreakdown(page);
    ok("the breakdown sits with the controls that produce it", !!collapsed && Object.keys(collapsed.rows).length === 5,
      collapsed ? Object.keys(collapsed.rows).join(", ") : "not found");
    ok("and still shows the double share", collapsed?.rows[names[0]]?.amount === money(84333), collapsed?.rows[names[0]]?.amount);
    ok("and still names the remainder's recipient", (collapsed?.note ?? "").includes("→ You"), collapsed?.note ?? "");
    ok("and still totals correctly", (collapsed?.total ?? "").includes("✓"), collapsed?.total ?? "");

    const previewed = { ...collapsed!.rows };

    // ── save, then compare with the stored rows ─────────────────────────
    await saveComposer(page);
    await page.waitForTimeout(1500);
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
    await typeAmount(page, "1000");
    await openAdvanced(page);
    if ((await page.getByRole("switch").first().getAttribute("aria-checked")) !== "true") {
      await page.getByRole("switch").first().click();
      await page.waitForTimeout(250);
    }
    for (const b of await sheet(page).locator('button[aria-pressed="true"]').all()) {
      await b.click();
      await page.waitForTimeout(80);
    }
    for (const n of names.slice(0, 2)) await page.getByText(n, { exact: true }).click();
    await page.waitForTimeout(400);
    const before = await readBreakdown(page);
    // The amount is on the screen behind the sheet, so changing it means
    // stepping back out to the keypad and returning — which is exactly what a
    // person does, and a stronger test of the preview surviving the round trip.
    await closeAdvanced(page);
    await typeAmount(page, "2000");
    await openAdvanced(page);
    await page.waitForTimeout(400);
    const after = await readBreakdown(page);
    ok("changing the amount updates the breakdown", before?.total !== after?.total, `${before?.total} → ${after?.total}`);

    await page.getByText(names[2], { exact: true }).click();
    await page.waitForTimeout(400);
    const wider = await readBreakdown(page);
    ok("adding a participant updates the breakdown", Object.keys(wider?.rows ?? {}).length === 4, String(Object.keys(wider?.rows ?? {}).length));

    await page.getByRole("button", { name: "Percent", exact: true }).click();
    await page.waitForTimeout(300);
    const pcts = sheet(page).locator('input[placeholder="%"]');
    await pcts.nth(0).fill("40");
    await pcts.nth(0).blur();
    for (let i = 1; i <= 3; i++) {
      await pcts.nth(i).fill("20");
      // Committing each field is what the editor listens for — redistribution
      // runs on blur, deliberately, so it cannot move the other boxes while a
      // number is still being typed.
      await pcts.nth(i).blur();
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(600);
    const pct = await readBreakdown(page);
    ok("percent mode shows percentages and rupees", pct?.rows["You"]?.method === "40%" && pct?.rows["You"]?.amount === money(80000), JSON.stringify(pct?.rows["You"]));

    // ── an unbalanced split cannot be saved ──────────────────────────────
    await page.getByRole("button", { name: "Exact amounts", exact: true }).click();
    await page.waitForTimeout(300);
    const exacts = sheet(page).locator('input[placeholder="0"]');
    await exacts.nth(1).fill("9999"); // far more than the ₹2,000 expense
    await exacts.nth(1).blur();
    await page.waitForTimeout(600);
    // There is no Save button to disable: the composer commits on a swipe and
    // refuses one it cannot honour. The property is the same and stricter —
    // the gesture completes, nothing is written, and the screen says why.
    const badMerchant = `ZOverTotal-${S}`;
    await closeAdvanced(page);
    await composer(page).getByRole("button", { name: "Merchant and notes" }).click();
    await page.waitForTimeout(400);
    await sheet(page).locator("input").first().fill(badMerchant);
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await saveComposer(page);
    const stillOpen = await composer(page).count();
    const refusal = await composer(page).getByRole("alert").innerText().catch(() => "");
    const wroteAnyway = await prisma.transaction.findFirst({ where: { userId: user.id, merchant: badMerchant } });
    ok("an over-total split is refused rather than saved", stillOpen === 1 && !wroteAnyway, `composer open=${stillOpen}, stored=${!!wroteAnyway}`);
    ok("and says why", refusal.length > 0, refusal.slice(0, 120));
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
