// The Simplify payments control, and the state that hid it.
//
// Reported as "P1 removed the toggle when it split the card into Your position
// + Settle up". It did not — the control and its `settled` gate are unchanged
// since before P1. What hid it was the gate itself, which has always read:
//
//     const settled = plan.length === 0;
//
// A group settled THROUGH the owner squares every member's net without
// discharging the member↔member obligations it settled, so computeSuggestions()
// returns nothing while real obligations remain. The whole Settle up body then
// collapsed to "All settled up", taking the toggle with it — exactly when it
// was the only way to see those obligations. P1 made this visible rather than
// causing it: "Who with?" now lists the obligations the old layout never showed.
//
// So this drives BOTH shapes through the real UI: an ordinary group where the
// two readings differ, and a zero-sum cycle where the plan is empty and the
// obligations are not.

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { randomUUID } from "node:crypto";
import { auth } from "../src/server/auth";
import { prisma } from "../src/server/db";

const BASE = "http://localhost:3000";
const PASSWORD = "ledgerly-demo";
const rup = (n: number) => Math.round(n * 100);

const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? ` · ${detail}` : ""}`);
};

async function sessionCookies(email: string) {
  const result = (await auth.api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true })) as { headers: Headers };
  const setCookie = result.headers.getSetCookie ? result.headers.getSetCookie() : [];
  return setCookie.map((sc) => {
    const pair = sc.split(";")[0];
    const idx = pair.indexOf("=");
    return { name: pair.slice(0, idx), value: pair.slice(idx + 1), domain: "localhost", path: "/" };
  });
}

async function newSession(browser: Browser, email: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addCookies(await sessionCookies(email));
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  return { ctx, page };
}

const settleUp = (page: Page) => page.locator("section", { hasText: "Settle up" }).first();
const position = (page: Page) => page.locator("section", { hasText: "Your position" }).first();
const toggle = (page: Page) => settleUp(page).getByRole("switch", { name: /Simplify/i }).first();

async function openGroup(page: Page, groupId: string) {
  await page.goto(`${BASE}/shared/groups/${groupId}?p=all`, { waitUntil: "load" });
  await page.waitForSelector("text=Settle up", { timeout: 30000 });
}

/** The arrow rows currently listed under Settle up, and what can act on them. */
async function readPlan(page: Page) {
  const card = settleUp(page);
  const rows = (await card.locator("div.bg-side").allInnerTexts())
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter((t) => /→/.test(t) && /₹/.test(t))
    .map((t) => t.replace(/you(?=\s*(→|₹))/g, "").replace(/\s*Settle\s*$/i, "").replace(/\s+/g, " ").trim());
  return {
    rows,
    settleButtons: await card.getByRole("button", { name: "Settle", exact: true }).count(),
    text: await card.innerText(),
  };
}

/** The three figures in Your position — these must not move when toggling. */
async function readPosition(page: Page) {
  const t = await position(page).innerText();
  return (t.match(/₹[\d,.]+|—/g) ?? []).join(" ");
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const suffix = randomUUID().slice(0, 8);
  const ownerEmail = `sc-owner-${suffix}@test.local`;
  const anaEmail = `sc-ana-${suffix}@test.local`;
  const created: string[] = [];
  const ctxs: BrowserContext[] = [];

  try {
    await auth.api.signUpEmail({ body: { name: "Olivia Owner", email: ownerEmail, password: PASSWORD } });
    await auth.api.signUpEmail({ body: { name: "Ana Account", email: anaEmail, password: PASSWORD } });
    const owner = await prisma.user.findFirstOrThrow({ where: { email: ownerEmail } });
    const ana = await prisma.user.findFirstOrThrow({ where: { email: anaEmail } });

    const mk = (displayName: string, linkedUserId?: string) =>
      prisma.participant.create({ data: { ownerId: owner.id, displayName, linkedUserId } });
    const pAna = await mk("Ana", ana.id);
    const pBen = await mk("Ben");
    const pCara = await mk("Cara");

    const makeGroup = async (name: string) => {
      const g = await prisma.group.create({
        data: {
          name: `${name}-${suffix}`,
          createdById: owner.id,
          members: { create: [pAna, pBen, pCara].map((p) => ({ participantId: p.id })) },
        },
      });
      created.push(g.id);
      return g.id;
    };
    const expense = (groupId: string, amount: number, paidBy: string | null, shares: [string | null, number][]) =>
      prisma.transaction.create({
        data: {
          userId: owner.id, type: "EXPENSE", amount: rup(amount), merchant: "Bill",
          occurredAt: new Date(), groupId, paidByParticipantId: paidBy,
          splits: { create: shares.map(([participantId, owed]) => ({ participantId, owedAmount: rup(owed) })) },
        },
      });

    // ── Group 1: the two readings genuinely differ, and Ana fronts a bill so
    //    member↔member obligations exist.
    const trip = await makeGroup("Trip");
    await expense(trip, 400, null, [[null, 100], [pAna.id, 100], [pBen.id, 100], [pCara.id, 100]]);
    await expense(trip, 600, pAna.id, [[null, 150], [pAna.id, 150], [pBen.id, 150], [pCara.id, 150]]);
    await expense(trip, 200, pBen.id, [[null, 20], [pAna.id, 60], [pBen.id, 50], [pCara.id, 70]]);

    // ── Group 2: everyone settles THROUGH the owner. Every net lands on zero,
    //    so the plan is empty while the obligations behind it are not — the
    //    shape that hid the control in production.
    const cycle = await makeGroup("Cycle");
    await expense(cycle, 400, pAna.id, [[null, 100], [pAna.id, 100], [pBen.id, 100], [pCara.id, 100]]);
    const { recordSettlement } = await import("../src/server/services/shared");
    await recordSettlement(owner.id, pAna.id, "FROM_OWNER", rup(300), "CASH", undefined, cycle);
    await recordSettlement(owner.id, pBen.id, "TO_OWNER", rup(100), "CASH", undefined, cycle);
    await recordSettlement(owner.id, pCara.id, "TO_OWNER", rup(100), "CASH", undefined, cycle);

    // ═══════ 1. THE CONTROL EXISTS, AND STARTS ON ═══════
    const { ctx: ownerCtx, page } = await newSession(browser, ownerEmail);
    ctxs.push(ownerCtx);
    await openGroup(page, trip);

    ok("1a. the Simplify control is rendered", (await toggle(page).count()) === 1);
    ok("1b. it lives in Settle up, not Your position", (await position(page).getByRole("switch").count()) === 0);
    ok("1c. it defaults to ON, as before P1", (await toggle(page).getAttribute("aria-checked")) === "true");

    // ═══════ 2. TOGGLING CHANGES THE DATA, NOT JUST THE SWITCH ═══════
    const onState = await readPlan(page);
    const onPosition = await readPosition(page);
    const headlineCount = Number((onState.text.match(/(\d+) payments? to settle everything/) ?? [])[1] ?? -1);

    await toggle(page).dispatchEvent("click");
    await page.waitForTimeout(600);
    const offState = await readPlan(page);
    const offPosition = await readPosition(page);

    ok("2a. Simplify ON lists exactly the minimised plan", onState.rows.length === headlineCount, `${onState.rows.length} rows, headline says ${headlineCount}`);
    ok("2b. Simplify OFF lists more rows — the raw obligations", offState.rows.length > onState.rows.length, `${onState.rows.length} → ${offState.rows.length}`);
    ok("2c. the rows themselves differ, so this is data and not decoration", JSON.stringify(onState.rows) !== JSON.stringify(offState.rows));
    ok("2d. OFF says it is showing every obligation", /every obligation separately/i.test(offState.text));
    ok("2e. ON explains what it collapsed", /fewer payments?|already the fewest/i.test(onState.text));
    ok("2f. the switch reports its new state", (await toggle(page).getAttribute("aria-checked")) === "false");

    // ═══════ 3. THE BALANCES UNDERNEATH DO NOT MOVE ═══════
    ok("3a. Your position is identical in both readings", onPosition === offPosition, `${onPosition} vs ${offPosition}`);
    ok("3b. Your position never gains Settle buttons", (await position(page).getByRole("button", { name: "Settle", exact: true }).count()) === 0);

    // ═══════ 4. BOTH READINGS STAY ACTIONABLE FOR THE OWNER ═══════
    ok("4a. Simplify OFF keeps Settle on its rows", offState.settleButtons > 0, `${offState.settleButtons} buttons`);
    ok("4b. Simplify ON keeps Settle on its rows", onState.settleButtons > 0, `${onState.settleButtons} buttons`);
    const memberRow = settleUp(page).getByRole("button", { name: /^Settle \w+ pays \w+$/ });
    ok("4c. member↔member rows are actionable with Simplify OFF", (await memberRow.count()) > 0, `${await memberRow.count()} member→member rows`);
    await toggle(page).dispatchEvent("click");
    await page.waitForTimeout(600);
    ok("4d. and with Simplify ON", (await settleUp(page).getByRole("button", { name: /^Settle \w+ pays \w+$/ }).count()) > 0);

    // ═══════ 5. A LINKED MEMBER GETS THE SAME CONTROL, NO ACTIONS ═══════
    const { ctx: anaCtx, page: anaPage } = await newSession(browser, anaEmail);
    ctxs.push(anaCtx);
    await openGroup(anaPage, trip);
    ok("5a. a linked member sees the control too", (await toggle(anaPage).count()) === 1);
    const anaOn = await readPlan(anaPage);
    await toggle(anaPage).dispatchEvent("click");
    await anaPage.waitForTimeout(600);
    const anaOff = await readPlan(anaPage);
    ok("5b. it switches their rows as well", anaOff.rows.length > anaOn.rows.length, `${anaOn.rows.length} → ${anaOff.rows.length}`);
    ok("5c. a member sees the same economics as the owner", JSON.stringify(anaOff.rows) === JSON.stringify(offState.rows));
    ok("5d. but can act in neither reading", anaOn.settleButtons === 0 && anaOff.settleButtons === 0);

    // ═══════ 6. THE REGRESSION: A ZERO-SUM CYCLE ═══════
    await openGroup(page, cycle);
    const cycleOn = await readPlan(page);
    ok("6a. the control is rendered even though the plan is empty", (await toggle(page).count()) === 1);
    ok("6b. Simplify ON has no payments to make", cycleOn.rows.length === 0);
    ok("6c. it does not claim everyone is square", !/Everyone in this group is settled up/i.test(cycleOn.text), cycleOn.text.split("\n").slice(0, 4).join(" | "));
    ok("6d. it says the obligations cancel out and points at the control", /cancel each other out/i.test(cycleOn.text) && /Turn off Simplify/i.test(cycleOn.text));

    await toggle(page).dispatchEvent("click");
    await page.waitForTimeout(600);
    const cycleOff = await readPlan(page);
    ok("6e. Simplify OFF reveals the obligations that were unreachable", cycleOff.rows.length > 0, `${cycleOff.rows.length} rows`);
    // 6f. KNOWN BOUNDARY, asserted so it cannot change unnoticed. Revealing the
    // rows does not make them settleable: the owner-to-member Settle affordance
    // is keyed to the member's NET (`Math.abs(net) > SETTLED_THRESHOLD`) and
    // prefills the form with that net, which is zero for every member here. A
    // button would offer to settle 0. Making these actionable means recording
    // against the gross obligation instead of the net — a settlement-accounting
    // change, and the same fix as discharging the obligations properly.
    // Member-to-member rows are NOT affected by this and stay actionable (4c/4d).
    // Member-to-member buttons carry a pair-specific accessible name, so they
    // are NOT counted by the exact-"Settle" query above. Count them separately.
    const cycleMemberBtns = await settleUp(page).getByRole("button", { name: /^Settle .+ pays .+$/ }).count();
    ok("6f. member-to-member rows stay actionable even in a squared group",
      cycleMemberBtns > 0, `${cycleMemberBtns} member→member buttons`);
    ok("6f-i. owner-to-member rows there are read-only, pending the discharge fix",
      cycleOff.settleButtons === 0, `${cycleOff.settleButtons} owner-directed buttons — the affordance keys off the member's net, which is zero here`);
    // A cycle ALWAYS contains member-to-member obligations. If every obligation
    // ran through the owner and every net were zero, each owner-member pair
    // would net to nothing and there would be no rows at all — contradicting
    // detailed.length > 0. So the viewer always has at least one row they can
    // act on here, even though their own owner-directed rows are informational.
    ok("6g. a cycle necessarily exposes member-to-member work, never a dead end",
      cycleMemberBtns > 0 && cycleOff.rows.length > cycleMemberBtns,
      `${cycleOff.rows.length} rows, ${cycleMemberBtns} actionable`);
    ok("6h. the rows still state the real amounts, so nothing is concealed",
      cycleOff.rows.every((r) => /₹/.test(r)) && cycleOff.rows.length === 5, cycleOff.rows.join(" | "));
  } catch (e) {
    ok("script error", false, String(e).slice(0, 300));
  } finally {
    for (const ctx of ctxs) await ctx.close().catch(() => {});
    for (const id of created) {
      await prisma.settlement.deleteMany({ where: { groupId: id } }).catch(() => {});
      await prisma.transaction.deleteMany({ where: { groupId: id } }).catch(() => {});
      await prisma.group.delete({ where: { id } }).catch(() => {});
    }
    await prisma.user.deleteMany({ where: { email: { in: [ownerEmail, anaEmail] } } }).catch(() => {});
    await prisma.$disconnect();
    await browser.close();
  }
}

main().then(() => {
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
});
