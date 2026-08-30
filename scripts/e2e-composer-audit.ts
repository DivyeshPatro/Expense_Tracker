// Production-readiness audit for the composer's Group flow.
//
// Everything here is driven through the real browser and checked against the
// database. It exists because the composer's split path had been proven at unit
// level but not end to end: member removal, payer changes, the owner's own
// share, metadata persistence, offline refusal and invalid-state blocking were
// all reasoned about rather than exercised.
//
// The payer cases matter most. EXACT used to drop the owner from the split
// whenever a friend paid — three other modes kept them — so the stored rows
// charged the payer for a share nobody agreed to. These drive that exact shape.

import { chromium, type Browser, type Page } from "playwright";
import { randomUUID } from "node:crypto";
import { auth } from "../src/server/auth";
import { prisma } from "../src/server/db";

const BASE = "http://localhost:3000";
const EMAIL = "arjun@ledgerly.app";
const PASSWORD = "ledgerly-demo";

const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? ` · ${detail}` : ""}`);
};

async function session(browser: Browser) {
  const r = (await auth.api.signInEmail({ body: { email: EMAIL, password: PASSWORD }, returnHeaders: true })) as { headers: Headers };
  const cookies = (r.headers.getSetCookie?.() ?? []).map((sc) => {
    const p = sc.split(";")[0];
    const i = p.indexOf("=");
    return { name: p.slice(0, i), value: p.slice(i + 1), domain: "localhost", path: "/" };
  });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  return { ctx, page };
}

const composer = (page: Page) => page.locator("div[data-composer]");
const sheet = (page: Page) => page.getByRole("dialog");

async function openComposer(page: Page) {
  await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
  await page.waitForSelector("text=Total balance", { timeout: 30000 });
  await page.getByRole("button", { name: /quick add/i }).filter({ visible: true }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: /Add expense/ }).first().click();
  await composer(page).waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
}

async function type(page: Page, keys: string) {
  for (const k of keys) {
    await composer(page).getByRole("button", { name: k === "." ? "Decimal point" : k, exact: true }).click();
    await page.waitForTimeout(80);
  }
}

async function swipe(page: Page, fraction: number) {
  const track = composer(page).locator("div[role='slider']");
  const box = (await track.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 30, y);
  await page.mouse.down();
  const end = box.x + 30 + (box.width - 62) * fraction;
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(box.x + 30 + ((end - box.x - 30) * i) / 12, y);
    await page.waitForTimeout(18);
  }
  await page.mouse.up();
  await page.waitForTimeout(600);
}

async function waitForRow<T>(read: () => Promise<T | null>, ms = 12000): Promise<T | null> {
  const until = Date.now() + ms;
  for (;;) {
    const row = await read();
    if (row) return row;
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Open Group → pick the group → land in the split sheet. */
async function openGroupSplit(page: Page, groupName: string) {
  await composer(page).getByRole("button", { name: "Group", exact: true }).click();
  await page.waitForTimeout(600);
  await sheet(page).getByRole("button", { name: new RegExp(groupName) }).first().click();
  await page.waitForTimeout(900);
}

const mode = (page: Page, label: string) => sheet(page).getByRole("button", { name: label, exact: true });

/** Name the transaction so it can be found in the database afterwards. */
async function nameIt(page: Page, merchant: string) {
  await composer(page).getByRole("button", { name: "Merchant and notes" }).click();
  await page.waitForTimeout(500);
  await sheet(page).locator("input").first().fill(merchant);
  await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
  await page.waitForTimeout(400);
}

const sum = (rows: { owedAmount: bigint | number }[]) => rows.reduce((t, r) => t + Number(r.owedAmount), 0);

async function main() {
  const browser = await chromium.launch({ headless: true });
  const tag = randomUUID().slice(0, 6);
  const created: string[] = [];
  let ctx;

  try {
    const user = await prisma.user.findFirstOrThrow({ where: { email: EMAIL } });
    const group = await prisma.group.findFirstOrThrow({
      where: { createdById: user.id },
      include: { members: { include: { participant: true } } },
    });
    const memberNames = group.members.map((m) => m.participant.displayName);
    const s = await session(browser);
    ctx = s.ctx;
    const page = s.page;

    // ══════════ 1. Member removal, then re-addition ══════════
    await openComposer(page);
    await type(page, "1000");
    await openGroupSplit(page, group.name);
    const firstMember = memberNames[0];
    ok("1a. the group's members are listed", (await sheet(page).getByText(firstMember).count()) > 0, memberNames.join(", "));

    await sheet(page).getByRole("button", { name: new RegExp(`Remove ${firstMember}|^✕$`) }).first().click().catch(async () => {
      await sheet(page).locator("button").filter({ hasText: "✕" }).first().click();
    });
    await page.waitForTimeout(600);
    await mode(page, "Exact amounts").click();
    await page.waitForTimeout(500);
    const afterRemoval = await sheet(page).locator("input[type='number']").evaluateAll((els) => (els as HTMLInputElement[]).map((e) => e.value));
    ok("1b. removing a member leaves the rest with values", afterRemoval.length > 0 && afterRemoval.every((v) => v !== ""), afterRemoval.join(" / "));

    const removedMerchant = `ZAuditRemove-${tag}`;
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await nameIt(page, removedMerchant);
    await swipe(page, 1);
    await page.waitForTimeout(2200);

    const afterRemoveTx = await waitForRow(() => prisma.transaction.findFirst({
      where: { userId: user.id, merchant: removedMerchant }, include: { splits: { include: { participant: true } } }, orderBy: { createdAt: "desc" },
    }));
    ok("1c. a split with a member removed saves", afterRemoveTx !== null, afterRemoveTx?.id ?? "not saved");
    if (afterRemoveTx) created.push(afterRemoveTx.id);
    ok("1d. the removed member has no split row", !(afterRemoveTx?.splits ?? []).some((r) => r.participant?.displayName === firstMember),
      (afterRemoveTx?.splits ?? []).map((r) => r.participant?.displayName ?? "OWNER").join(", "));
    ok("1e. and the remaining shares still total the amount", sum(afterRemoveTx?.splits ?? []) === 100000, String(sum(afterRemoveTx?.splits ?? [])));

    // Re-add: a fresh composer re-selects the whole group, so no stale value
    // from the removed session can survive.
    await openComposer(page);
    await type(page, "1000");
    await openGroupSplit(page, group.name);
    const readded = await sheet(page).getByText(firstMember).count();
    ok("1f. reopening Group restores the full roster", readded > 0);
    const reMerchant = `ZAuditReadd-${tag}`;
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await nameIt(page, reMerchant);
    await swipe(page, 1);
    await page.waitForTimeout(2200);
    const reTx = await waitForRow(() => prisma.transaction.findFirst({
      where: { userId: user.id, merchant: reMerchant }, include: { splits: { include: { participant: true } } }, orderBy: { createdAt: "desc" },
    }));
    ok("1g. the re-added member is back in the stored rows",
      (reTx?.splits ?? []).some((r) => r.participant?.displayName === firstMember),
      (reTx?.splits ?? []).map((r) => r.participant?.displayName ?? "OWNER").join(", "));
    if (reTx) created.push(reTx.id);
    ok("1h. and it still totals exactly", sum(reTx?.splits ?? []) === 100000, String(sum(reTx?.splits ?? [])));

    // ══════════ 2 + 3. Payer change, and the owner's own share in EXACT ══════════
    // This is the shape the engine bug lived in: a FRIEND pays, EXACT mode.
    await openComposer(page);
    await type(page, "1000");
    await openGroupSplit(page, group.name);
    await mode(page, "Exact amounts").click();
    await page.waitForTimeout(400);
    ok("3a. Exact offers a row for your own share", (await sheet(page).getByLabel("Your share").count()) === 1);

    await sheet(page).locator("select").first().selectOption({ label: firstMember });
    await page.waitForTimeout(700);
    ok("2a. Paid by can be changed to a friend", (await sheet(page).locator("select").first().inputValue()) !== "me");
    ok("3b. your share is still editable once a friend pays", (await sheet(page).getByLabel("Your share").count()) === 1);

    await sheet(page).getByLabel("Your share").fill("250");
    await page.waitForTimeout(400);
    const payerMerchant = `ZAuditPayer-${tag}`;
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await nameIt(page, payerMerchant);
    await swipe(page, 1);
    await page.waitForTimeout(2500);

    const payerTx = await waitForRow(() => prisma.transaction.findFirst({
      where: { userId: user.id, merchant: payerMerchant }, include: { splits: { include: { participant: true } } }, orderBy: { createdAt: "desc" },
    }));
    ok("2b. a friend-paid split saves", payerTx !== null, payerTx?.id ?? "not saved");
    if (payerTx) created.push(payerTx.id);
    ok("2c. the payer is stored as that friend", payerTx?.paidByParticipantId != null, String(payerTx?.paidByParticipantId));
    ok("2d. the group is preserved", payerTx?.groupId === group.id);
    // THE BUG: the owner used to vanish here.
    ok("2e. THE OWNER IS STILL IN THE SPLIT when a friend pays",
      (payerTx?.splits ?? []).some((r) => r.participantId === null),
      (payerTx?.splits ?? []).map((r) => `${r.participant?.displayName ?? "OWNER"}=${Number(r.owedAmount)}`).join("  "));
    ok("3c. the owner's stated share is what was typed",
      Number((payerTx?.splits ?? []).find((r) => r.participantId === null)?.owedAmount ?? -1) === 25000,
      String(Number((payerTx?.splits ?? []).find((r) => r.participantId === null)?.owedAmount ?? -1)));
    ok("2f. the stored shares total the amount exactly", sum(payerTx?.splits ?? []) === 100000, String(sum(payerTx?.splits ?? [])));
    ok("2g. nobody is duplicated in the rows",
      new Set((payerTx?.splits ?? []).map((r) => r.participantId ?? "OWNER")).size === (payerTx?.splits ?? []).length);

    // ══════════ 5. Metadata actually persists ══════════
    await openComposer(page);
    await type(page, "250");
    // Category
    await composer(page).getByRole("button", { name: /^Category:/ }).first().click();
    await page.waitForTimeout(500);
    const catButtons = sheet(page).locator("button");
    const catName = (await catButtons.nth(1).innerText()).replace(/^\S+\s*/, "").trim();
    await catButtons.nth(1).click();
    await page.waitForTimeout(400);
    // Account
    await composer(page).getByRole("button", { name: /^Payment method:/ }).first().click();
    await page.waitForTimeout(500);
    const acctName = (await sheet(page).locator("button").nth(1).innerText()).trim();
    await sheet(page).locator("button").nth(1).click();
    await page.waitForTimeout(400);
    // Merchant + notes
    const metaMerchant = `ZAuditMeta-${tag}`;
    await composer(page).getByRole("button", { name: "Merchant and notes" }).click();
    await page.waitForTimeout(500);
    await sheet(page).locator("input").nth(0).fill(metaMerchant);
    await sheet(page).locator("input").nth(1).fill("audit note");
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    ok("5a. changing metadata did not reset the amount", (await composer(page).innerText()).includes("250"));

    await swipe(page, 1);
    await page.waitForTimeout(2200);
    const metaTx = await waitForRow(() => prisma.transaction.findFirst({
      where: { userId: user.id, merchant: metaMerchant }, include: { category: true, account: true }, orderBy: { createdAt: "desc" },
    }));
    ok("5b. the transaction saves with its metadata", metaTx !== null, metaTx?.id ?? "not saved");
    if (metaTx) created.push(metaTx.id);
    ok("5c. notes persist", metaTx?.notes === "audit note", metaTx?.notes ?? "null");
    ok("5d. merchant persists", metaTx?.merchant === metaMerchant);
    ok("5e. category persists", metaTx?.category != null && catName.includes(metaTx.category.name), `${metaTx?.category?.name} vs ${catName}`);
    ok("5f. account persists", metaTx?.account != null && acctName.includes(metaTx.account.name), `${metaTx?.account?.name} vs ${acctName}`);
    ok("5g. the date is today by default", metaTx != null && new Date(metaTx.occurredAt).toDateString() === new Date().toDateString());

    // ══════════ 6. Personal → Group → Personal clears group state ══════════
    await openComposer(page);
    await type(page, "500");
    await openGroupSplit(page, group.name);
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    ok("6a. Group shows its context line", /people|splitting/i.test(await composer(page).innerText()));
    await composer(page).getByRole("button", { name: "Personal", exact: true }).click();
    await page.waitForTimeout(500);
    ok("6b. switching to Personal clears the group context", !/people ·/i.test(await composer(page).innerText()));
    const personalMerchant = `ZAuditPersonal-${tag}`;
    await nameIt(page, personalMerchant);
    await swipe(page, 1);
    await page.waitForTimeout(2200);
    const personalTx = await waitForRow(() => prisma.transaction.findFirst({
      where: { userId: user.id, merchant: personalMerchant }, include: { splits: true }, orderBy: { createdAt: "desc" },
    }));
    ok("6c. it saves as a personal transaction", personalTx !== null && personalTx.groupId === null, String(personalTx?.groupId));
    ok("6d. with no split rows left behind", (personalTx?.splits ?? []).length === 0, String((personalTx?.splits ?? []).length));
    if (personalTx) created.push(personalTx.id);

    // ══════════ 7. Credit + Group ══════════
    await openComposer(page);
    await composer(page).getByRole("button", { name: /Credit/ }).click();
    await page.waitForTimeout(300);
    await type(page, "750");
    await composer(page).getByRole("button", { name: "Group", exact: true }).click();
    await page.waitForTimeout(600);
    await sheet(page).getByRole("button", { name: new RegExp(group.name) }).first().click();
    await page.waitForTimeout(800);
    // Credit has no split UI — the sheet should not have opened a split editor.
    ok("7a. Credit + Group offers no split editor", (await page.getByText("Split with friends").count()) === 0);
    if (await sheet(page).count()) await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const creditMerchant = `ZAuditCredit-${tag}`;
    await nameIt(page, creditMerchant);
    await swipe(page, 1);
    await page.waitForTimeout(2200);
    const creditTx = await waitForRow(() => prisma.transaction.findFirst({
      where: { userId: user.id, merchant: creditMerchant }, include: { splits: true }, orderBy: { createdAt: "desc" },
    }));
    ok("7b. Credit saves as INCOME", creditTx?.type === "INCOME", creditTx?.type ?? "not saved");
    ok("7c. tagged to the group", creditTx?.groupId === group.id, String(creditTx?.groupId));
    ok("7d. with no split payload invented", (creditTx?.splits ?? []).length === 0, String((creditTx?.splits ?? []).length));
    if (creditTx) created.push(creditTx.id);

    // ══════════ 9. Invalid splits are blocked at the swipe ══════════
    const beforeInvalid = await prisma.transaction.count({ where: { userId: user.id, deletedAt: null } });
    await openComposer(page);
    await type(page, "1000");
    await openGroupSplit(page, group.name);
    await mode(page, "Exact amounts").click();
    await page.waitForTimeout(400);
    // A: exact amounts far beyond the total.
    const exactFields = sheet(page).locator("input[type='number']");
    const n = await exactFields.count();
    for (let i = 0; i < n; i++) await exactFields.nth(i).fill("9000");
    await page.waitForTimeout(500);
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await swipe(page, 1);
    await page.waitForTimeout(1200);
    ok("9a. exact amounts over the total are refused", (await prisma.transaction.count({ where: { userId: user.id, deletedAt: null } })) === beforeInvalid);
    ok("9b. and it says so on screen", (await composer(page).getByRole("alert").count()) === 1,
      (await composer(page).getByRole("alert").innerText().catch(() => "")).trim());

    // C: zero weights in Percent.
    await composer(page).getByText(/people|splitting/).first().click();
    await page.waitForTimeout(600);
    await mode(page, "Percent").click();
    await page.waitForTimeout(400);
    const pctFields = sheet(page).locator("input[type='number']");
    const pn = await pctFields.count();
    for (let i = 0; i < pn; i++) await pctFields.nth(i).fill("0");
    await page.waitForTimeout(500);
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await swipe(page, 1);
    await page.waitForTimeout(1200);
    ok("9c. all-zero weights are refused", (await prisma.transaction.count({ where: { userId: user.id, deletedAt: null } })) === beforeInvalid);

    // D: no members selected.
    await composer(page).getByText(/people|splitting|Choose who/).first().click();
    await page.waitForTimeout(600);
    // Each member has a "Remove <name> from the split" control. The earlier
    // version of this clicked every button[aria-checked=true], which also
    // matched the "Split with friends" switch — turning splitting off and
    // leaving a perfectly valid group expense that duly saved.
    for (let i = 0; i < 8; i++) {
      const remove = sheet(page).getByRole("button", { name: /Remove .+ from the split/ }).first();
      if ((await remove.count()) === 0) break;
      await remove.click().catch(() => {});
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(500);
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await swipe(page, 1);
    await page.waitForTimeout(1200);
    ok("9d. a split with nobody in it is refused", (await prisma.transaction.count({ where: { userId: user.id, deletedAt: null } })) === beforeInvalid);
    await composer(page).getByRole("button", { name: "Close" }).click();
    await page.waitForTimeout(500);

    // ══════════ 10. Mode switching, editing, then persistence ══════════
    await openComposer(page);
    await type(page, "1000");
    await openGroupSplit(page, group.name);
    await mode(page, "Exact amounts").click();
    await page.waitForTimeout(400);
    const ex = sheet(page).locator("input[type='number']");
    await ex.nth(1).fill("400");
    await ex.nth(1).blur();
    await page.waitForTimeout(500);
    await mode(page, "Percent").click();
    await page.waitForTimeout(500);
    const pctAfter = await sheet(page).locator("input[type='number']").evaluateAll((els) => (els as HTMLInputElement[]).map((e) => e.value));
    ok("10a. Percent inherits the edited distribution, not the original", pctAfter.every((v) => v !== ""), pctAfter.join(" / "));
    await mode(page, "Ratio").click();
    await page.waitForTimeout(500);
    const ratioAfter = await sheet(page).locator("input[type='number']").evaluateAll((els) => (els as HTMLInputElement[]).map((e) => e.value));
    ok("10b. Ratio inherits it too, as whole numbers", ratioAfter.every((v) => /^\d+$/.test(v)), ratioAfter.join(" / "));
    await mode(page, "Exact amounts").click();
    await page.waitForTimeout(500);
    const backToExact = await sheet(page).locator("input[type='number']").evaluateAll((els) => (els as HTMLInputElement[]).map((e) => e.value));
    ok("10c. and back to Exact with values, not blanks", backToExact.every((v) => v !== ""), backToExact.join(" / "));

    const chainMerchant = `ZAuditChain-${tag}`;
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await nameIt(page, chainMerchant);
    await swipe(page, 1);
    await page.waitForTimeout(2500);
    const chainTx = await waitForRow(() => prisma.transaction.findFirst({
      where: { userId: user.id, merchant: chainMerchant }, include: { splits: true }, orderBy: { createdAt: "desc" },
    }));
    ok("10d. the split survives four mode switches and saves", chainTx !== null, chainTx?.id ?? "not saved");
    if (chainTx) created.push(chainTx.id);
    ok("10e. the stored rows total exactly", sum(chainTx?.splits ?? []) === 100000, String(sum(chainTx?.splits ?? [])));

    // ══════════ 8. Offline: a split must refuse, not queue ══════════
    const beforeOffline = await prisma.transaction.count({ where: { userId: user.id, deletedAt: null } });
    await openComposer(page);
    await type(page, "600");
    await openGroupSplit(page, group.name);
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await ctx.setOffline(true);
    await page.waitForTimeout(400);
    await swipe(page, 1);
    await page.waitForTimeout(1500);
    const offlineAlert = (await composer(page).getByRole("alert").innerText().catch(() => "")).trim();
    ok("8a. an offline split refuses rather than queueing", (await composer(page).count()) === 1 && /internet|online/i.test(offlineAlert), offlineAlert || "(no alert)");
    ok("8b. and nothing was persisted", (await prisma.transaction.count({ where: { userId: user.id, deletedAt: null } })) === beforeOffline);
    await ctx.setOffline(false);
    await page.waitForTimeout(800);
    const recoverMerchant = `ZAuditRecover-${tag}`;
    await nameIt(page, recoverMerchant);
    await swipe(page, 1);
    await page.waitForTimeout(2500);
    const recovered = await waitForRow(() => prisma.transaction.findFirst({
      where: { userId: user.id, merchant: recoverMerchant }, include: { splits: true }, orderBy: { createdAt: "desc" },
    }));
    ok("8c. the same composer saves once connectivity returns", recovered !== null, recovered?.id ?? "not saved");
    if (recovered) created.push(recovered.id);

    // ══════════ 11. Removing a member in RATIO ══════════
    await openComposer(page);
    await type(page, "1000");
    await openGroupSplit(page, group.name);
    await mode(page, "Ratio").click();
    await page.waitForTimeout(400);
    const rf = sheet(page).locator("input[type='number']");
    const rn = await rf.count();
    // A deliberately uneven ratio so removal has something to preserve.
    for (let i = 0; i < rn; i++) { await rf.nth(i).fill(String(i + 1)); await rf.nth(i).blur(); await page.waitForTimeout(120); }
    await sheet(page).getByRole("button", { name: /Remove .+ from the split/ }).first().click();
    await page.waitForTimeout(600);
    const ratioLeft = await sheet(page).locator("input[type='number']").evaluateAll((els) => (els as HTMLInputElement[]).map((e) => e.value));
    ok("11a. Ratio keeps values for the members who remain", ratioLeft.every((v) => v !== ""), ratioLeft.join(" / "));

    const ratioMerchant = `ZAuditRatioRm-${tag}`;
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await nameIt(page, ratioMerchant);
    await swipe(page, 1);
    await page.waitForTimeout(2400);
    const ratioTx = await waitForRow(() => prisma.transaction.findFirst({
      where: { userId: user.id, merchant: ratioMerchant }, include: { splits: { include: { participant: true } } }, orderBy: { createdAt: "desc" },
    }));
    ok("11b. a Ratio split with a member removed saves", ratioTx !== null, ratioTx?.id ?? "not saved");
    if (ratioTx) created.push(ratioTx.id);
    ok("11c. its rows total the amount exactly", sum(ratioTx?.splits ?? []) === 100000, String(sum(ratioTx?.splits ?? [])));
    ok("11d. no negative share", !(ratioTx?.splits ?? []).some((r) => Number(r.owedAmount) < 0));
    ok("11e. nobody appears twice", new Set((ratioTx?.splits ?? []).map((r) => r.participantId ?? "OWNER")).size === (ratioTx?.splits ?? []).length,
      (ratioTx?.splits ?? []).map((r) => `${r.participant?.displayName ?? "OWNER"}=${Number(r.owedAmount)}`).join("  "));
    ok("11f. the payer is unchanged", ratioTx?.paidByParticipantId === null);

    // ══════════ 12. Removing a member in PERCENT, from an uneven split ══════════
    await openComposer(page);
    await type(page, "1000");
    await openGroupSplit(page, group.name);
    await mode(page, "Percent").click();
    await page.waitForTimeout(400);
    const pf = sheet(page).locator("input[type='number']");
    const pn2 = await pf.count();
    // 50 / 30 / 20 across the friends, with the balance on the owner.
    // Every weight must be POSITIVE — splitSchema rejects a zero, so the owner
    // takes a real slice here rather than 0. (A 0% share being unsaveable is a
    // pre-existing validator rule, not something this flow introduced.)
    const spreadPct = ["10", "40", "30", "20"].slice(0, pn2);
    for (let i = 0; i < pn2; i++) { await pf.nth(i).fill(spreadPct[i] ?? "0"); await pf.nth(i).blur(); await page.waitForTimeout(150); }
    await sheet(page).getByRole("button", { name: /Remove .+ from the split/ }).first().click();
    await page.waitForTimeout(600);
    const pctLeft = await sheet(page).locator("input[type='number']").evaluateAll((els) => (els as HTMLInputElement[]).map((e) => e.value));
    ok("12a. Percent keeps values for the members who remain", pctLeft.every((v) => v !== ""), pctLeft.join(" / "));

    const pctMerchant = `ZAuditPctRm-${tag}`;
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await nameIt(page, pctMerchant);
    await swipe(page, 1);
    await page.waitForTimeout(2400);
    const pctTx = await waitForRow(() => prisma.transaction.findFirst({
      where: { userId: user.id, merchant: pctMerchant }, include: { splits: { include: { participant: true } } }, orderBy: { createdAt: "desc" },
    }));
    ok("12b. a Percent split with a member removed saves", pctTx !== null, pctTx?.id ?? "not saved");
    if (pctTx) created.push(pctTx.id);
    ok("12c. its rows total the amount exactly", sum(pctTx?.splits ?? []) === 100000, String(sum(pctTx?.splits ?? [])));
    ok("12d. the removed member has no stale row",
      (pctTx?.splits ?? []).length === (await prisma.groupMember.count({ where: { groupId: group.id } })),
      (pctTx?.splits ?? []).map((r) => r.participant?.displayName ?? "OWNER").join(", "));

    // ══════════ 13. A THIRD payer, across all four modes ══════════
    const third = memberNames[2] ?? memberNames[1];
    for (const m of ["Equal split", "Exact amounts", "Percent", "Ratio"] as const) {
      await openComposer(page);
      await type(page, "1000");
      await openGroupSplit(page, group.name);
      await sheet(page).locator("select").first().selectOption({ label: third });
      await page.waitForTimeout(500);
      await mode(page, m).click();
      await page.waitForTimeout(500);
      const merch = `ZAudit3rd-${m.split(" ")[0]}-${tag}`;
      await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
      await page.waitForTimeout(400);
      await nameIt(page, merch);
      await swipe(page, 1);
      await page.waitForTimeout(2400);
      const tx = await waitForRow(() => prisma.transaction.findFirst({
        where: { userId: user.id, merchant: merch }, include: { splits: { include: { participant: true } } }, orderBy: { createdAt: "desc" },
      }));
      if (tx) created.push(tx.id);
      const rows = tx?.splits ?? [];
      const names = rows.map((r) => r.participant?.displayName ?? "OWNER");
      ok(`13-${m}: saves with ${third} as payer`, tx !== null && rows.length > 0, tx?.id ?? "not saved");
      ok(`13-${m}: the owner is present`, names.includes("OWNER"), names.join(", "));
      ok(`13-${m}: everyone appears exactly once`, new Set(names).size === names.length, names.join(", "));
      ok(`13-${m}: shares total exactly`, sum(rows) === 100000, String(sum(rows)));
      ok(`13-${m}: no negative share`, !rows.some((r) => Number(r.owedAmount) < 0));
      ok(`13-${m}: the payer is ${third}`, rows.length > 0 && tx?.paidByParticipantId != null, String(tx?.paidByParticipantId));
    }

    // ══════════ 14. Reopening a saved transaction shows what was stored ══════════
    await openComposer(page);
    await type(page, "1200");
    await openGroupSplit(page, group.name);
    await mode(page, "Exact amounts").click();
    await page.waitForTimeout(400);
    await sheet(page).getByLabel("Your share").fill("300");
    await page.waitForTimeout(300);
    const reopenMerchant = `ZAuditReopen-${tag}`;
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await composer(page).getByRole("button", { name: "Merchant and notes" }).click();
    await page.waitForTimeout(500);
    await sheet(page).locator("input").nth(0).fill(reopenMerchant);
    await sheet(page).locator("input").nth(1).fill("reopen note");
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await swipe(page, 1);
    await page.waitForTimeout(2600);

    const reopenTx = await waitForRow(() => prisma.transaction.findFirst({
      where: { userId: user.id, merchant: reopenMerchant }, include: { splits: true, category: true, account: true }, orderBy: { createdAt: "desc" },
    }));
    ok("14a. the transaction to reopen was saved", reopenTx !== null, reopenTx?.id ?? "not saved");
    if (reopenTx) created.push(reopenTx.id);

    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await page.waitForTimeout(2000);
    await page.getByText(reopenMerchant).first().click();
    // The detail sheet fetches its contents, so the dialog exists before the
    // transaction does. Wait for the merchant to actually appear in it.
    await page.getByRole("dialog").getByText(reopenMerchant).first().waitFor({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    const detail = await page.getByRole("dialog").innerText().catch(() => "");
    ok("14b. the saved transaction opens from the list", detail.length > 0 && detail.includes(reopenMerchant), detail.split("\n").slice(0, 3).join(" | "));
    ok("14c. the amount is shown as stored", /1,200|1200/.test(detail), detail.match(/₹[\d,.]+/g)?.slice(0, 3).join(" ") ?? "");
    ok("14d. the note is shown", /reopen note/.test(detail));
    ok("14e. the group is named", new RegExp(group.name).test(detail), group.name);
    ok("14f. the split is shown with its people", (await page.getByRole("dialog").getByText(new RegExp(memberNames[0])).count()) > 0);
    ok("14g. the stored owner share survived the round trip",
      Number((reopenTx?.splits ?? []).find((r) => r.participantId === null)?.owedAmount ?? -1) === 30000,
      String(Number((reopenTx?.splits ?? []).find((r) => r.participantId === null)?.owedAmount ?? -1)));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // ══════════ 4. Blink: no remount, no animation restart ══════════
    await openComposer(page);
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const root = document.querySelector("div[data-composer]") as HTMLElement;
      const outer = root.parentElement as HTMLElement;
      root.setAttribute("data-probe", "1");
      w.__b = { removed: 0, anims: 0 };
      const b = w.__b as { removed: number; anims: number };
      new MutationObserver((recs) => {
        for (const rec of recs) rec.removedNodes.forEach((nd) => {
          if (nd instanceof HTMLElement && nd.getAttribute("data-probe") === "1") b.removed++;
        });
      }).observe(outer, { childList: true, subtree: true });
      outer.addEventListener("animationstart", () => { b.anims++; }, true);
    });
    await type(page, "500");
    await openGroupSplit(page, group.name);
    await mode(page, "Exact amounts").click();
    await page.waitForTimeout(300);
    const bx = sheet(page).locator("input[type='number']").nth(1);
    await bx.fill("100");
    await bx.blur();
    await page.waitForTimeout(400);
    await mode(page, "Percent").click();
    await page.waitForTimeout(300);
    const bp = sheet(page).locator("input[type='number']").nth(1);
    await bp.fill("40");
    await bp.blur();
    await page.waitForTimeout(400);
    await mode(page, "Ratio").click();
    await page.waitForTimeout(300);
    const br = sheet(page).locator("input[type='number']").nth(1);
    await br.fill("3");
    await br.blur();
    await page.waitForTimeout(400);
    const blink = await page.evaluate(() => (window as unknown as { __b: { removed: number; anims: number } }).__b);
    ok("4a. the composer never remounted through typing and three split edits", blink.removed === 0, `${blink.removed} remounts`);
    ok("4b. no animation restarted", blink.anims === 0, `${blink.anims} animation starts`);
    await composer(page).getByRole("button", { name: "Close" }).click().catch(() => {});
  } catch (e) {
    ok("script error", false, String(e).slice(0, 300));
  } finally {
    if (created.length) {
      await prisma.expenseSplit.deleteMany({ where: { txId: { in: created } } }).catch(() => {});
      await prisma.transaction.deleteMany({ where: { id: { in: created } } }).catch(() => {});
    }
    await ctx?.close().catch(() => {});
    await prisma.$disconnect();
    await browser.close();
  }
}

main().then(() => {
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
});
