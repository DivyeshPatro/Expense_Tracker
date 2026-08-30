// Editing a transaction in the full-screen composer.
//
// Create and edit are one screen now, for the owner's Debit and Credit rows.
// What this suite is really guarding is that "one screen" did not quietly mean
// "one screen, and a slightly different set of numbers afterwards": every
// scenario reads the stored ExpenseSplit rows back out of Postgres, because a
// composer that renders the right thing and saves the wrong thing is exactly
// the failure this project has already had twice.
//
// The no-op edit is the sharpest of them. Open a friend-paid exact split,
// change nothing, save — every row must come back byte for byte.

import { chromium, type Browser, type Page } from "playwright";
import { randomUUID } from "node:crypto";
import { auth } from "../src/server/auth";
import { prisma } from "../src/server/db";

const BASE = "http://localhost:3000";
const EMAIL = "arjun@ledgerly.app";
const PASSWORD = "ledgerly-demo";
const R = (p: number | bigint) => (Number(p) / 100).toFixed(2);

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
// In edit mode the transaction sheet is still mounted (inert) underneath, so
// "the dialog" is ambiguous — the split/picker sheet is always the topmost one.
const sheet = (page: Page) => page.getByRole("dialog").last();

const KEY_ARIA: Record<string, string> = {
  "+": "Plus", "-": "Minus", "×": "Multiply", "÷": "Divide",
  ".": "Decimal point", "00": "Double zero", back: "Backspace", clear: "Clear amount",
};

async function tap(page: Page, ...keys: string[]) {
  for (const k of keys) {
    await composer(page).getByRole("button", { name: KEY_ARIA[k] ?? k, exact: true }).click();
    await page.waitForTimeout(70);
  }
}

async function swipe(page: Page) {
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
  await page.waitForTimeout(900);
}

async function waitFor<T>(read: () => Promise<T | null>, ms = 20000): Promise<T | null> {
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

async function nameIt(page: Page, merchant: string, notes?: string) {
  await composer(page).getByRole("button", { name: "Merchant and notes" }).click();
  await page.waitForTimeout(500);
  await sheet(page).locator("input").first().fill(merchant);
  if (notes !== undefined) await sheet(page).locator("input").nth(1).fill(notes);
  await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
  await page.waitForTimeout(400);
}

async function openGroupSplit(page: Page, groupName: string) {
  await composer(page).getByRole("button", { name: "Group", exact: true }).click();
  await page.waitForTimeout(600);
  await sheet(page).getByRole("button", { name: new RegExp(groupName) }).first().click();
  await page.waitForTimeout(1000);
}

const modeBtn = (page: Page, label: string) => sheet(page).getByRole("button", { name: label, exact: true });
const memberRow = (page: Page, name: string) => sheet(page).locator("button[aria-pressed]").filter({ hasText: name }).first();

async function fields(page: Page): Promise<{ label: string; value: string }[]> {
  return sheet(page).locator("input[type='number']").evaluateAll((els) =>
    (els as HTMLInputElement[]).map((e) => ({ label: (e.parentElement?.querySelector("div")?.textContent ?? "").trim(), value: e.value }))
  );
}

async function setField(page: Page, label: string, value: string) {
  const f = await fields(page);
  const i = f.findIndex((x) => x.label === label);
  if (i < 0) throw new Error(`no field "${label}" — have ${f.map((x) => x.label).join(", ")}`);
  await sheet(page).locator("input[type='number']").nth(i).fill(value);
  await sheet(page).locator("input[type='number']").nth(i).blur();
  await page.waitForTimeout(220);
}

/** Open a transaction and press Edit — which is now the composer. */
async function openEdit(page: Page, merchant: string) {
  await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
  await page.waitForTimeout(2000);
  await page.getByText(merchant, { exact: false }).first().click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await composer(page).waitFor({ timeout: 15000 });
  await page.waitForTimeout(700);
}

const shownAmount = async (page: Page) => (await composer(page).locator("div.flex.items-baseline").first().innerText()).replace(/\s+/g, "");
const chipText = async (page: Page, re: RegExp) => (await composer(page).getByRole("button", { name: re }).first().innerText()).replace(/\s+/g, " ").trim();

async function stored(userId: string, merchant: string) {
  const tx = await waitFor(() => prisma.transaction.findFirst({
    where: { userId, merchant }, include: { splits: { include: { participant: true } }, category: true, account: true }, orderBy: { createdAt: "desc" },
  }));
  if (!tx) return null;
  return {
    tx,
    map: Object.fromEntries(tx.splits.map((s) => [s.participant?.displayName ?? "OWNER", Number(s.owedAmount)])) as Record<string, number>,
    total: tx.splits.reduce((t, s) => t + Number(s.owedAmount), 0),
    show: tx.splits.map((s) => `${s.participant?.displayName ?? "OWNER"}=${R(s.owedAmount)}`).join("  "),
  };
}

/** Wait until this transaction's version moves past `from`. */
async function savedPast(id: string, from: number) {
  return waitFor(async () => {
    const t = await prisma.transaction.findUnique({ where: { id }, include: { splits: { include: { participant: true } }, category: true } });
    return t && t.version > from ? t : null;
  }, 25000);
}

const rowsOf = (t: { splits: { participantId: string | null; owedAmount: bigint | number; participant: { displayName: string } | null }[] }) => ({
  map: Object.fromEntries(t.splits.map((s) => [s.participant?.displayName ?? "OWNER", Number(s.owedAmount)])) as Record<string, number>,
  total: t.splits.reduce((a, s) => a + Number(s.owedAmount), 0),
  show: t.splits.map((s) => `${s.participant?.displayName ?? "OWNER"}=${R(s.owedAmount)}`).join("  "),
});

async function main() {
  const browser = await chromium.launch({ headless: true });
  const tag = randomUUID().slice(0, 6);
  let ctx;
  try {
    const user = await prisma.user.findFirstOrThrow({ where: { email: EMAIL } });
    const group = await prisma.group.findFirstOrThrow({ where: { createdById: user.id }, include: { members: { include: { participant: true } } } });
    const [M1, M2, M3] = group.members.map((m) => m.participant.displayName);
    const personalCats = await prisma.category.findMany({ where: { userId: user.id, groupId: null, kind: "EXPENSE" }, orderBy: { name: "asc" } });
    const groupCats = await prisma.category.findMany({ where: { groupId: group.id, kind: "EXPENSE" }, orderBy: { name: "asc" } });
    const s = await session(browser);
    ctx = s.ctx;
    const page = s.page;

    // ══════════ 1. A personal Debit: hydration, metadata, arithmetic ══════════
    const p1 = `ZEdPersonal-${tag}`;
    await openComposer(page);
    await tap(page, "1", "0", "0", "0");
    await composer(page).getByRole("button", { name: "Choose a category" }).click();
    await page.waitForTimeout(600);
    await sheet(page).getByRole("button", { name: new RegExp(personalCats[0].name) }).first().click();
    await page.waitForTimeout(400);
    await nameIt(page, p1, "first note");
    await swipe(page);
    const c1 = await stored(user.id, p1);
    ok("1a. a personal Debit is created", c1 !== null && Number(c1.tx.amount) === 100000, c1 ? R(c1.tx.amount) : "not saved");
    if (!c1) throw new Error("nothing to edit");

    await openEdit(page, p1);
    ok("1b. Edit opens the full-screen composer", (await composer(page).count()) === 1);
    ok("1c. with the stored amount", (await shownAmount(page)) === "−₹1,000", await shownAmount(page));
    ok("1d. Debit is selected and locked", (await composer(page).getByRole("button", { name: /Debit/ }).getAttribute("aria-pressed")) === "true"
      && (await composer(page).getByRole("button", { name: /Credit/ }).isDisabled()));
    ok("1e. the stored category is shown, not a placeholder", (await chipText(page, /^Category:/)).includes(personalCats[0].name), await chipText(page, /^Category:/));
    ok("1f. Personal is selected", (await composer(page).getByRole("button", { name: "Personal", exact: true }).getAttribute("aria-pressed")) === "true");
    ok("1g. merchant and notes came back", (await composer(page).innerText()).includes("first note"), (await composer(page).innerText()).slice(0, 90).replace(/\s+/g, " "));

    // arithmetic on top of the stored amount
    await tap(page, "+", "2", "5", "0");
    ok("1h. arithmetic extends the stored amount", (await shownAmount(page)) === "−₹1,250", await shownAmount(page));
    await nameIt(page, `${p1}-edited`, "second note");
    await swipe(page);
    const e1 = await savedPast(c1.tx.id, c1.tx.version);
    ok("1i. the edit persists the evaluated amount", e1 !== null && Number(e1.amount) === 125000, e1 ? R(e1.amount) : "no new version");
    ok("1j. and the new merchant and notes", e1?.merchant === `${p1}-edited` && e1?.notes === "second note", `${e1?.merchant} · ${e1?.notes}`);
    ok("1k. the category is unchanged", e1?.categoryId === c1.tx.categoryId, e1?.category?.name ?? "none");
    ok("1l. it is still personal, with no split", e1?.groupId === null && (e1?.splits.length ?? 0) === 0, `group=${e1?.groupId} splits=${e1?.splits.length}`);

    // ══════════ 2. The no-op edit on a friend-paid exact split ══════════
    const g1 = `ZEdNoop-${tag}`;
    await openComposer(page);
    await tap(page, "1", "2", "0", "0");
    await openGroupSplit(page, group.name);
    await sheet(page).locator("select[aria-label='Paid by']").selectOption({ label: M2 });
    await page.waitForTimeout(300);
    await modeBtn(page, "Ratio").click();
    await page.waitForTimeout(500);
    await setField(page, "You", "3");
    await setField(page, M1, "4");
    await setField(page, M2, "3");
    await setField(page, M3, "2");
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await nameIt(page, g1);
    await swipe(page);
    const c2 = await stored(user.id, g1);
    ok("2a. the group expense is created 300/400/300/200",
      c2 !== null && c2.map.OWNER === 30000 && c2.map[M1] === 40000 && c2.map[M2] === 30000 && c2.map[M3] === 20000, c2?.show ?? "not saved");
    if (!c2) throw new Error("nothing to edit");

    await openEdit(page, g1);
    ok("2b. the group is selected", (await composer(page).getByRole("button", { name: new RegExp(group.name) }).count()) > 0);
    await composer(page).getByRole("button", { name: /people ·/ }).click();
    await page.waitForTimeout(800);
    const hydrated = await fields(page);
    console.log(`   hydrated split: ${hydrated.map((f) => `${f.label}=${f.value}`).join("  ")}`);
    ok("2c. every stored share is hydrated, the owner's included",
      hydrated.find((f) => f.label === "You")?.value === "300" && hydrated.find((f) => f.label === M1)?.value === "400"
      && hydrated.find((f) => f.label === M2)?.value === "300" && hydrated.find((f) => f.label === M3)?.value === "200",
      hydrated.map((f) => `${f.label}=${f.value}`).join(" "));
    const payerNow = await sheet(page).locator("select[aria-label='Paid by']").evaluate((e) => (e as HTMLSelectElement).selectedOptions[0]?.textContent ?? "");
    ok("2d. the payer is hydrated", payerNow === M2, payerNow);
    const brk = (await sheet(page).innerText()).replace(/\s+/g, " ");
    ok("2e. the breakdown reads from the same preview", /Split total ₹1,200/.test(brk), (brk.match(/Split total[^D]{0,18}/) ?? [""])[0]);
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);

    await swipe(page);
    const e2 = await savedPast(c2.tx.id, c2.tx.version);
    const r2 = e2 ? rowsOf(e2) : null;
    console.log(`   after a no-op edit: ${r2?.show ?? "no new version"}`);
    ok("2f. THE NO-OP EDIT CHANGES NOTHING",
      r2 !== null && r2.map.OWNER === 30000 && r2.map[M1] === 40000 && r2.map[M2] === 30000 && r2.map[M3] === 20000, r2?.show ?? "no new version");
    ok("2g. the total is still exact", (r2?.total ?? 0) === 120000, R(r2?.total ?? 0));
    ok("2h. the payer is unchanged", e2?.paidByParticipantId === c2.tx.paidByParticipantId);
    ok("2i. nobody is duplicated", (e2?.splits.length ?? 0) === 4, r2?.show ?? "");
    ok("2j. the amount is unchanged", Number(e2?.amount) === 120000, R(e2?.amount ?? 0));

    // ══════════ 3. Changing the amount rebuilds the split ══════════
    const g2 = `ZEdAmount-${tag}`;
    await openComposer(page);
    await tap(page, "1", "0", "0", "0");
    await openGroupSplit(page, group.name);
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await nameIt(page, g2);
    await swipe(page);
    const c3 = await stored(user.id, g2);
    ok("3a. an equal group split of ₹1,000 is created", c3 !== null && c3.total === 100000 && c3.map.OWNER === 25000, c3?.show ?? "not saved");
    if (c3) {
      await openEdit(page, g2);
      await tap(page, "+", "5", "0", "0");
      ok("3b. the amount becomes ₹1,500", (await shownAmount(page)) === "−₹1,500", await shownAmount(page));
      await swipe(page);
      const e3 = await savedPast(c3.tx.id, c3.tx.version);
      const r3 = e3 ? rowsOf(e3) : null;
      console.log(`   after ₹1,000 → ₹1,500: ${r3?.show ?? "no new version"}`);
      ok("3c. the transaction amount is ₹1,500", Number(e3?.amount) === 150000, R(e3?.amount ?? 0));
      ok("3d. the shares total the NEW amount, not the old one", (r3?.total ?? 0) === 150000, R(r3?.total ?? 0));
      ok("3e. nobody is left on the old share", !Object.values(r3?.map ?? {}).every((v) => v === 25000), r3?.show ?? "");
      ok("3f. the owner is still in it", (r3?.map.OWNER ?? 0) > 0, r3?.show ?? "");
      ok("3g. no negative share", !Object.values(r3?.map ?? {}).some((v) => v < 0), r3?.show ?? "");
      ok("3h. everyone appears exactly once", (e3?.splits.length ?? 0) === 4, r3?.show ?? "");
    }

    // ══════════ 4. Changing the payer ══════════
    const g3 = `ZEdPayer-${tag}`;
    await openComposer(page);
    await tap(page, "1", "2", "0", "0");
    await openGroupSplit(page, group.name);
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await nameIt(page, g3);
    await swipe(page);
    const c4 = await stored(user.id, g3);
    ok("4a. a group expense paid by Me is created", c4 !== null && c4.tx.paidByParticipantId === null, c4?.show ?? "not saved");
    if (c4) {
      let version = c4.tx.version;
      for (const payer of [M2, M3] as const) {
        await openEdit(page, g3);
        await composer(page).getByRole("button", { name: /people ·/ }).click();
        await page.waitForTimeout(800);
        await sheet(page).locator("select[aria-label='Paid by']").selectOption({ label: payer });
        await page.waitForTimeout(600);
        await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
        await page.waitForTimeout(400);
        await swipe(page);
        const e4 = await savedPast(c4.tx.id, version);
        const r4 = e4 ? rowsOf(e4) : null;
        console.log(`   payer → ${payer}: ${r4?.show ?? "no new version"}`);
        const want = group.members.find((m) => m.participant.displayName === payer)!.participant.id;
        ok(`4. payer → ${payer}: it is recorded`, e4?.paidByParticipantId === want, String(e4?.paidByParticipantId));
        ok(`4. payer → ${payer}: the owner is still in the split`, (r4?.map.OWNER ?? -1) === 30000, r4?.show ?? "");
        ok(`4. payer → ${payer}: the total is exact`, (r4?.total ?? 0) === 120000, R(r4?.total ?? 0));
        ok(`4. payer → ${payer}: everyone appears once`, (e4?.splits.length ?? 0) === 4, r4?.show ?? "");
        ok(`4. payer → ${payer}: no negative share`, !Object.values(r4?.map ?? {}).some((v) => v < 0));
        ok(`4. payer → ${payer}: the account leg follows who paid`, e4?.accountId === null, String(e4?.accountId));
        version = e4?.version ?? version;
      }
    }

    // ══════════ 5. Members and modes ══════════
    const g4 = `ZEdMembers-${tag}`;
    await openComposer(page);
    await tap(page, "1", "0", "0", "0");
    await openGroupSplit(page, group.name);
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await nameIt(page, g4);
    await swipe(page);
    const c5 = await stored(user.id, g4);
    if (c5) {
      // remove one
      await openEdit(page, g4);
      await composer(page).getByRole("button", { name: /people ·/ }).click();
      await page.waitForTimeout(800);
      await memberRow(page, M3).click();
      await page.waitForTimeout(500);
      await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
      await page.waitForTimeout(400);
      await swipe(page);
      const e5 = await savedPast(c5.tx.id, c5.tx.version);
      const r5 = e5 ? rowsOf(e5) : null;
      console.log(`   after removing ${M3}: ${r5?.show ?? "no new version"}`);
      ok("5a. the removed member is gone from the rows", r5 !== null && r5.map[M3] === undefined, r5?.show ?? "");
      ok("5b. the remaining shares total the amount", (r5?.total ?? 0) === 100000, R(r5?.total ?? 0));
      ok("5c. the owner is still there", (r5?.map.OWNER ?? 0) > 0, r5?.show ?? "");

      // add them back, in each weighted mode
      let version = e5?.version ?? c5.tx.version;
      for (const mode of ["Exact amounts", "Percent", "Ratio"] as const) {
        await openEdit(page, g4);
        await composer(page).getByRole("button", { name: /people ·/ }).click();
        await page.waitForTimeout(800);
        await modeBtn(page, mode).click();
        await page.waitForTimeout(500);
        const before = await fields(page);
        const has = before.some((f) => f.label === M3);
        if (!has) {
          await memberRow(page, M3).click();
          await page.waitForTimeout(700);
        }
        const after = await fields(page);
        const joined = after.find((f) => f.label === M3);
        ok(`5. ${mode}: the member has a real value`, !!joined && joined.value !== "" && Number(joined.value) > 0, `${M3}="${joined?.value ?? "<missing>"}"`);
        ok(`5. ${mode}: nothing on screen complains`, (await sheet(page).getByRole("alert").count()) === 0,
          (await sheet(page).getByRole("alert").allInnerTexts()).join(" | "));
        await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
        await page.waitForTimeout(400);
        await swipe(page);
        const e6 = await savedPast(c5.tx.id, version);
        const r6 = e6 ? rowsOf(e6) : null;
        console.log(`   ${mode} + ${M3}: ${r6?.show ?? "no new version"}`);
        ok(`5. ${mode}: it saves`, e6 !== null, r6?.show ?? "no new version");
        ok(`5. ${mode}: the total is exact`, (r6?.total ?? 0) === 100000, R(r6?.total ?? 0));
        ok(`5. ${mode}: everyone including the owner has a row`, (e6?.splits.length ?? 0) === 4, r6?.show ?? "");
        ok(`5. ${mode}: no negative share`, !Object.values(r6?.map ?? {}).some((v) => v < 0));
        version = e6?.version ?? version;
      }
    }

    // ══════════ 6. Group metadata: the group's category namespace ══════════
    const g5 = `ZEdGroupCat-${tag}`;
    await openComposer(page);
    await tap(page, "8", "0", "0");
    await openGroupSplit(page, group.name);
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(600);
    await composer(page).getByRole("button", { name: "Choose a category" }).click();
    await page.waitForTimeout(600);
    const gpick = groupCats.find((c) => c.name === "Bills") ?? groupCats[0];
    await sheet(page).getByRole("button", { name: new RegExp(gpick.name) }).first().click();
    await page.waitForTimeout(400);
    await nameIt(page, g5);
    await swipe(page);
    const c6 = await stored(user.id, g5);
    ok("6a. a group expense saves with a group category", c6 !== null && c6.tx.category?.groupId === group.id,
      c6 ? `${c6.tx.category?.name} groupId=${c6.tx.category?.groupId}` : "not saved");
    if (c6) {
      await openEdit(page, g5);
      ok("6b. the edit composer shows that group category", (await chipText(page, /^Category:/)).includes(gpick.name), await chipText(page, /^Category:/));
      await composer(page).getByRole("button", { name: /^Category:/ }).click();
      await page.waitForTimeout(700);
      const offered = (await sheet(page).innerText()).replace(/\s+/g, " ");
      const personalOnly = personalCats.filter((c) => !groupCats.some((g) => g.name === c.name)).map((c) => c.name);
      ok("6c. and offers the group's namespace, not the owner's",
        groupCats.every((c) => offered.includes(c.name)) && !personalOnly.some((n) => new RegExp(`\\b${n}\\b`).test(offered)), offered.slice(0, 130));
      const other = groupCats.find((c) => c.id !== gpick.id)!;
      await sheet(page).getByRole("button", { name: new RegExp(other.name) }).first().click();
      await page.waitForTimeout(500);
      await swipe(page);
      const e7 = await savedPast(c6.tx.id, c6.tx.version);
      ok("6d. the category change persists in the group namespace", e7?.categoryId === other.id && e7?.category?.groupId === group.id,
        `${e7?.category?.name} groupId=${e7?.category?.groupId}`);
      ok("6e. and nothing else moved", Number(e7?.amount) === 80000 && e7?.groupId === group.id && (e7?.splits.length ?? 0) === 4,
        `${R(e7?.amount ?? 0)} group=${e7?.groupId} splits=${e7?.splits.length}`);
    }

    // ══════════ 7. A Credit ══════════
    const cr = `ZEdCredit-${tag}`;
    await openComposer(page);
    await composer(page).getByRole("button", { name: /Credit/ }).click();
    await page.waitForTimeout(500);
    await tap(page, "5", "0", "0", "0");
    await composer(page).getByRole("button", { name: "Choose a category" }).click();
    await page.waitForTimeout(600);
    await sheet(page).locator("button").first().click();
    await page.waitForTimeout(400);
    await nameIt(page, cr, "payday");
    await swipe(page);
    const c7 = await stored(user.id, cr);
    ok("7a. a Credit is created", c7 !== null && c7.tx.type === "INCOME" && Number(c7.tx.amount) === 500000, c7 ? `${c7.tx.type} ${R(c7.tx.amount)}` : "not saved");
    if (c7) {
      await openEdit(page, cr);
      ok("7b. Credit is selected and locked", (await composer(page).getByRole("button", { name: /Credit/ }).getAttribute("aria-pressed")) === "true"
        && (await composer(page).getByRole("button", { name: /Debit/ }).isDisabled()));
      ok("7c. with the stored amount", (await shownAmount(page)) === "+₹5,000", await shownAmount(page));
      ok("7d. and the stored category", (await chipText(page, /^Category:/)).length > 0, await chipText(page, /^Category:/));
      ok("7e. and the notes", (await composer(page).innerText()).includes("payday"));
      await tap(page, "-", "5", "0", "0", "+", "2", "5", "0");
      ok("7f. arithmetic works on a Credit", (await shownAmount(page)) === "+₹4,750", await shownAmount(page));
      await swipe(page);
      const e8 = await savedPast(c7.tx.id, c7.tx.version);
      ok("7g. the Credit persists at ₹4,750 and stays INCOME", Number(e8?.amount) === 475000 && e8?.type === "INCOME",
        `${e8?.type} ${R(e8?.amount ?? 0)}`);
      ok("7h. it still has no split rows", (e8?.splits.length ?? 0) === 0, String(e8?.splits.length));
    }

    // ══════════ 8. Render stability in edit mode ══════════
    await openEdit(page, `${p1}-edited`);
    await page.evaluate(() => {
      const w = window as unknown as { __rm: number; __an: number };
      w.__rm = 0;
      w.__an = 0;
      const n = document.querySelector("div[data-composer]");
      if (n) new MutationObserver((ms) => { for (const m of ms) if (m.type === "childList" && m.addedNodes.length && (m.target as HTMLElement).matches?.("div[data-composer]")) w.__rm++; }).observe(n, { childList: true });
      // Only the composer's OWN entry animation counts. A picker sheet sliding
      // in is the design working, not the screen re-entering underneath it.
      document.addEventListener("animationstart", (e) => { if ((e as AnimationEvent).animationName === "composerIn") w.__an++; }, true);
    });
    await tap(page, "+", "1", "0", "0", "-", "5", "0");
    await composer(page).getByRole("button", { name: /^Category:/ }).click();
    await page.waitForTimeout(600);
    await sheet(page).locator("button").first().click();
    await page.waitForTimeout(500);
    const stab = await page.evaluate(() => {
      const w = window as unknown as { __rm: number; __an: number };
      return { remounts: w.__rm, animations: w.__an, composers: document.querySelectorAll("div[data-composer]").length };
    });
    ok("8a. editing causes no composer remount", stab.remounts === 0, JSON.stringify(stab));
    ok("8b. and starts no entry animation", stab.animations === 0, JSON.stringify(stab));
    ok("8c. one composer, sixteen keys", stab.composers === 1 && (await composer(page).locator("div.grid.grid-cols-4 button").count()) === 16, JSON.stringify(stab));

    // ══════════ 9. Delete still lives where it always did ══════════
    await composer(page).getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(700);
    ok("9a. cancelling returns to the detail sheet", (await page.getByRole("button", { name: "Delete", exact: true }).count()) === 1);
    ok("9b. with Edit and Duplicate still there",
      (await page.getByRole("button", { name: "Edit", exact: true }).count()) === 1 && (await page.getByRole("button", { name: "Duplicate", exact: true }).count()) === 1);
  } catch (e) {
    ok("script error", false, e instanceof Error ? e.message.split("\n")[0] : String(e));
  } finally {
    await ctx?.close();
    await browser.close();
    const passed = results.filter((r) => r.pass).length;
    console.log(`\n${passed}/${results.length} checks passed`);
    for (const r of results.filter((x) => !x.pass)) console.log(`  FAIL — ${r.name} · ${r.detail}`);
    await prisma.$disconnect();
    process.exit(passed === results.length ? 0 : 1);
  }
}

main();
