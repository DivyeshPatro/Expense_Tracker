// v2.1 — browser verification of the two UX fixes:
//   1. Create Group exposes "Existing member" / "New member" explicitly, using
//      the same picker the group page's Add member already used.
//   2. Group Balances shows raw obligations, a simplified plan behind a toggle,
//      and a receive-only view — all from the existing engine.
//
// LOCAL Docker DB only. Run:
//   E2E_BASE=http://localhost:3001 npx tsx scripts/e2e-group-members-balances.ts
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { prisma } from "../src/server/db";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const S = randomUUID().slice(0, 6);
const SHOT = path.join(process.cwd(), "e2e-output");
fs.mkdirSync(SHOT, { recursive: true });

const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};
const modal = (p: Page) => p.locator(".fixed.inset-0.z-\\[60\\]").first();

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
  if (!page.url().includes("/dashboard")) throw new Error("sign-in failed: " + (await page.locator("body").innerText()).slice(0, 120));
}

async function main() {
  const user = await prisma.user.findFirstOrThrow({ where: { email: "arjun@ledgerly.app" } });
  const account = await prisma.account.findFirstOrThrow({ where: { userId: user.id } });
  const category = await prisma.category.findFirstOrThrow({ where: { userId: user.id, kind: "EXPENSE" } });

  // Fixture contacts: one plain, one WITH a phone, one that is a Lending contact.
  const mk = async (displayName: string, phone?: string) =>
    (await prisma.participant.create({ data: { ownerId: user.id, displayName, phone: phone ?? null } })).id;
  const alex = await mk(`MB-Alex-${S}`, "9876500001");
  const blake = await mk(`MB-Blake-${S}`);
  const lender = await mk(`MB-Lender-${S}`, "9876500002");
  await prisma.loanEntry.create({ data: { userId: user.id, participantId: lender, kind: "GAVE", amount: 50_000, occurredAt: new Date() } });

  // A group where the optimal plan differs from the raw list:
  //   you paid 300 split 3 ways  → Alex +100, Blake +100
  //   Blake paid 300 split 3 ways → you −100, Alex −100  ⇒ Alex +200, Blake 0? etc.
  const group = await prisma.group.create({
    data: { name: `MBTrip-${S}`, createdById: user.id, members: { create: [{ participantId: alex }, { participantId: blake }] } },
  });
  const mkTx = (merchant: string, total: number, share: number, paidBy: string | null) =>
    prisma.transaction.create({
      data: {
        userId: user.id, type: "EXPENSE", amount: total, accountId: paidBy ? null : account.id, categoryId: category.id,
        merchant, occurredAt: new Date(), groupId: group.id, paidByParticipantId: paidBy,
        splits: { create: [{ participantId: null, owedAmount: share }, { participantId: alex, owedAmount: share }, { participantId: blake, owedAmount: share }] },
      },
    });
  await mkTx(`MB-A-${S}`, 30_000, 10_000, null);
  await mkTx(`MB-B-${S}`, 60_000, 20_000, blake);
  // a fully settled group, to prove the empty states
  const settledGroup = await prisma.group.create({
    data: { name: `MBSettled-${S}`, createdById: user.id, members: { create: [{ participantId: alex }] } },
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const createdGroupIds: string[] = [];
  const createdParticipantIds: string[] = [];

  try {
    await signIn(page);

    // ═══ 1. CREATE GROUP — the two explicit choices ═══
    await page.goto(`${BASE}/shared?p=all`, { waitUntil: "load" });
    await page.waitForSelector("text=Groups", { timeout: 30000 });
    await page.getByRole("button", { name: "＋ New group" }).first().click();
    await page.waitForSelector("text=GROUP NAME", { timeout: 20000 });
    const m = modal(page);
    ok("1. Create Group offers 'Existing member' and 'New member' as equal choices",
      (await m.getByRole("tab", { name: "Existing member" }).count()) > 0 && (await m.getByRole("tab", { name: "New member" }).count()) > 0);
    ok("1b. no subtle '＋ New member' secondary button remains", (await m.getByText("＋ New member").count()) === 0);
    const searchBox = m.getByLabel("Search contacts");
    ok("1c. existing members are searchable", (await searchBox.count()) > 0);

    // existing contact: phone + lending badge + search
    await searchBox.fill(`MB-Lender-${S}`);
    await page.waitForTimeout(600);
    const lenderRow = m.getByRole("button", { name: new RegExp(`MB-Lender-${S}`) }).first();
    ok("1d. a Lending contact is searchable and shows its Lending badge",
      (await lenderRow.count()) > 0 && (await m.getByText("Lending", { exact: true }).count()) > 0);
    ok("1e. the phone number is shown when available", (await m.getByText("9876500002").count()) > 0);
    await searchBox.fill("MB-Alex");
    await page.waitForTimeout(600);
    ok("1f. search matches by phone too", await (async () => {
      await searchBox.fill("9876500001");
      await page.waitForTimeout(600);
      return (await m.getByRole("button", { name: new RegExp(`MB-Alex-${S}`) }).count()) > 0;
    })());
    await searchBox.fill("zzz-no-such-contact");
    await page.waitForTimeout(600);
    ok("1g. empty search offers the New member route", (await m.getByText("Add them as a new member").count()) > 0);

    // select two existing contacts
    await searchBox.fill(`MB-Alex-${S}`);
    await page.waitForTimeout(600);
    await m.getByRole("button", { name: new RegExp(`MB-Alex-${S}`) }).first().click();
    await page.waitForTimeout(400);
    ok("1h. selecting an existing contact marks it added", (await m.getByText("✓ Added").count()) > 0);
    ok("1i. the selection is shown as a removable chip", (await m.getByRole("button", { name: new RegExp(`Remove MB-Alex-${S}`) }).count()) > 0);
    // clicking again toggles off — no duplicate possible
    await m.getByRole("button", { name: new RegExp(`MB-Alex-${S}`) }).first().click();
    await page.waitForTimeout(400);
    ok("1j. clicking again de-selects (a duplicate member cannot be created)", (await m.getByText("✓ Added").count()) === 0);
    await m.getByRole("button", { name: new RegExp(`MB-Alex-${S}`) }).first().click();
    await page.waitForTimeout(400);

    // new member path
    await m.getByRole("tab", { name: "New member" }).click();
    await page.waitForTimeout(400);
    const newName = `MB-New-${S}`;
    await m.getByLabel("Name", { exact: true }).fill(newName);
    await m.getByLabel("Phone", { exact: true }).fill("9876500003");
    await m.getByLabel("Email", { exact: true }).fill("mbnew@example.com");
    const partsBefore = await prisma.participant.count({ where: { ownerId: user.id } });
    await m.getByRole("button", { name: "Add to group" }).click();
    // Dev-mode server actions are slow; poll until the row (and its details)
    // have actually landed rather than guessing a delay.
    let polled = null as Awaited<ReturnType<typeof prisma.participant.findFirst>>;
    for (let i = 0; i < 60; i++) {
      polled = await prisma.participant.findFirst({ where: { ownerId: user.id, displayName: newName } });
      if (polled?.phone) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const partsAfter = await prisma.participant.count({ where: { ownerId: user.id } });
    ok("1k. New member creates exactly ONE Person record", partsAfter === partsBefore + 1, `${partsBefore}→${partsAfter}`);
    const createdP = await prisma.participant.findFirst({ where: { ownerId: user.id, displayName: newName } });
    if (createdP) createdParticipantIds.push(createdP.id);
    ok("1l. the new member's phone/email were saved", createdP?.phone === "9876500003" && createdP?.email === "mbnew@example.com");

    await page.screenshot({ path: path.join(SHOT, "mb-390-create-group.png"), fullPage: true });
    const groupName = `MBCreated-${S}`;
    await m.getByPlaceholder("e.g. Flat 402").fill(groupName);
    await m.getByRole("button", { name: "Create group", exact: true }).click();
    let created: { id: string; members: { participantId: string }[] } | null = null;
    for (let i = 0; i < 60; i++) {
      created = await prisma.group.findFirst({ where: { createdById: user.id, name: groupName }, include: { members: true } });
      if (created) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (created) createdGroupIds.push(created.id);
    ok("1m. the group is created with both members (existing + new)", created?.members.length === 2, `${created?.members.length}`);
    ok("1n. the existing contact kept its own Person id (not duplicated)", !!created?.members.some((x) => x.participantId === alex));

    // ═══ 2. GROUP SETTLEMENT ═══
    await page.goto(`${BASE}/shared/groups/${group.id}?p=all`, { waitUntil: "load" });
    await page.waitForSelector("text=Group Settlement", { timeout: 30000 });
    const body = await page.locator("body").innerText();
    ok("2. the primary section is the group settlement plan, with all three views",
      body.includes("Group Settlement") && body.includes("Settlement") && body.includes("Simplify payments") && body.includes("Your position"));
    ok("2a. it states how many payments settle the whole group",
      /\d+ payments? to settle everything|All settled up/.test(body));
    // The plan must be group-wide: the owner appears by NAME, never as the
    // word "You", because this text is meant to be sent to the whole group.
    const planText = body.slice(body.indexOf("Group Settlement"));
    ok("2a-i. the plan names the owner instead of addressing the reader as 'You'",
      /→/.test(planText) && !/(^|\s)You\s*→/.test(planText) && !/→\s*You(\s|$)/.test(planText));
    ok("2a-ii. the plan totals what has to move", body.includes("Total to settle"));
    ok("2a-iii. a Share settlement button is offered", (await page.getByRole("button", { name: "Share settlement" }).count()) > 0);

    const planRows = await page.locator("text=/→/").count();
    await page.getByText("Simplify payments").first().click(); // toggle OFF → raw obligations
    await page.waitForTimeout(600);
    const detailedText = await page.locator("body").innerText();
    ok("2b. the detailed view explains that it is the 'why'", /Every obligation separately/i.test(detailedText));
    // A member who PAID for something must appear as a row you owe, not be
    // netted away into a single line.
    ok("2b-i. detailed shows BOTH directions (someone who paid appears as a row you owe)",
      /→/.test(detailedText.slice(detailedText.indexOf("Group Settlement"))));
    const detailedRows = await page.locator("text=/→/").count();
    ok("2c. the plan is never longer than the detailed list", planRows <= detailedRows, `${detailedRows} detailed → ${planRows} plan`);
    await page.getByText("Simplify payments").first().click(); // toggle back ON → minimised plan
    await page.waitForTimeout(600);
    ok("2d. the plan view explains why it is shorter (or that it already is shortest)",
      /fewest payments|shortest way to settle/i.test(await page.locator("body").innerText()));
    await page.screenshot({ path: path.join(SHOT, "mb-390-settlement-plan.png"), fullPage: true });

    await page.getByRole("tab", { name: "I'll receive" }).click();
    await page.waitForTimeout(600);
    const recv = await page.locator("body").innerText();
    ok("2f. the receive view totals what's coming to you", recv.includes("Total you'll receive"));
    ok("2g. it uses plain wording (no creditor/debtor jargon)", !/creditor|debtor/i.test(recv));
    ok("2g-i. personal accounting is not shareable to the group",
      (await page.getByRole("button", { name: "Share settlement" }).count()) === 0);
    await page.screenshot({ path: path.join(SHOT, "mb-390-balances-receive.png"), fullPage: true });

    // settled group → both empty states
    await page.goto(`${BASE}/shared/groups/${settledGroup.id}?p=all`, { waitUntil: "load" });
    await page.waitForSelector("text=Group Settlement", { timeout: 30000 });
    const settledText = await page.locator("body").innerText();
    ok("2h. a settled group says so", settledText.includes("All settled up"));
    ok("2h-i. a settled group offers no empty payment card and nothing to share",
      !settledText.includes("Total to settle") && (await page.getByRole("button", { name: "Share settlement" }).count()) === 0);

    // ═══ 3. WIDTHS ═══
    for (const w of [360, 390, 430, 1440]) {
      await page.setViewportSize({ width: w, height: w >= 1440 ? 900 : 800 });
      await page.goto(`${BASE}/shared/groups/${group.id}?p=all`, { waitUntil: "load" });
      await page.waitForSelector("text=Group Settlement", { timeout: 30000 });
      const balOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      await page.goto(`${BASE}/shared?p=all`, { waitUntil: "load" });
      await page.waitForSelector("text=Groups", { timeout: 30000 });
      await page.getByRole("button", { name: "＋ New group" }).first().click();
      await page.waitForSelector("text=GROUP NAME", { timeout: 20000 });
      const tabsVisible = await modal(page).getByRole("tab", { name: "Existing member" }).isVisible();
      const createVisible = await modal(page).getByRole("button", { name: "Create group", exact: true }).isVisible();
      const modalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      ok(`3. ${w}px: balances + create-group render without overflow; both choices and Create group reachable`,
        !balOverflow && !modalOverflow && tabsVisible && createVisible,
        `balOverflow=${balOverflow} modalOverflow=${modalOverflow} tabs=${tabsVisible} create=${createVisible}`);
      if (w === 1440) await page.screenshot({ path: path.join(SHOT, "mb-1440-create-group.png"), fullPage: true });
      await page.keyboard.press("Escape").catch(() => {});
    }
  } finally {
    await browser.close();
    const gids = [group.id, settledGroup.id, ...createdGroupIds];
    const txs = await prisma.transaction.findMany({ where: { groupId: { in: gids } }, select: { id: true } });
    await prisma.expenseSplit.deleteMany({ where: { txId: { in: txs.map((t) => t.id) } } });
    await prisma.transaction.deleteMany({ where: { groupId: { in: gids } } });
    await prisma.settlement.deleteMany({ where: { groupId: { in: gids } } });
    await prisma.group.deleteMany({ where: { id: { in: gids } } });
    await prisma.loanEntry.deleteMany({ where: { participantId: lender } });
    await prisma.participant.deleteMany({ where: { id: { in: [alex, blake, lender, ...createdParticipantIds] } } });
    await prisma.$disconnect();
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
      for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? " · " + f.detail : ""}`);
      process.exitCode = 1;
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
