// Group Settlement, seen through three real browser sessions: the owner and
// two linked members.
//
// The integration suite already proves the read model agrees across viewers;
// this proves the RENDERED PAGE does — same plan, same total, same share text,
// with only owner identity and the settle affordance differing.
//
// Run: npx tsx scripts/e2e-group-settlement-collab.ts

import { randomUUID } from "node:crypto";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { auth } from "../src/server/auth";
import { prisma } from "../src/server/db";
import { recordSettlement } from "../src/server/services/shared";

const BASE = "http://localhost:3000";
const SHOT = path.join(process.cwd(), "e2e-output");
const PASSWORD = "LedgerlyTest#2026";
const rup = (n: number) => Math.round(n * 100);

const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? ` · ${detail}` : ""}`);
};

/** signInEmail in-process: three sessions in one run would otherwise trip
 *  Better Auth's per-IP sign-in limiter. */
async function sessionCookies(email: string, password: string) {
  const result = (await auth.api.signInEmail({ body: { email, password }, returnHeaders: true })) as { headers: Headers };
  const setCookie = result.headers.getSetCookie ? result.headers.getSetCookie() : [];
  return setCookie.map((sc) => {
    const pair = sc.split(";")[0];
    const idx = pair.indexOf("=");
    return { name: pair.slice(0, idx), value: pair.slice(idx + 1), domain: "localhost", path: "/" };
  });
}

async function newSession(browser: Browser, email: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await ctx.addCookies(await sessionCookies(email, PASSWORD));
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  return { ctx, page };
}

/** Everything the settlement card says, for one viewer. */
async function readCard(page: Page, groupId: string) {
  await page.goto(`${BASE}/shared/groups/${groupId}?p=all`, { waitUntil: "load" });
  await page.waitForSelector("text=Group Settlement", { timeout: 30000 });
  const card = page.locator("section", { hasText: "Group Settlement" }).first();
  const text = await card.innerText();
  const rawRows = (await card.locator("div.bg-side").allInnerTexts())
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter((t) => /→/.test(t) && /₹/.test(t));
  const rows = rawRows
    // Strip the "you" chip AND the trailing action affordance ("Settle" /
    // "between them"): those legitimately differ per viewer. What must match is
    // the economics — who pays whom, how much.
    .map((t) =>
      t
        .replace(/you(?=\s*(→|₹))/g, "")
        .replace(/\s*(Settle|between them)\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim()
    );
  await page.getByRole("button", { name: "Share settlement" }).click();
  await page.waitForTimeout(700);
  const share = await page.evaluate(() => navigator.clipboard.readText());
  return {
    headline: (text.match(/\d+ payments? to settle everything|All settled up/) ?? [""])[0],
    total: (text.match(/Total to settle\s*(₹[\d,.]+)/) ?? [])[1] ?? "",
    rows,
    rawRows,
    share,
    // exact: Playwright matches accessible names by SUBSTRING by default, so a
    // loose "Settle" also counts "Settle up" and "Share settlement".
    settleButtons: await card.getByRole("button", { name: "Settle", exact: true }).count(),
    pageText: await page.locator("body").innerText(),
  };
}

async function main() {
  const suffix = randomUUID().slice(0, 8);
  const ownerEmail = `gsc-owner-${suffix}@test.local`;
  const anaEmail = `gsc-ana-${suffix}@test.local`;
  const benEmail = `gsc-ben-${suffix}@test.local`;

  await auth.api.signUpEmail({ body: { name: "Olivia Owner", email: ownerEmail, password: PASSWORD } });
  await auth.api.signUpEmail({ body: { name: "Ana Account", email: anaEmail, password: PASSWORD } });
  await auth.api.signUpEmail({ body: { name: "Ben Account", email: benEmail, password: PASSWORD } });
  const owner = await prisma.user.findFirstOrThrow({ where: { email: ownerEmail } });
  const ana = await prisma.user.findFirstOrThrow({ where: { email: anaEmail } });
  const ben = await prisma.user.findFirstOrThrow({ where: { email: benEmail } });

  const category = await prisma.category.create({ data: { userId: owner.id, name: "Trip", kind: "EXPENSE", icon: "🧳", color: "#0ea5e9" } });
  const pAna = await prisma.participant.create({ data: { ownerId: owner.id, displayName: "Ana", linkedUserId: ana.id } });
  const pBen = await prisma.participant.create({ data: { ownerId: owner.id, displayName: "Ben", linkedUserId: ben.id } });
  const pCara = await prisma.participant.create({ data: { ownerId: owner.id, displayName: "Cara" } });
  const group = await prisma.group.create({
    data: {
      name: `Manali-${suffix}`,
      createdById: owner.id,
      members: { create: [{ participantId: pAna.id }, { participantId: pBen.id }, { participantId: pCara.id }] },
    },
  });

  const mk = (merchant: string, total: number, paidBy: string | null, shares: [string | null, number][]) =>
    prisma.transaction.create({
      data: {
        userId: owner.id, type: "EXPENSE", amount: rup(total), categoryId: category.id,
        merchant, occurredAt: new Date(), groupId: group.id, paidByParticipantId: paidBy,
        splits: { create: shares.map(([participantId, owed]) => ({ participantId, owedAmount: rup(owed) })) },
      },
    });
  const eq4 = (amt: number): [string | null, number][] => {
    const e = amt / 4;
    return [[null, e], [pAna.id, e], [pBen.id, e], [pCara.id, e]];
  };
  await mk("Hotel", 4000, null, eq4(4000));
  await mk("Petrol", 1200, pAna.id, eq4(1200));
  await mk("Flights", 8000, pBen.id, eq4(8000)); // Ben becomes a creditor → member-to-member hop
  await recordSettlement(owner.id, pCara.id, "TO_OWNER", rup(500), "UPI", undefined, group.id);

  const browser = await chromium.launch({ headless: true });
  const sessions: BrowserContext[] = [];
  try {
    const o = await newSession(browser, ownerEmail);
    const a = await newSession(browser, anaEmail);
    const b = await newSession(browser, benEmail);
    sessions.push(o.ctx, a.ctx, b.ctx);

    const ownerView = await readCard(o.page, group.id);
    const anaView = await readCard(a.page, group.id);
    const benView = await readCard(b.page, group.id);

    console.log("\n--- owner share ---\n" + ownerView.share);
    console.log("\n--- member (Ana) share ---\n" + anaView.share + "\n");

    // ═══ the economics must be identical ═══
    ok("1. all three see the same payment count", ownerView.headline === anaView.headline && ownerView.headline === benView.headline, ownerView.headline);
    ok("2. all three see the same total", ownerView.total === anaView.total && ownerView.total === benView.total, ownerView.total);
    ok("3. all three see the same payment rows", JSON.stringify(anaView.rows) === JSON.stringify(ownerView.rows) && JSON.stringify(benView.rows) === JSON.stringify(ownerView.rows),
      `${ownerView.rows.length} rows`);
    ok("4. the shareable WhatsApp text is identical", anaView.share === ownerView.share && benView.share === ownerView.share);
    ok("5. a member-to-member payment is present and shown as such",
      ownerView.rows.some((r) => !r.includes("Olivia")) && anaView.rows.some((r) => !r.includes("Olivia")));
    // Cara consumed 1000 + 300 + 2000 = ₹3,300 and has settled ₹500, so the
    // plan must ask her for ₹2,800 — for members as well as the owner. Before
    // the group-scoped settlement read, members were still shown ₹3,300.
    ok("6. the recorded settlement is reflected for members too (₹2,800, not the un-settled ₹3,300)",
      [ownerView, anaView, benView].every((v) => v.rows.some((r) => r.includes("Cara") && r.includes("2,800")) && !v.rows.some((r) => r.includes("3,300"))));
    ok("7. nobody is addressed as 'You' inside the plan", ![ownerView, anaView, benView].some((v) => /(^|\s)You\s*→|→\s*You(\s|$)/.test(v.rows.join(" "))));
    // The "you" chip marks the OWNER's side of an arrow. Showing it to a member
    // would label a different person as them.
    // Plain substring, not \byou\b: innerText concatenates the chip onto the
    // name ("Olivia Owneryou"), so there is no word boundary to match. No name
    // in this fixture contains "you".
    ok("7b. the 'you' chip appears only for the owner",
      ownerView.rawRows.join(" ").includes("you") && !anaView.rawRows.join(" ").includes("you") && !benView.rawRows.join(" ").includes("you"));

    // ═══ owner identity ═══
    ok("8. the owner sees themselves as 'You · owner'", /You\s*·?\s*owner/i.test(ownerView.pageText));
    ok("9. a member sees the owner by name, not as 'You'",
      /Olivia Owner\s*·?\s*owner/i.test(anaView.pageText) && !/\bYou\b\s*·?\s*owner/i.test(anaView.pageText));
    ok("10. 'you paid' is likewise not attributed to the reader",
      /you paid/i.test(ownerView.pageText) && !/you paid/i.test(anaView.pageText) && /Olivia Owner paid/i.test(anaView.pageText));

    // ═══ settle affordance ═══
    ok("11. the owner is offered Settle", ownerView.settleButtons > 0, `${ownerView.settleButtons} buttons`);
    ok("12. members are offered NO settle action", anaView.settleButtons === 0 && benView.settleButtons === 0);
    ok("13. members are told why, without jargon", /Only Olivia Owner can record payments in this group/i.test(anaView.pageText));
    ok("14. the 'Settle up' quick action is hidden from members",
      (await o.page.getByRole("button", { name: "Settle up", exact: true }).count()) > 0 && (await a.page.getByRole("button", { name: "Settle up", exact: true }).count()) === 0);
    ok("15. members can still share the plan", (await a.page.getByRole("button", { name: "Share settlement", exact: true }).count()) > 0);

    // Settlement history is the same feature and had the same two faults.
    ok("15b. settlement history attributes the payment to the owner by name, not to the reader",
      /Cara paid you/i.test(ownerView.pageText) && /Cara paid Olivia Owner/i.test(anaView.pageText) && !/Cara paid you/i.test(anaView.pageText));
    const delLabel = /Delete settlement/i;
    ok("15c. only the owner gets a delete control on a settlement",
      (await o.page.getByRole("button", { name: delLabel }).count()) > 0 && (await a.page.getByRole("button", { name: delLabel }).count()) === 0);

    await o.page.screenshot({ path: path.join(SHOT, "collab-390-owner.png"), fullPage: true });
    await a.page.screenshot({ path: path.join(SHOT, "collab-390-member.png"), fullPage: true });

    // ═══ widths, member view ═══
    for (const w of [360, 390, 430, 1440]) {
      await a.page.setViewportSize({ width: w, height: w >= 1440 ? 900 : 844 });
      await a.page.goto(`${BASE}/shared/groups/${group.id}?p=all`, { waitUntil: "load" });
      await a.page.waitForSelector("text=Group Settlement", { timeout: 30000 });
      const overflow = await a.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      const shareVisible = await a.page.getByRole("button", { name: "Share settlement" }).isVisible();
      ok(`16. ${w}px member view: no overflow, plan and Share still reachable`, !overflow && shareVisible, `overflow=${overflow}`);
      if (w === 1440) await a.page.screenshot({ path: path.join(SHOT, "collab-1440-member.png"), fullPage: true });
    }
  } finally {
    for (const c of sessions) await c.close().catch(() => {});
    await browser.close();
    const txs = await prisma.transaction.findMany({ where: { groupId: group.id }, select: { id: true } });
    await prisma.expenseSplit.deleteMany({ where: { txId: { in: txs.map((t) => t.id) } } });
    await prisma.transaction.deleteMany({ where: { groupId: group.id } });
    await prisma.settlement.deleteMany({ where: { groupId: group.id } });
    await prisma.groupMember.deleteMany({ where: { groupId: group.id } });
    await prisma.group.delete({ where: { id: group.id } });
    await prisma.participant.deleteMany({ where: { id: { in: [pAna.id, pBen.id, pCara.id] } } });
    for (const u of [owner.id, ana.id, ben.id]) await prisma.user.delete({ where: { id: u } }).catch(() => {});
    await prisma.$disconnect();
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    for (const f of failed) console.log(`  ✗ ${f.name}`);
    if (failed.length) process.exitCode = 1;
  }
}

main();
