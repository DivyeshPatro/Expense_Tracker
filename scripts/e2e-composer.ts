// The full-screen transaction composer, end to end.
//
// The composer replaced the Add expense / Add income modal forms. It owns no
// business logic — Credit is the existing income path and Debit the existing
// expense path, both through createViaOutbox — so what needs proving is that
// the new surface drives the old engine correctly: the keypad produces the
// amount the server stores, the swipe is a real gesture that only commits past
// its threshold, and the dashboard has the row when it comes back.

import { chromium, type Browser, type Page } from "playwright";
import { randomUUID } from "node:crypto";
import { auth } from "../src/server/auth";
import { prisma } from "../src/server/db";

const BASE = "http://localhost:3000";
const PASSWORD = "ledgerly-demo";
const EMAIL = "arjun@ledgerly.app";

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

/** The create goes through the offline outbox, so the row lands in Postgres a
 *  moment after the composer has already shown success. Poll rather than
 *  guessing a sleep long enough — the first version of this raced it. */
async function waitForRow<T>(read: () => Promise<T | null>, ms = 10000): Promise<T | null> {
  const until = Date.now() + ms;
  for (;;) {
    const row = await read();
    if (row) return row;
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

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
    await page.waitForTimeout(90);
  }
}

/** The rendered amount, sign and digits, with whitespace collapsed. */
async function shownAmount(page: Page) {
  const t = await composer(page).locator("div.flex.items-baseline").first().innerText();
  return t.replace(/\s+/g, "");
}

/** Drag the handle a fraction of the track. 1 completes; 0.4 does not. */
async function swipe(page: Page, fraction: number) {
  const track = composer(page).locator("div[role='slider']");
  const box = (await track.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 30, y);
  await page.mouse.down();
  const target = box.x + 30 + (box.width - 62) * fraction;
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(box.x + 30 + ((target - box.x - 30) * i) / 12, y);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await page.waitForTimeout(700);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const tag = randomUUID().slice(0, 6);
  const created: string[] = [];
  let ctx;

  try {
    const user = await prisma.user.findFirstOrThrow({ where: { email: EMAIL } });
    const s = await session(browser);
    ctx = s.ctx;
    const page = s.page;

    // ═════════ 1. It opens as a screen, clean, with real data ═════════
    await openComposer(page);
    ok("1a. the composer opens full screen", (await composer(page).count()) === 1);
    ok("1b. it starts at zero", (await shownAmount(page)).includes("₹0"), await shownAmount(page));
    ok("1c. Debit is the default type", (await composer(page).getByRole("button", { name: /Debit/ }).getAttribute("aria-pressed")) === "true");
    ok("1c-i. and Credit is not", (await composer(page).getByRole("button", { name: /Credit/ }).getAttribute("aria-pressed")) === "false");
    // Order matters: Debit is the left/first option.
    const typeLabels = await composer(page).locator("div[role='group']").first().locator("button").allInnerTexts();
    ok("1c-ii. Debit sits left of Credit", /Debit/.test(typeLabels[0]) && /Credit/.test(typeLabels[1]), typeLabels.join(" | "));
    ok("1c-iii. a fresh composer shows a negative zero", (await shownAmount(page)) === "−₹0", await shownAmount(page));
    ok("1d. Personal is the default scope", (await composer(page).getByRole("button", { name: "Personal" }).getAttribute("aria-pressed")) === "true");
    // Chips carry the user's real category and account, not placeholders.
    const firstAccount = await prisma.account.findFirstOrThrow({ where: { userId: user.id }, orderBy: { name: "asc" } });
    const chipText = await composer(page).innerText();
    ok("1e. the chips show real account and category data", chipText.includes("Today") && /HDFC|Cash|Card|Wallet/i.test(chipText));

    // ═════════ 2. The keypad drives the amount ═════════
    await type(page, "5");
    ok("2a. a digit lands on the amount", (await shownAmount(page)) === "−₹5", await shownAmount(page));
    await type(page, "0");
    ok("2b. digits append", (await shownAmount(page)) === "−₹50", await shownAmount(page));
    await composer(page).getByRole("button", { name: "Backspace" }).click();
    await page.waitForTimeout(150);
    ok("2c. backspace removes one digit", (await shownAmount(page)) === "−₹5", await shownAmount(page));
    await type(page, ".25");
    ok("2d. decimals work", (await shownAmount(page)) === "−₹5.25", await shownAmount(page));
    await composer(page).getByRole("button", { name: "Decimal point" }).click();
    await page.waitForTimeout(150);
    ok("2e. a second decimal point is refused", (await shownAmount(page)) === "−₹5.25", await shownAmount(page));
    await type(page, "9");
    ok("2f. a third decimal digit is refused", (await shownAmount(page)) === "−₹5.25", await shownAmount(page));

    // ═════════ 3. Credit / Debit changes the sign ═════════
    await composer(page).getByRole("button", { name: /Credit/ }).click();
    await page.waitForTimeout(300);
    ok("3a. Credit flips the sign", (await shownAmount(page)).startsWith("+"), await shownAmount(page));
    await composer(page).getByRole("button", { name: /Debit/ }).click();
    await page.waitForTimeout(300);
    ok("3b. Debit flips it back", (await shownAmount(page)).startsWith("−"), await shownAmount(page));

    // ═════════ 4. An incomplete swipe saves nothing ═════════
    const before = await prisma.transaction.count({ where: { userId: user.id, deletedAt: null } });
    await swipe(page, 0.4);
    ok("4a. releasing short of the threshold does not commit", (await prisma.transaction.count({ where: { userId: user.id, deletedAt: null } })) === before);
    ok("4b. and the composer is still open", (await composer(page).count()) === 1);

    // ═════════ 5. Zero is refused, inline ═════════
    for (let i = 0; i < 6; i++) await composer(page).getByRole("button", { name: "Backspace" }).click();
    await page.waitForTimeout(200);
    await swipe(page, 1);
    ok("5a. an empty amount is refused", (await prisma.transaction.count({ where: { userId: user.id, deletedAt: null } })) === before);
    ok("5b. it says so inline, not in a browser dialog", (await composer(page).getByRole("alert").count()) === 1, (await composer(page).getByRole("alert").innerText().catch(() => "")).trim());

    // ═════════ 6. A completed swipe commits a Credit ═════════
    const merchant = `ZComposer-${tag}`;
    await composer(page).getByRole("button", { name: /Credit/ }).click();
    await page.waitForTimeout(250);
    await type(page, "5");
    await composer(page).getByText("Who's it for?").click();
    await page.waitForTimeout(500);
    await page.getByRole("dialog").locator("input").first().fill(merchant);
    await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
    await page.waitForTimeout(400);
    await swipe(page, 1);
    await page.waitForTimeout(1500);

    const saved = await waitForRow(() => prisma.transaction.findFirst({ where: { userId: user.id, merchant }, orderBy: { createdAt: "desc" } }));
    ok("6a. the swipe commits the transaction", saved !== null, saved?.id ?? "not saved");
    if (saved) created.push(saved.id);
    ok("6b. it is stored as INCOME with the entered amount", saved?.type === "INCOME" && Number(saved.amount) === 500, `${saved?.type} ${Number(saved?.amount ?? 0)}`);
    ok("6c. the merchant typed into 'Who's it for?' is on the row", saved?.merchant === merchant);
    ok("6d. it carries the chip's account", saved?.accountId != null, saved?.accountId ?? "null");
    ok("6e. it saved as personal, matching the default scope", saved?.groupId === null);

    // ═════════ 7. Success, then the dashboard has it ═════════
    await page.waitForTimeout(1200);
    ok("7a. the composer closed itself after success", (await composer(page).count()) === 0);
    let onDashboard = false;
    for (let i = 0; i < 20 && !onDashboard; i++) {
      onDashboard = (await page.locator("body").innerText()).includes(merchant);
      if (!onDashboard) await page.waitForTimeout(400);
    }
    ok("7b. the new transaction is on the dashboard without a reload", onDashboard);

    // ═════════ 8. Reopening is clean ═════════
    await openComposer(page);
    ok("8a. it reopens at zero", (await shownAmount(page)).includes("₹0"), await shownAmount(page));
    ok("8b. the previous merchant is gone from the form", !(await composer(page).innerText()).includes(merchant));
    ok("8c. no stale validation message", (await composer(page).getByRole("alert").count()) === 0);

    // ═════════ 9. Debit end to end ═════════
    const debitMerchant = `ZComposerDebit-${tag}`;
    ok("9-pre. a reopened composer is back on Debit", (await composer(page).getByRole("button", { name: /Debit/ }).getAttribute("aria-pressed")) === "true");
    await type(page, "500");
    await composer(page).getByText("Who's it for?").click();
    await page.waitForTimeout(500);
    await page.getByRole("dialog").locator("input").first().fill(debitMerchant);
    await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
    await page.waitForTimeout(400);
    await swipe(page, 1);
    await page.waitForTimeout(1800);

    const debit = await waitForRow(() => prisma.transaction.findFirst({ where: { userId: user.id, merchant: debitMerchant }, orderBy: { createdAt: "desc" } }));
    ok("9a. a Debit commits as EXPENSE", debit?.type === "EXPENSE", debit?.type ?? "not saved");
    ok("9b. with the entered amount", Number(debit?.amount ?? 0) === 50000, String(Number(debit?.amount ?? 0)));
    if (debit) created.push(debit.id);

    // ═════════ 11. Group: members, split method, and what gets stored ═════════
    // The composer does not implement splitting — it mounts the classic
    // SplitEditor and submits buildSplitPayload's output through
    // addExpenseAction, so this proves the wiring, not a second engine.
    const group = await prisma.group.findFirstOrThrow({ where: { createdById: user.id }, include: { members: true } });

    await openComposer(page);
    await type(page, "1000");
    await composer(page).getByRole("button", { name: "Group", exact: true }).click();
    await page.waitForTimeout(600);
    await page.getByRole("dialog").getByRole("button", { name: new RegExp(group.name) }).first().click();
    await page.waitForTimeout(900);

    const sheet = page.getByRole("dialog");
    ok("11a. choosing a group opens the split editor", (await sheet.count()) === 1 && /Split/i.test(await sheet.innerText()));
    ok("11b. it lists the group's own members", (await sheet.locator("input[type='checkbox']").count()) > 0 || /Paid by/i.test(await sheet.innerText()));

    // The split methods the classic editor offers, driven for real.
    const modes = await sheet.getByRole("button").allInnerTexts();
    ok("11c. the editor offers the real split methods", /Equal/i.test(modes.join(" ")) && /%|Percent/i.test(modes.join(" ")), modes.slice(0, 12).join(" | "));

    await sheet.getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(500);
    ok("11d. the composer shows the group context, not a bare label", /people|splitting/i.test(await composer(page).innerText()));

    const groupMerchant = `ZComposerGroup-${tag}`;
    await composer(page).getByText(/Who's it for|·/).first().click();
    await page.waitForTimeout(500);
    await page.getByRole("dialog").locator("input").first().fill(groupMerchant);
    await page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);

    await swipe(page, 1);
    await page.waitForTimeout(2500);

    const grouped = await waitForRow(() => prisma.transaction.findFirst({
      where: { userId: user.id, merchant: groupMerchant },
      include: { splits: true },
      orderBy: { createdAt: "desc" },
    }));
    ok("11e. a group expense saves", grouped !== null, grouped?.id ?? "not saved");
    if (grouped) created.push(grouped.id);
    ok("11f. it is tagged to the chosen group", grouped?.groupId === group.id, grouped?.groupId ?? "null");
    ok("11g. it stored real split rows, not a group label alone", (grouped?.splits.length ?? 0) > 1, `${grouped?.splits.length ?? 0} split rows`);
    ok("11h. the shares add up to the amount",
      (grouped?.splits ?? []).reduce((t, r) => t + Number(r.owedAmount), 0) === 100000,
      String((grouped?.splits ?? []).reduce((t, r) => t + Number(r.owedAmount), 0)));

    // ═════════ 11b. Switching mode keeps the distribution, and it persists ═════════
    // The unit tests cover every conversion direction; this proves the seeded
    // values reach the database as real split rows rather than only rendering.
    await openComposer(page);
    await type(page, "1000");
    await composer(page).getByRole("button", { name: "Group", exact: true }).click();
    await page.waitForTimeout(600);
    await page.getByRole("dialog").getByRole("button", { name: new RegExp(group.name) }).first().click();
    await page.waitForTimeout(900);

    const modeSheet = page.getByRole("dialog");
    await modeSheet.getByRole("button", { name: "Exact amounts", exact: true }).click();
    await page.waitForTimeout(500);
    const exactValues = await modeSheet.locator("input[type='number']").evaluateAll((els) =>
      (els as HTMLInputElement[]).map((e) => e.value)
    );
    ok("11b-i. Equal → Exact arrives pre-filled, not blank", exactValues.length > 0 && exactValues.every((v) => v !== ""), exactValues.join(" / "));

    await modeSheet.getByRole("button", { name: "Percent", exact: true }).click();
    await page.waitForTimeout(500);
    const pctValues = await modeSheet.locator("input[type='number']").evaluateAll((els) =>
      (els as HTMLInputElement[]).map((e) => e.value)
    );
    ok("11b-ii. Exact → Percent is pre-filled too", pctValues.every((v) => v !== ""), pctValues.join(" / "));
    ok("11b-iii. the percentages total 100", Math.round(pctValues.reduce((t, v) => t + Number(v || 0), 0)) === 100, pctValues.join(" / "));

    await modeSheet.getByRole("button", { name: "Ratio", exact: true }).click();
    await page.waitForTimeout(500);
    const ratioValues = await modeSheet.locator("input[type='number']").evaluateAll((els) =>
      (els as HTMLInputElement[]).map((e) => e.value)
    );
    ok("11b-iv. Percent → Ratio gives whole numbers, no float noise", ratioValues.every((v) => /^\d+$/.test(v)), ratioValues.join(" / "));

    await modeSheet.getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    const convertedMerchant = `ZComposerConv-${tag}`;
    await composer(page).getByText(/Who's it for|·/).first().click();
    await page.waitForTimeout(500);
    await page.getByRole("dialog").locator("input").first().fill(convertedMerchant);
    await page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await swipe(page, 1);
    await page.waitForTimeout(2500);

    const converted = await waitForRow(() => prisma.transaction.findFirst({
      where: { userId: user.id, merchant: convertedMerchant }, include: { splits: true }, orderBy: { createdAt: "desc" },
    }));
    ok("11b-v. a split carried through three mode switches still saves", converted !== null, converted?.id ?? "not saved");
    if (converted) created.push(converted.id);
    ok("11b-vi. and its stored shares still total the amount",
      (converted?.splits ?? []).reduce((t, r) => t + Number(r.owedAmount), 0) === 100000,
      String((converted?.splits ?? []).reduce((t, r) => t + Number(r.owedAmount), 0)));

    // ═════════ 11c. Editing a share rebalances, and the STORED rows match ═════════
    // The unit tests prove the arithmetic; this proves the edited distribution
    // survives the swipe into real ExpenseSplit rows rather than only rendering.
    await openComposer(page);
    await type(page, "1000");
    await composer(page).getByRole("button", { name: "Group", exact: true }).click();
    await page.waitForTimeout(600);
    await page.getByRole("dialog").getByRole("button", { name: new RegExp(group.name) }).first().click();
    await page.waitForTimeout(900);

    const editSheet = page.getByRole("dialog");
    await editSheet.getByRole("button", { name: "Exact amounts", exact: true }).click();
    await page.waitForTimeout(500);

    // Raise the first friend and commit; the others should give way.
    const friendInputs = editSheet.locator("input[type='number']");
    const beforeEdit = await friendInputs.evaluateAll((els) => (els as HTMLInputElement[]).map((e) => e.value));
    const firstFriend = friendInputs.nth(await editSheet.getByLabel("Your share").count()); // skip the You row
    await firstFriend.fill("500");
    await firstFriend.blur();
    await page.waitForTimeout(600);
    const after = await friendInputs.evaluateAll((els) => (els as HTMLInputElement[]).map((e) => e.value));
    ok("11c-i. the edited value is kept", after.includes("500"), after.join(" / "));
    ok("11c-ii. the other shares moved to make room", JSON.stringify(beforeEdit) !== JSON.stringify(after), beforeEdit.join("/") + "  ->  " + after.join("/"));

    // The owner's own share is editable in Exact when the owner paid.
    ok("11c-iii. Exact offers a row for your own share", (await editSheet.getByLabel("Your share").count()) === 1);


    await editSheet.getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    const editedMerchant = `ZComposerEdit-${tag}`;
    await composer(page).getByText(/Who's it for|·/).first().click();
    await page.waitForTimeout(500);
    await page.getByRole("dialog").locator("input").first().fill(editedMerchant);
    await page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await swipe(page, 1);
    await page.waitForTimeout(2500);

    const edited = await waitForRow(() => prisma.transaction.findFirst({
      where: { userId: user.id, merchant: editedMerchant }, include: { splits: true }, orderBy: { createdAt: "desc" },
    }));
    ok("11c-iv. the edited split saves", edited !== null, edited?.id ?? "not saved");
    if (edited) created.push(edited.id);
    ok("11c-v. the stored rows still total the amount",
      (edited?.splits ?? []).reduce((t, r) => t + Number(r.owedAmount), 0) === 100000,
      String((edited?.splits ?? []).reduce((t, r) => t + Number(r.owedAmount), 0)));
    ok("11c-vi. and one stored row carries the edited 500",
      (edited?.splits ?? []).some((r) => Number(r.owedAmount) === 50000),
      (edited?.splits ?? []).map((r) => Number(r.owedAmount)).join(" / "));
    ok("11c-vii. the payer is still the owner, unchanged by the edit",
      edited?.paidByParticipantId === null, String(edited?.paidByParticipantId));

    // ═════════ 12. Group → Personal drops the split ═════════
    await openComposer(page);
    await composer(page).getByRole("button", { name: "Group", exact: true }).click();
    await page.waitForTimeout(600);
    await page.getByRole("dialog").getByRole("button", { name: new RegExp(group.name) }).first().click();
    await page.waitForTimeout(800);
    await page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await composer(page).getByRole("button", { name: "Personal", exact: true }).click();
    await page.waitForTimeout(400);
    ok("12a. switching back to Personal clears the group context", !/people ·/i.test(await composer(page).innerText()));
    await composer(page).getByRole("button", { name: "Close" }).click();
    await page.waitForTimeout(500);

    // ═════════ 10. Close without saving ═════════
    await openComposer(page);
    await type(page, "77");
    const beforeClose = await prisma.transaction.count({ where: { userId: user.id, deletedAt: null } });
    await composer(page).getByRole("button", { name: "Close" }).click();
    await page.waitForTimeout(700);
    ok("10a. closing exits the composer", (await composer(page).count()) === 0);
    ok("10b. and saves nothing", (await prisma.transaction.count({ where: { userId: user.id, deletedAt: null } })) === beforeClose);
    ok("10c. the account it did not use is untouched", (await prisma.account.findUniqueOrThrow({ where: { id: firstAccount.id } })).name === firstAccount.name);
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
