// v2.1 — end-to-end verification of the shared-expense group fixes (A, B, C)
// against the LOCAL Docker Postgres. Never point this at production.
//
// Covers the 18-point checklist from the bug report: group inference on the
// global Add Expense flow, the group-first flow, the re-home repair path,
// refusal to guess between groups, Lending contacts in the split picker, the
// duplicate-contact warning, and personal expenses staying untouched.
//
// Run: npx tsx scripts/e2e-group-rehome.ts
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { prisma } from "../src/server/db";
import { netBalances } from "../src/server/services/shared";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const SUFFIX = randomUUID().slice(0, 6);
const SHOT = path.join(process.cwd(), "e2e-output");
fs.mkdirSync(SHOT, { recursive: true });

const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const modal = (page: Page) => page.locator(".fixed.inset-0.z-\\[60\\]").first();

const N = {
  abhi: `ZAlex-${SUFFIX}`,
  bal: `ZBlake-${SUFFIX}`,
  casey: `ZCasey-${SUFFIX}`,
  devon: `ZDevon-${SUFFIX}`,
};
const GROUP = `ZTrip-${SUFFIX}`;
const GROUP2 = `ZFlat-${SUFFIX}`;

async function toggleParticipant(page: Page, name: string) {
  await modal(page).getByRole("button", { name, exact: false }).first().click();
}

/** Waits for a transaction to exist by merchant, polling the DB.
 *  Non-split creates go through the offline outbox and drain in the background,
 *  so they land a beat after the toast — hence polling rather than a single read. */
async function waitForTx(merchant: string, timeoutMs = 40000) {
  const started = Date.now();
  for (;;) {
    const tx = await prisma.transaction.findFirst({
      where: { merchant },
      include: { splits: true },
      orderBy: { createdAt: "desc" },
    });
    if (tx) return tx;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for tx "${merchant}"`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** The sign-in button is disabled until React hydrates (`busy || !hydrated`),
 *  and a cold `next dev` compile can take a while — so wait for it to become
 *  enabled rather than racing it. */
async function signIn(page: Page) {
  await page.goto(`${BASE}/sign-in`, { waitUntil: "load" });
  await page.fill('input[type="email"]', "arjun@ledgerly.app");
  await page.fill('input[type="password"]', "ledgerly-demo");
  const submit = page.locator('button[type="submit"]');
  await submit.waitFor({ state: "visible", timeout: 60000 });
  await page.waitForFunction(
    () => {
      const b = document.querySelector('button[type="submit"]');
      return !!b && !(b as HTMLButtonElement).disabled;
    },
    undefined,
    { timeout: 60000 }
  );
  await submit.click();
  await page.waitForURL("**/dashboard", { timeout: 60000 });
}

/** Opens the global Add Expense modal. The header's "＋ Add expense" button is
 *  `hidden md:block`, so at 390px the real entry point is the dashboard's
 *  Expense quick action — which is what a phone user actually taps. */
async function openAddExpense(page: Page) {
  await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
  const quick = page.getByRole("button", { name: "Expense", exact: true }).first();
  await quick.waitFor({ state: "visible", timeout: 30000 });
  await quick.click();
  await page.waitForSelector('input[placeholder="e.g. Swiggy"]', { timeout: 30000 });
}

/** Turns on "Split with friends". The toggle lives inside the collapsed
 *  "More details" <details>, so that has to be opened first. */
async function enableSplit(page: Page) {
  const summary = modal(page).locator("summary", { hasText: "More details" }).first();
  if (await summary.count()) {
    const open = await modal(page).locator("details").first().evaluate((d) => (d as HTMLDetailsElement).open);
    if (!open) await summary.click();
  }
  await modal(page).getByText("👥 Split with friends").first().click();
  await page.waitForSelector("text=Split between", { timeout: 15000 });
}

/** Reads the value of the modal's Group select, by its accessible name. */
async function groupSelectValue(page: Page): Promise<string> {
  const sel = modal(page).getByLabel("Group", { exact: true });
  if ((await sel.count()) === 0) return "__absent__";
  return sel.inputValue();
}

async function main() {
  const user = await prisma.user.findFirstOrThrow({ where: { email: "arjun@ledgerly.app" } });
  const account = await prisma.account.findFirstOrThrow({ where: { userId: user.id } });
  const category = await prisma.category.findFirstOrThrow({ where: { userId: user.id, kind: "EXPENSE" } });

  // ── fixture: four contacts, one of them a Lending-only import ──────────────
  const mk = (displayName: string) => prisma.participant.create({ data: { ownerId: user.id, displayName } });
  const abhi = await mk(N.abhi);
  const bal = await mk(N.bal);
  const casey = await mk(N.casey);
  const devon = await mk(N.devon);

  // `bal` gets a loan entry and nothing else — under the OLD rule this made him
  // lendingOnly and therefore invisible in the split picker, which is exactly
  // what forced a duplicate person in production.
  await prisma.loanEntry.create({
    data: { userId: user.id, participantId: bal.id, kind: "GAVE", amount: 50_000, occurredAt: new Date() },
  });

  const group = await prisma.group.create({
    data: {
      name: GROUP,
      createdById: user.id,
      members: { create: [abhi, bal, casey, devon].map((p) => ({ participantId: p.id })) },
    },
  });
  const groupCat = await prisma.category.create({ data: { groupId: group.id, name: "Travel", kind: "EXPENSE" } });
  // second group sharing exactly two members → the ambiguity case
  const group2 = await prisma.group.create({
    data: {
      name: GROUP2,
      createdById: user.id,
      members: { create: [{ participantId: abhi.id }, { participantId: bal.id }] },
    },
  });

  const cleanupTxIds: string[] = [];
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  try {
    await signIn(page);
    ok("1-2. signed in against the LOCAL docker DB with a 5-person fixture group", true, `${GROUP} + You`);

    // ═════ 3-6. global Add Expense → split all 4 → group inferred, 1/5 each ═════
    const m1 = `ZGlobal-${SUFFIX}`;
    await openAddExpense(page);
    await page.fill('input[placeholder="0"]', "500");
    await page.fill('input[placeholder="e.g. Swiggy"]', m1);
    await enableSplit(page);
    for (const n of [N.abhi, N.bal, N.casey, N.devon]) await toggleParticipant(page, n);

    // 14-15. the Lending contact is present and selectable in the picker
    const balRow = modal(page).getByRole("button", { name: N.bal, exact: false }).first();
    ok("14-15. a Lending-only contact is listed in the split picker and selectable", (await balRow.count()) > 0 && (await balRow.getAttribute("aria-pressed")) === "true");
    ok("14b. it carries a Lending badge so it's distinguishable", (await modal(page).getByText("Lending", { exact: true }).count()) > 0);

    // 3. the Group field is outside Advanced (visible without expanding it)
    const groupVisible = await modal(page).getByLabel("Group", { exact: true }).isVisible().catch(() => false);
    ok("3. GROUP selector is surfaced outside Advanced once Split is on", groupVisible);

    // 5. it auto-selected the inferred group
    const inferred = await groupSelectValue(page);
    ok("5. groupId auto-assigned from the people picked", inferred === group.id, `select=${inferred === group.id ? GROUP : inferred}`);
    await page.screenshot({ path: path.join(SHOT, "rehome-390-inferred-group.png") });

    await modal(page).getByRole("button", { name: "Add expense", exact: true }).click();
    await page.waitForSelector("text=Split expense added", { timeout: 20000 });

    const tx1 = await waitForTx(m1);
    cleanupTxIds.push(tx1.id);
    ok("5b. the saved row carries the group id", tx1.groupId === group.id);
    const shares1 = tx1.splits.map((s) => Number(s.owedAmount));
    ok("6. each of the 5 people owes exactly 1/5 (₹500 → ₹100)", shares1.length === 5 && shares1.every((v) => v === 10_000), shares1.join("/"));
    ok("6b. shares sum to the total", shares1.reduce((a, b) => a + b, 0) === 50_000);

    // ═════ 7-8. group-first flow behaves identically ═════
    const m2 = `ZFromGroup-${SUFFIX}`;
    await page.goto(`${BASE}/shared/groups/${group.id}`, { waitUntil: "load" });
    await page.getByRole("button", { name: "Add expense" }).first().click();
    await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
    await page.fill('input[placeholder="0"]', "500");
    await page.fill('input[placeholder="e.g. Swiggy"]', m2);
    const preGroup = await groupSelectValue(page);
    ok("7. group-first Add Expense preserves the group (existing flow intact)", preGroup === group.id);
    // pick a category from the group's own namespace
    const catSel = modal(page).locator("select").filter({ hasText: "Travel" }).first();
    if (await catSel.count()) await catSel.selectOption({ label: "Travel" }).catch(() => {});
    await modal(page).getByRole("button", { name: "Add expense", exact: true }).click();
    await page.waitForSelector("text=Split expense added", { timeout: 20000 });
    const tx2 = await waitForTx(m2);
    cleanupTxIds.push(tx2.id);
    const shares2 = tx2.splits.map((s) => Number(s.owedAmount));
    ok("8. identical behaviour from the group page", tx2.groupId === group.id && shares2.length === 5 && shares2.every((v) => v === 10_000), shares2.join("/"));

    // ═════ 12-13. two candidate groups → no guess, explicit choice required ═════
    const m3 = `ZAmbiguous-${SUFFIX}`;
    await openAddExpense(page);
    await page.fill('input[placeholder="0"]', "300");
    await page.fill('input[placeholder="e.g. Swiggy"]', m3);
    await enableSplit(page);
    for (const n of [N.abhi, N.bal]) await toggleParticipant(page, n);
    const ambiguousValue = await groupSelectValue(page);
    ok("13. does NOT guess when two groups both contain everyone picked", ambiguousValue === "", `select="${ambiguousValue}"`);
    const asksToPick = await modal(page).getByText("pick which", { exact: false }).count();
    ok("12-13b. asks the user to choose explicitly", asksToPick > 0);
    const saveBtn = modal(page).getByRole("button", { name: "Add expense", exact: true });
    ok("13c. saving is blocked until they answer (no silent fallback to Personal)", await saveBtn.isDisabled());
    await page.screenshot({ path: path.join(SHOT, "rehome-390-ambiguous.png") });

    // choosing explicitly unblocks and is honoured
    await modal(page).getByLabel("Group", { exact: true }).selectOption(group2.id);
    ok("13d. choosing a group unblocks saving", !(await saveBtn.isDisabled()));
    await saveBtn.click();
    await page.waitForSelector("text=Split expense added", { timeout: 20000 });
    const tx3 = await waitForTx(m3);
    cleanupTxIds.push(tx3.id);
    ok("13e. the explicitly chosen group is what gets saved", tx3.groupId === group2.id);

    // ═════ 9-11. re-home an existing personal split from the UI ═════
    const m4 = `ZOrphan-${SUFFIX}`;
    const orphan = await prisma.transaction.create({
      data: {
        userId: user.id,
        type: "EXPENSE",
        amount: 500_000,
        accountId: account.id,
        categoryId: category.id,
        merchant: m4,
        occurredAt: new Date(),
        groupId: null,
        splits: {
          create: [null, abhi.id, bal.id, casey.id, devon.id].map((participantId) => ({
            participantId,
            owedAmount: 100_000,
            method: "EQUAL" as const,
          })),
        },
      },
      include: { splits: true },
    });
    cleanupTxIds.push(orphan.id);

    const netsBefore = (await netBalances(user.id)).map((p) => ({ id: p.id, net: p.net }));
    const totalBefore = netsBefore.reduce((s, p) => s + p.net, 0);
    const splitsBefore = await prisma.expenseSplit.findMany({ where: { txId: orphan.id }, orderBy: { id: "asc" } });

    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await page.getByText(m4).first().click();
    await page.waitForSelector("text=Move to", { timeout: 15000 });
    await page.screenshot({ path: path.join(SHOT, "rehome-390-prompt.png") });
    await modal(page).getByRole("button", { name: `Move to ${GROUP}`, exact: false }).first().click();
    await page.waitForSelector(`text=Moved to ${GROUP}`, { timeout: 20000 });

    const moved = await prisma.transaction.findUniqueOrThrow({ where: { id: orphan.id } });
    ok("9. an existing personal expense can be assigned to the group from the UI", moved.groupId === group.id);

    const splitsAfter = await prisma.expenseSplit.findMany({ where: { txId: orphan.id }, orderBy: { id: "asc" } });
    ok(
      "10. ONLY groupId changed on the transaction row",
      Number(moved.amount) === 500_000 &&
        moved.paidByParticipantId === orphan.paidByParticipantId &&
        moved.accountId === orphan.accountId &&
        moved.categoryId === orphan.categoryId &&
        moved.merchant === orphan.merchant
    );
    ok(
      "11. split rows are byte-identical — same ids, participants and amounts",
      JSON.stringify(splitsAfter.map((s) => ({ i: s.id, p: s.participantId, a: Number(s.owedAmount) }))) ===
        JSON.stringify(splitsBefore.map((s) => ({ i: s.id, p: s.participantId, a: Number(s.owedAmount) })))
    );
    const netsAfter = (await netBalances(user.id)).map((p) => ({ id: p.id, net: p.net }));
    const totalAfter = netsAfter.reduce((s, p) => s + p.net, 0);
    ok("11b. every per-person balance is unchanged by the move", JSON.stringify(netsAfter) === JSON.stringify(netsBefore), `total ${totalBefore} → ${totalAfter}`);

    // ═════ 16-17. duplicate contact warning ═════
    await page.goto(`${BASE}/shared`, { waitUntil: "load" });
    await page.click('button:has-text("＋ Add friend")').catch(async () => {
      await page.getByRole("button", { name: "Add friend", exact: false }).first().click();
    });
    await page.waitForSelector('input[placeholder="e.g. Rohan"]', { timeout: 15000 });
    await page.fill('input[placeholder="e.g. Rohan"]', N.bal);
    const warned = await modal(page).getByText("already have", { exact: false }).count();
    ok("16-17. creating a person with an existing name shows a duplicate warning", warned > 0);
    const relabelled = await modal(page).getByRole("button", { name: "Add as a separate person", exact: false }).count();
    ok("17b. the action relabels so creating a second record is deliberate", relabelled > 0);
    await page.screenshot({ path: path.join(SHOT, "rehome-390-duplicate-warning.png") });
    await page.keyboard.press("Escape");

    // ═════ 18. personal (non-split) expenses still work ═════
    const m5 = `ZPersonal-${SUFFIX}`;
    await openAddExpense(page);
    await page.fill('input[placeholder="0"]', "120");
    await page.fill('input[placeholder="e.g. Swiggy"]', m5);
    const groupFieldWhenNoSplit = await modal(page).getByLabel("Group", { exact: true }).isVisible().catch(() => false);
    ok("18a. GROUP stays tucked in Advanced for a plain personal expense", !groupFieldWhenNoSplit);
    await modal(page).getByRole("button", { name: "Add expense", exact: true }).click();
    await page.waitForSelector("text=Expense added", { timeout: 20000 });
    const tx5 = await waitForTx(m5);
    cleanupTxIds.push(tx5.id);
    ok("18. a personal expense saves normally, with no group and no splits", tx5.groupId === null && tx5.splits.length === 0);

    // ═════ group isolation sanity on the dashboards ═════
    const dashRes = await page.goto(`${BASE}/shared/groups/${group2.id}?p=all`, { waitUntil: "load" });
    ok("group isolation: the second group's page renders independently", (dashRes?.status() ?? 0) < 400);
    await page.screenshot({ path: path.join(SHOT, "rehome-390-group-dashboard.png") });

    // desktop + 430px sanity
    for (const [w, h, label] of [[430, 932, "430"], [1280, 900, "desktop"]] as const) {
      const p2 = await browser.newPage({ viewport: { width: w, height: h } });
      await signIn(p2);
      const r = await p2.goto(`${BASE}/shared/groups/${group.id}?p=all`, { waitUntil: "load" });
      const overflow = await p2.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      ok(`group dashboard renders at ${label}px without horizontal overflow`, (r?.status() ?? 0) < 400 && !overflow);
      await p2.screenshot({ path: path.join(SHOT, `rehome-${label}-group-dashboard.png`) });
      await p2.close();
    }
  } finally {
    await browser.close();
    // fixture teardown — local DB only
    await prisma.expenseSplit.deleteMany({ where: { txId: { in: cleanupTxIds } } });
    await prisma.transaction.deleteMany({ where: { id: { in: cleanupTxIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: cleanupTxIds } } });
    await prisma.category.deleteMany({ where: { id: groupCat.id } });
    await prisma.group.deleteMany({ where: { id: { in: [group.id, group2.id] } } });
    await prisma.loanEntry.deleteMany({ where: { participantId: bal.id } });
    await prisma.participant.deleteMany({ where: { id: { in: [abhi.id, bal.id, casey.id, devon.id] } } });
    await prisma.$disconnect();

    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
      console.log("FAILURES:");
      for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? " · " + f.detail : ""}`);
      process.exitCode = 1;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
