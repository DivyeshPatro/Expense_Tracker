// Group Settlement plan + WhatsApp share, verified against the exact seven
// expenses that exposed the original balance bug.
//
// Checks the three things that matter and can only be seen in a real browser:
//   • the plan on screen is group-wide (real names, member→member arrows kept)
//   • the shared text is character-for-character the rows on screen
//   • it renders without overflow at 360/390/430/1440

import { randomUUID } from "node:crypto";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const S = randomUUID().slice(0, 6);
const SHOT = path.join(process.cwd(), "e2e-output");
const GROUP = `ZSettle-${S}`;

const results: { name: string; pass: boolean; note?: string }[] = [];
function ok(name: string, pass: boolean, note?: string) {
  results.push({ name, pass, note });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${note ? ` · ${note}` : ""}`);
}

async function signIn(page: Page) {
  await page.goto(`${BASE}/sign-in`, { waitUntil: "load" });
  await page.fill('input[type="email"]', "arjun@ledgerly.app");
  await page.fill('input[type="password"]', "ledgerly-demo");
  await page.waitForFunction(() => {
    const b = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    return !!b && !b.disabled;
  }, undefined, { timeout: 60000 });
  await page.click('button[type="submit"]');
  for (let i = 0; i < 80 && !page.url().includes("/dashboard"); i++) await page.waitForTimeout(500);
  if (!page.url().includes("/dashboard")) throw new Error("sign-in failed: " + (await page.locator("body").innerText()).slice(0, 140));
}

const rupees = (n: number) => Math.round(n * 100);

async function main() {
  const user = await prisma.user.findFirstOrThrow({ where: { email: "arjun@ledgerly.app" } });
  const account = await prisma.account.findFirstOrThrow({ where: { userId: user.id } });
  const category = await prisma.category.findFirstOrThrow({ where: { userId: user.id, kind: "EXPENSE" } });

  // Four members + the owner, exactly the Splitwise shape.
  const names = ["ZSri", "ZBal", "ZNit", "ZAvh"].map((n) => `${n}-${S}`);
  const pids: string[] = [];
  for (const displayName of names) {
    pids.push((await prisma.participant.create({ data: { ownerId: user.id, displayName } })).id);
  }
  const group = await prisma.group.create({
    data: { name: GROUP, createdById: user.id, members: { create: pids.map((participantId) => ({ participantId })) } },
  });

  const mkTx = async (merchant: string, total: number, paidBy: string | null, shares: [string | null, number][]) =>
    prisma.transaction.create({
      data: {
        userId: user.id, type: "EXPENSE", amount: rupees(total), accountId: account.id, categoryId: category.id,
        merchant, occurredAt: new Date(), groupId: group.id, paidByParticipantId: paidBy,
        splits: { create: shares.map(([participantId, owed]) => ({ participantId, owedAmount: rupees(owed) })) },
      },
    });

  const equal5 = (amt: number): [string | null, number][] => {
    const each = amt / 5;
    return [[null, each], ...pids.map((p) => [p, each] as [string, number])];
  };
  // Six owner-paid rows, plus the ₹1,240 one a MEMBER paid — the row the old
  // engine got wrong, and the only one that can produce a member→member hop.
  await mkTx(`ZBus-${S}`, 5400, null, equal5(5400));
  await mkTx(`ZUber-${S}`, 315, null, equal5(315));
  await mkTx(`ZTiffin-${S}`, 390, null, equal5(390));
  await mkTx(`ZCabHyd-${S}`, 4000, null, equal5(4000));
  await mkTx(`ZPetrol-${S}`, 1240, pids[0], equal5(1240));
  await mkTx(`ZDinner-${S}`, 1280, null, equal5(1280));
  await mkTx(`ZLunch-${S}`, 2530, null, [[null, 422], [pids[0], 842], [pids[1], 422], [pids[2], 422], [pids[3], 422]]);

  const browser = await chromium.launch({ headless: true });
  // localhost IS a secure context, so navigator.clipboard works once granted —
  // that is how the share text gets read back and compared.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  try {
    await signIn(page);
    await page.goto(`${BASE}/shared/groups/${group.id}?p=all`, { waitUntil: "load" });
    await page.waitForSelector("text=Group Settlement", { timeout: 30000 });

    const card = page.locator("section", { hasText: "Group Settlement" }).first();
    const cardText = await card.innerText();

    ok("1. the plan leads the section", cardText.includes("Group Settlement"));
    ok("2. it counts the payments in plain language", /\d+ payments? to settle everything/.test(cardText), cardText.match(/\d+ payments? to settle everything/)?.[0]);

    // Rows as displayed. Target the row container class directly — filtering
    // every <div> by "→" also matches the wrappers around them, which inflates
    // the count.
    const rowTexts = await card.locator("div.bg-side").allInnerTexts();
    const displayed = rowTexts.map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => /→/.test(t) && /₹/.test(t));
    ok("3. every row reads Person → Person ₹Amount", displayed.length > 0 && displayed.every((t) => /→/.test(t) && /₹/.test(t)), `${displayed.length} rows`);

    // The core requirement: no row addresses the reader as "You".
    ok("4. the plan is group-wide — the owner is named, never 'You'",
      !/(^|\s)You\s*→/.test(cardText) && !/→\s*You(\s|$)/.test(cardText));
    ok("5. the owner appears by their real account name", cardText.includes(user.name), user.name);

    ok("6. it totals what has to move", cardText.includes("Total to settle"));

    // ── SHARE ────────────────────────────────────────────────────────────
    await page.getByRole("button", { name: "Share settlement" }).click();
    await page.waitForTimeout(800);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    console.log("\n----- shared text -----\n" + clip + "\n-----------------------\n");

    ok("7. the share text names the group", clip.startsWith(`🧾 ${GROUP} — Settlement`));
    ok("8. it repeats the same payment count", clip.includes((cardText.match(/\d+ payments? to settle everything/) ?? [""])[0]));
    ok("9. it leaks no ids and no 'You'", !/\bYou\b/.test(clip) && !clip.includes(group.id) && !pids.some((p) => clip.includes(p)));

    // Every displayed row must appear in the message, same names, same amount.
    const shareLines = clip.split("\n").filter((l) => l.includes("→"));
    const norm = (s: string) => s.replace(/\s+/g, " ").replace(/\s*→\s*/, " → ").trim();
    // The "you" chip renders immediately after the viewer's own name, so
    // innerText yields "Arjunyou" — strip it from whichever side carries it.
    const party = (s: string) => s.trim().replace(/you$/, "").trim();
    const displayedPairs = displayed.map((t) => {
      const m = t.match(/(.+?)→(.+?)(₹[\d,.]+)/s);
      return m ? norm(`${party(m[1])} → ${party(m[2])}: ${m[3]}`) : t;
    });
    const shareNorm = shareLines.map(norm);
    const missing = displayedPairs.filter((d) => !shareNorm.includes(d));
    ok("10. the shared text matches the rows on screen exactly", missing.length === 0 && shareLines.length === displayed.length,
      `${displayed.length} on screen, ${shareLines.length} shared${missing.length ? `; missing ${JSON.stringify(missing)}` : ""}`);

    const totalOnScreen = (cardText.match(/Total to settle\s*(₹[\d,.]+)/) ?? [])[1];
    ok("11. the shared total matches the displayed total", !!totalOnScreen && clip.includes(`Total: ${totalOnScreen}`), totalOnScreen);

    await page.screenshot({ path: path.join(SHOT, "settle-390-plan.png"), fullPage: true });

    // ── DETAILED still available ─────────────────────────────────────────
    await page.getByRole("tab", { name: "Detailed" }).click();
    await page.waitForTimeout(600);
    const det = await card.innerText();
    ok("12. the detailed obligations remain available as the 'why'", /Every obligation separately/i.test(det));
    const detRows = (det.match(/→/g) ?? []).length;
    const planRows = (cardText.match(/→/g) ?? []).length;
    ok("13. the plan is no longer than the detailed list", planRows <= detRows, `${detRows} detailed → ${planRows} plan`);

    // ── WIDTHS ───────────────────────────────────────────────────────────
    for (const w of [360, 390, 430, 1440]) {
      await page.setViewportSize({ width: w, height: w >= 1440 ? 900 : 844 });
      await page.goto(`${BASE}/shared/groups/${group.id}?p=all`, { waitUntil: "load" });
      await page.waitForSelector("text=Group Settlement", { timeout: 30000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      const shareVisible = await page.getByRole("button", { name: "Share settlement" }).isVisible();
      ok(`14. ${w}px: plan renders without overflow and Share stays reachable`, !overflow && shareVisible, `overflow=${overflow} share=${shareVisible}`);
      if (w === 1440 || w === 390) await page.screenshot({ path: path.join(SHOT, `settle-${w}-plan.png`), fullPage: true });
    }
  } finally {
    await browser.close();
    const txs = await prisma.transaction.findMany({ where: { groupId: group.id }, select: { id: true } });
    await prisma.expenseSplit.deleteMany({ where: { txId: { in: txs.map((t) => t.id) } } });
    await prisma.transaction.deleteMany({ where: { groupId: group.id } });
    await prisma.settlement.deleteMany({ where: { groupId: group.id } });
    await prisma.groupMember.deleteMany({ where: { groupId: group.id } });
    await prisma.group.delete({ where: { id: group.id } });
    await prisma.participant.deleteMany({ where: { id: { in: pids } } });
    await prisma.$disconnect();
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    for (const f of failed) console.log(`  ✗ ${f.name}`);
    if (failed.length) process.exitCode = 1;
  }
}

main();
