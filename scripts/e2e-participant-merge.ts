// v2.1 — browser verification that a merged identity RENDERS correctly.
// LOCAL Docker DB only. Reproduces the production shape (two "Blake" records,
// one a non-member holding a share) and checks the UI before and after a merge.
//
// Run: E2E_BASE=http://localhost:3001 npx tsx scripts/e2e-participant-merge.ts
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { prisma } from "../src/server/db";
import { mergeParticipants } from "../src/server/services/shared";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const S = randomUUID().slice(0, 6);
const SHOT = path.join(process.cwd(), "e2e-output");
fs.mkdirSync(SHOT, { recursive: true });
const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};
const NAME = `ZBlake-${S}`;
const GROUP = `ZMergeTrip-${S}`;

async function signIn(page: Page) {
  await page.goto(`${BASE}/sign-in`, { waitUntil: "load" });
  await page.fill('input[type="email"]', "arjun@ledgerly.app");
  await page.fill('input[type="password"]', "ledgerly-demo");
  await page.waitForFunction(() => {
    const b = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    return !!b && !b.disabled;
  }, undefined, { timeout: 60000 });
  await page.click('button[type="submit"]');
  // Poll rather than waitForURL: on a production build the post-sign-in redirect
  // is client-side and never emits a `load`, so waitForURL just times out.
  for (let i = 0; i < 80 && !page.url().includes("/dashboard"); i++) await page.waitForTimeout(500);
  if (!page.url().includes("/dashboard")) throw new Error("sign-in failed: " + (await page.locator("body").innerText()).slice(0, 120));
}

async function main() {
  const user = await prisma.user.findFirstOrThrow({ where: { email: "arjun@ledgerly.app" } });
  const account = await prisma.account.findFirstOrThrow({ where: { userId: user.id } });
  const category = await prisma.category.findFirstOrThrow({ where: { userId: user.id, kind: "EXPENSE" } });

  const mk = (n: string) => prisma.participant.create({ data: { ownerId: user.id, displayName: n } });
  const canonical = await mk(NAME);
  const duplicate = await mk(NAME); // same display name, different id — the production shape
  const other = await mk(`ZAlex-${S}`);

  const group = await prisma.group.create({
    data: { name: GROUP, createdById: user.id, members: { create: [{ participantId: canonical.id }, { participantId: other.id }] } },
  });

  // one expense on the canonical, one on the (non-member) duplicate
  const mkTx = (merchant: string, pid: string, owed: number, total: number) =>
    prisma.transaction.create({
      data: {
        userId: user.id, type: "EXPENSE", amount: total, accountId: account.id, categoryId: category.id,
        merchant, occurredAt: new Date(), groupId: group.id,
        splits: { create: [{ participantId: null, owedAmount: owed }, { participantId: other.id, owedAmount: owed }, { participantId: pid, owedAmount: owed }] },
      },
    });
  const txA = await mkTx(`ZMergeA-${S}`, canonical.id, 10_000, 30_000);
  const txB = await mkTx(`ZMergeB-${S}`, duplicate.id, 20_000, 60_000);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await signIn(page);

    // ── BEFORE: the duplicate shows as a second identity ──────────────────
    await page.goto(`${BASE}/shared/groups/${group.id}?p=all`, { waitUntil: "load" });
    // The server component is still streaming when 'load' fires, so anchor on a
    // known element before reading text — otherwise innerText sees a partial
    // document and the assertions below fail for no real reason.
    await page.waitForSelector("text=Members · contribution", { timeout: 30000 });
    const beforeText = await page.locator("body").innerText();
    ok("before merge: the group shows a '(left group)' row for the non-member duplicate", beforeText.includes("(left group)"));
    ok("before merge: two separate balances exist (₹100 and ₹200)", beforeText.includes("100") && beforeText.includes("200"));
    await page.screenshot({ path: path.join(SHOT, "merge-390-before.png"), fullPage: true });

    // ── MERGE (through the real service) ──────────────────────────────────
    await mergeParticipants(user.id, canonical.id, duplicate.id);

    // ── AFTER ─────────────────────────────────────────────────────────────
    await page.goto(`${BASE}/shared/groups/${group.id}?p=all`, { waitUntil: "load" });
    // The server component is still streaming when 'load' fires, so anchor on a
    // known element before reading text — otherwise innerText sees a partial
    // document and the assertions below fail for no real reason.
    await page.waitForSelector("text=Members · contribution", { timeout: 30000 });
    const afterText = await page.locator("body").innerText();
    // Scoped to the members card. The name legitimately appears a second time in
    // the Balances list as a payment row — that is one person being
    // named twice on the page, not two identities, so counting whole-page text
    // would be the wrong assertion.
    // The page splits at the payment plan, whose section is headed "Settle up".
    const splitAt = afterText.indexOf("Settle up");
    const membersSection = splitAt > 0 ? afterText.slice(0, splitAt) : afterText;
    const suggestionSection = splitAt > 0 ? afterText.slice(splitAt) : "";
    const memberOccurrences = (membersSection.match(new RegExp(NAME, "g")) ?? []).length;
    const suggestionOccurrences = (suggestionSection.match(new RegExp(NAME, "g")) ?? []).length;
    ok("after merge: the contact appears exactly once in the members list", memberOccurrences === 1, `${memberOccurrences}× in members section`);
    ok("after merge: it is named once more only as a payment row in the settlement plan", suggestionOccurrences === 1, `${suggestionOccurrences}× in the plan`);
    ok("after merge: no '(left group)' row remains", !afterText.includes("(left group)"));
    ok("after merge: the combined balance ₹300.00 is shown", afterText.includes("300"));
    ok("after merge: group total unchanged at ₹900.00", afterText.includes("900"));
    await page.screenshot({ path: path.join(SHOT, "merge-390-after.png"), fullPage: true });

    // ── the split picker offers exactly one ───────────────────────────────
    await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    // The composer, whose split line opens the SAME SplitEditor picker.
    await page.getByRole("button", { name: "Expense", exact: true }).first().click();
    const composer = page.locator("div[data-composer]");
    await composer.waitFor({ timeout: 30000 });
    await composer.getByRole("button", { name: /people ·|Choose who's splitting|Split with someone/ }).click();
    const modal = page.getByRole("dialog").last();
    // The roster only exists once the split is switched on — the same toggle
    // the classic form carried, in the sheet the line opens.
    const splitSwitch = modal.locator('[role="switch"]').first();
    if ((await splitSwitch.getAttribute("aria-checked")) !== "true") {
      await modal.getByText("👥 Split with friends").first().click();
      await page.waitForTimeout(300);
    }
    await page.waitForSelector("text=Split between", { timeout: 15000 });
    const search = modal.getByLabel("Search contacts");
    if (await search.count()) await search.fill(NAME);
    const rows = await modal.getByRole("button", { name: NAME, exact: false }).count();
    ok("split picker offers exactly ONE contact with that name", rows === 1, `${rows}`);
    const selectable = await modal.getByRole("button", { name: NAME, exact: false }).first().isEnabled();
    ok("the surviving contact is still selectable", selectable);
    await page.screenshot({ path: path.join(SHOT, "merge-390-picker.png") });

    // ── the expenses still display correctly ──────────────────────────────
    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    // Text-presence, not visibility: the desktop "Add expense" button is
    // `hidden md:block`, so waiting for a *visible* match never resolves at 390px.
    await page.waitForFunction(() => document.body.innerText.includes("Add expense"), undefined, { timeout: 30000 });
    const list = await page.locator("body").innerText();
    ok("both original expenses still listed", list.includes(`ZMergeA-${S}`) && list.includes(`ZMergeB-${S}`));
  } finally {
    await browser.close();
    await prisma.expenseSplit.deleteMany({ where: { txId: { in: [txA.id, txB.id] } } });
    await prisma.transaction.deleteMany({ where: { id: { in: [txA.id, txB.id] } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [txA.id, txB.id, canonical.id] } } });
    await prisma.group.deleteMany({ where: { id: group.id } });
    await prisma.participant.deleteMany({ where: { id: { in: [canonical.id, duplicate.id, other.id] } } });
    await prisma.$disconnect();
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) { for (const f of failed) console.log(`  ✗ ${f.name}`); process.exitCode = 1; }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
