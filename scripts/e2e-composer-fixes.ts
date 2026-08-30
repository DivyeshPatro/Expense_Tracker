// The four accounting and namespace defects found in the composer's post-commit
// audit, each driven through the real browser and read back out of Postgres.
//
//   1. EXACT + a friend as payer dropped the owner's share to ₹0 and charged it
//      to the payer — on create, on a payer change, and on an edit that changed
//      nothing at all.
//   2. A member added to a live Percent/Ratio split started blank, which the
//      schema refuses, so the save died on "Number must be greater than 0".
//   3. Group expenses were filed under the owner's PERSONAL category namespace.
//   4. The split sheet showed no breakdown, which is why (1) was silent.
//
// Every share here is checked against the stored ExpenseSplit rows, never
// against the screen alone: the screen was not wrong in case (1), the rows were.

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
// The topmost sheet: an owner's edit opens the composer over the transaction
// sheet, which stays mounted (inert) underneath.
const sheet = (page: Page) => page.getByRole("dialog").last();

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
  await page.waitForTimeout(700);
}

/** The write goes through an action or the outbox; poll rather than sleep. */
async function waitFor<T>(read: () => Promise<T | null>, ms = 20000): Promise<T | null> {
  const until = Date.now() + ms;
  for (;;) {
    const row = await read();
    if (row) return row;
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function nameIt(page: Page, merchant: string) {
  await composer(page).getByRole("button", { name: "Merchant and notes" }).click();
  await page.waitForTimeout(500);
  await sheet(page).locator("input").first().fill(merchant);
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

/** Each per-person number input paired with the name on its row. */
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
  await page.waitForTimeout(200);
}

/** The stored rows, keyed by display name, with the owner as OWNER. */
async function stored(userId: string, merchant: string) {
  const tx = await waitFor(() => prisma.transaction.findFirst({
    where: { userId, merchant }, include: { splits: { include: { participant: true } }, category: true }, orderBy: { createdAt: "desc" },
  }));
  if (!tx) return null;
  return {
    tx,
    map: Object.fromEntries(tx.splits.map((s) => [s.participant?.displayName ?? "OWNER", Number(s.owedAmount)])) as Record<string, number>,
    total: tx.splits.reduce((t, s) => t + Number(s.owedAmount), 0),
    show: tx.splits.map((s) => `${s.participant?.displayName ?? "OWNER"}=${R(s.owedAmount)}`).join("  "),
  };
}

async function openDetail(page: Page, merchant: string) {
  await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
  await page.waitForTimeout(2000);
  await page.getByText(merchant, { exact: false }).first().click();
  await page.waitForTimeout(1600);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const tag = randomUUID().slice(0, 6);
  const created: string[] = [];
  let ctx;
  try {
    const user = await prisma.user.findFirstOrThrow({ where: { email: EMAIL } });
    const group = await prisma.group.findFirstOrThrow({ where: { createdById: user.id }, include: { members: { include: { participant: true } } } });
    const names = group.members.map((m) => m.participant.displayName);
    const [M1, M2, M3] = names;
    const s = await session(browser);
    ctx = s.ctx;
    const page = s.page;

    // ══════════ 1. EXACT: naming a friend as payer keeps your share ══════════
    await openComposer(page);
    await type(page, "1200");
    await openGroupSplit(page, group.name);
    await modeBtn(page, "Exact amounts").click();
    await page.waitForTimeout(500);
    const beforeSwitch = await fields(page);
    ok("1a. Exact opens with your own share stated", beforeSwitch.find((f) => f.label === "You")?.value === "300",
      beforeSwitch.map((f) => `${f.label}=${f.value}`).join(" "));

    await sheet(page).locator("select[aria-label='Paid by']").selectOption({ label: M2 });
    await page.waitForTimeout(800);
    const afterSwitch = await fields(page);
    ok("1b. handing the bill to a friend leaves your share on screen", afterSwitch.find((f) => f.label === "You")?.value === "300",
      afterSwitch.map((f) => `${f.label}="${f.value}"`).join(" "));

    // The breakdown is the whole point of (4): it must state this on screen.
    const breakdown = await sheet(page).innerText();
    ok("1c. the sheet shows a split breakdown", /Split breakdown/.test(breakdown));
    ok("1d. the breakdown totals the amount", /Split total\s*₹1,200/.test(breakdown.replace(/\s+/g, " ")),
      (breakdown.replace(/\s+/g, " ").match(/Split total[^|]{0,24}/) ?? [""])[0]);

    const m1 = `ZFixExactPayer-${tag}`;
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(400);
    await nameIt(page, m1);
    await swipe(page);
    const r1 = await stored(user.id, m1);
    ok("1e. it saves", r1 !== null, r1?.tx.id ?? "not saved");
    if (r1) {
      created.push(r1.tx.id);
      console.log(`   stored: ${r1.show}`);
      ok("1f. your ₹300 is stored, not ₹0", r1.map.OWNER === 30000, `OWNER=${R(r1.map.OWNER ?? 0)}`);
      ok("1g. the payer carries their own share and no more", r1.map[M2] === 30000, `${M2}=${R(r1.map[M2] ?? 0)}`);
      ok("1h. the rows total the amount", r1.total === 120000, R(r1.total));
      ok("1i. everyone appears exactly once", r1.tx.splits.length === 4 && new Set(Object.keys(r1.map)).size === 4, r1.show);
    }

    // ══════════ 2. The no-op edit ══════════
    // You 300 / M2 300 / M3 200 / M1 400, paid by M2 — as reported.
    const m2 = `ZFixNoop-${tag}`;
    await openComposer(page);
    await type(page, "1200");
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
    await nameIt(page, m2);
    await swipe(page);
    const before = await stored(user.id, m2);
    ok("2a. the transaction to reopen was created", before !== null, before?.show ?? "not saved");
    if (before) {
      created.push(before.tx.id);
      ok("2b. it starts at 300 / 400 / 300 / 200",
        before.map.OWNER === 30000 && before.map[M1] === 40000 && before.map[M2] === 30000 && before.map[M3] === 20000, before.show);

      await openDetail(page, m2);
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await composer(page).waitFor({ timeout: 15000 });
      await page.waitForTimeout(700);
      await composer(page).getByRole("button", { name: /people ·/ }).click();
      await page.waitForTimeout(800);
      const editForm = (await sheet(page).innerText()).replace(/\s+/g, " ");
      ok("2c. the edit form shows your own share", /You\b/.test(editForm) && !/You\s+Exact\s+₹0\b/.test(editForm),
        (editForm.match(/Split breakdown.{0,90}/) ?? [""])[0]);
      await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
      await page.waitForTimeout(400);
      await swipe(page);
      await page.waitForTimeout(1500);

      const after = await waitFor(async () => {
        const t = await prisma.transaction.findUnique({ where: { id: before.tx.id }, include: { splits: { include: { participant: true } } } });
        return t && t.version > before.tx.version ? t : null;
      });
      const map = Object.fromEntries((after?.splits ?? []).map((x) => [x.participant?.displayName ?? "OWNER", Number(x.owedAmount)]));
      const show = (after?.splits ?? []).map((x) => `${x.participant?.displayName ?? "OWNER"}=${R(x.owedAmount)}`).join("  ");
      console.log(`   after a no-op save: ${show}`);
      ok("2d. changing nothing changed nothing — your ₹300 survived", map.OWNER === 30000, `OWNER=${R(map.OWNER ?? 0)}`);
      ok("2e. the payer was not charged your share", map[M2] === 30000, `${M2}=${R(map[M2] ?? 0)}`);
      ok("2f. every other share is untouched", map[M1] === 40000 && map[M3] === 20000, show);
      ok("2g. the payer is unchanged", after?.paidByParticipantId === before.tx.paidByParticipantId);
    }

    // ══════════ 3. Payer x mode, against the database ══════════
    for (const payer of ["Me", M2, M3] as const) {
      for (const mode of ["Equal split", "Exact amounts", "Percent", "Ratio"] as const) {
        const merchant = `ZFixMx-${mode.split(" ")[0]}-${payer}-${tag}`;
        await openComposer(page);
        await type(page, "900");
        await openGroupSplit(page, group.name);
        await sheet(page).locator("select[aria-label='Paid by']").selectOption({ label: payer });
        await page.waitForTimeout(400);
        await modeBtn(page, mode).click();
        await page.waitForTimeout(500);
        await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
        await page.waitForTimeout(350);
        await nameIt(page, merchant);
        await swipe(page);
        const r = await stored(user.id, merchant);
        const label = `3. ${mode.split(" ")[0]} paid by ${payer}`;
        ok(`${label}: saves`, r !== null, r?.show ?? "not saved");
        if (!r) continue;
        created.push(r.tx.id);
        ok(`${label}: the owner is present`, r.map.OWNER !== undefined, r.show);
        ok(`${label}: everyone exactly once`, r.tx.splits.length === 4 && new Set(Object.keys(r.map)).size === 4, r.show);
        ok(`${label}: the shares total the amount`, r.total === 90000, R(r.total));
        ok(`${label}: no negative share`, !Object.values(r.map).some((v) => v < 0), r.show);
        const wantPayer = payer === "Me" ? null : group.members.find((m) => m.participant.displayName === payer)!.participant.id;
        ok(`${label}: the payer is recorded`, r.tx.paidByParticipantId === wantPayer, String(r.tx.paidByParticipantId));
        ok(`${label}: the account leg matches who paid`, payer === "Me" ? r.tx.accountId !== null : r.tx.accountId === null, String(r.tx.accountId));
      }
    }

    // ══════════ 4. Adding a member back into a live split ══════════
    for (const mode of ["Percent", "Ratio"] as const) {
      const merchant = `ZFixAdd${mode}-${tag}`;
      await openComposer(page);
      await type(page, "1000");
      await openGroupSplit(page, group.name);
      await sheet(page).locator("select[aria-label='Paid by']").selectOption({ label: M1 });
      await page.waitForTimeout(300);
      await memberRow(page, M3).click(); // drop them
      await page.waitForTimeout(400);
      await modeBtn(page, mode).click();
      await page.waitForTimeout(500);
      // Every remaining field is set, so the distribution under test is the one
      // written here rather than whatever the mode happened to seed.
      await setField(page, "You", mode === "Percent" ? "50" : "5");
      await setField(page, M1, mode === "Percent" ? "30" : "3");
      await setField(page, M2, mode === "Percent" ? "20" : "2");
      const beforeAdd = await fields(page);
      ok(`4. ${mode}: the seeded weights are small enough to type over`,
        beforeAdd.every((f) => Number(f.value) > 0 && Number(f.value) <= 200),
        beforeAdd.map((f) => `${f.label}=${f.value}`).join(" "));

      await memberRow(page, M3).click(); // and back in
      await page.waitForTimeout(700);
      const afterAdd = await fields(page);
      console.log(`   ${mode}: ${beforeAdd.map((f) => `${f.label}=${f.value}`).join(" ")}  →  ${afterAdd.map((f) => `${f.label}=${f.value}`).join(" ")}`);
      const joined = afterAdd.find((f) => f.label === M3);
      ok(`4. ${mode}: the new member gets a real weight`, !!joined && joined.value !== "" && Number(joined.value) > 0, `${M3}="${joined?.value ?? "<missing>"}"`);
      ok(`4. ${mode}: nothing on screen complains`, (await sheet(page).getByRole("alert").count()) === 0,
        (await sheet(page).getByRole("alert").allInnerTexts()).join(" | "));

      await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
      await page.waitForTimeout(350);
      await nameIt(page, merchant);
      await swipe(page);
      const r = await stored(user.id, merchant);
      ok(`4. ${mode}: it saves after adding a member`, r !== null, r?.show ?? `not saved · ${(await composer(page).getByRole("alert").allInnerTexts().catch(() => [])).join(" ")}`);
      if (r) {
        created.push(r.tx.id);
        ok(`4. ${mode}: the new member has a share above zero`, (r.map[M3] ?? 0) > 0, r.show);
        ok(`4. ${mode}: the rows total the amount`, r.total === 100000, R(r.total));
        ok(`4. ${mode}: everyone has a row`, r.tx.splits.length === 4, r.show);
        // The rows must be what the weights on screen said — a split can total
        // the amount and still be nonsense, which is how a ₹0.11 share passed
        // an earlier version of this check.
        const sum = afterAdd.reduce((t, f) => t + Number(f.value), 0);
        const drift = afterAdd.map((f) => {
          const person = f.label === "You" ? "OWNER" : f.label;
          const want = Math.floor((100000 * Number(f.value)) / sum);
          return { person, want, got: r.map[person] ?? -1, off: Math.abs((r.map[person] ?? -1) - want) };
        });
        ok(`4. ${mode}: every stored share is the one the weights implied`,
          drift.every((d) => d.off <= 3), drift.map((d) => `${d.person}: ${R(d.want)} vs ${R(d.got)}`).join("  "));
        ok(`4. ${mode}: nobody is left with loose change`, Object.values(r.map).every((v) => v >= 100), r.show);
      } else {
        await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
        await page.waitForTimeout(800);
      }
    }

    // ══════════ 5. Every mode in turn, editing at each stop ══════════
    const chain = `ZFixChain-${tag}`;
    await openComposer(page);
    await type(page, "1000");
    await openGroupSplit(page, group.name);
    await modeBtn(page, "Exact amounts").click();
    await page.waitForTimeout(400);
    await setField(page, M1, "400");
    const exactStop = await fields(page);
    await modeBtn(page, "Percent").click();
    await page.waitForTimeout(500);
    const pctStop = await fields(page);
    await modeBtn(page, "Ratio").click();
    await page.waitForTimeout(500);
    const ratioStop = await fields(page);
    await modeBtn(page, "Exact amounts").click();
    await page.waitForTimeout(500);
    const backToExact = await fields(page);
    console.log(`   EXACT ${exactStop.map((f) => f.value).join("/")} → PERCENT ${pctStop.map((f) => f.value).join("/")} → RATIO ${ratioStop.map((f) => f.value).join("/")} → EXACT ${backToExact.map((f) => f.value).join("/")}`);
    const sameRupees = exactStop.every((f) => Math.abs(Number(f.value) - Number(backToExact.find((x) => x.label === f.label)?.value ?? NaN)) < 0.02);
    ok("5a. a distribution survives Exact → Percent → Ratio → Exact", sameRupees,
      `${exactStop.map((f) => `${f.label}=${f.value}`).join(" ")}  vs  ${backToExact.map((f) => `${f.label}=${f.value}`).join(" ")}`);
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(350);
    await nameIt(page, chain);
    await swipe(page);
    const rc = await stored(user.id, chain);
    ok("5b. and saves as what was on screen", rc !== null && rc.map[M1] === 40000 && rc.total === 100000, rc?.show ?? "not saved");
    if (rc) created.push(rc.tx.id);

    // ══════════ 5b. Exact amounts, entered one name at a time ══════════
    // Redistribution used to move every other friend, so ₹400 / ₹300 / ₹200
    // typed in that order never arrived — each entry rewrote the ones before.
    const seq = `ZFixSeq-${tag}`;
    await openComposer(page);
    await type(page, "1000");
    await openGroupSplit(page, group.name);
    await modeBtn(page, "Exact amounts").click();
    await page.waitForTimeout(500);
    await setField(page, "You", "400");
    await setField(page, M1, "300");
    await setField(page, M2, "200");
    const typed = await fields(page);
    console.log(`   exact in order: ${typed.map((f) => `${f.label}=${f.value}`).join("  ")}`);
    ok("5c. each exact amount stays where it was typed",
      typed.find((f) => f.label === "You")?.value === "400" &&
      typed.find((f) => f.label === M1)?.value === "300" &&
      typed.find((f) => f.label === M2)?.value === "200",
      typed.map((f) => `${f.label}=${f.value}`).join(" "));
    ok("5d. the one nobody touched carries the balance", Number(typed.find((f) => f.label === M3)?.value) === 100,
      `${M3}=${typed.find((f) => f.label === M3)?.value}`);

    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(350);
    await nameIt(page, seq);
    await swipe(page);
    const rs = await stored(user.id, seq);
    ok("5e. and that is what is stored", rs !== null && rs.map.OWNER === 40000 && rs.map[M1] === 30000 && rs.map[M2] === 20000 && rs.map[M3] === 10000,
      rs?.show ?? "not saved");
    if (rs) {
      created.push(rs.tx.id);
      ok("5f. the rows total the amount", rs.total === 100000, R(rs.total));
    }

    // ══════════ 6. Category namespace ══════════
    const groupCats = await prisma.category.findMany({ where: { groupId: group.id, kind: "EXPENSE" }, orderBy: { name: "asc" } });
    const personalCats = await prisma.category.findMany({ where: { userId: user.id, groupId: null, kind: "EXPENSE" }, orderBy: { name: "asc" } });
    const gm = `ZFixCatGroup-${tag}`;
    await openComposer(page);
    await type(page, "500");
    // Nothing is selected until the reader selects it, so this starts from a
    // deliberate personal pick rather than from whatever used to be seeded.
    ok("6-pre. a new expense starts with no category at all",
      (await composer(page).getByRole("button", { name: "Choose a category" }).count()) === 1,
      (await composer(page).getByRole("button", { name: /category/i }).first().innerText().catch(() => "(no category chip)")).replace(/\s+/g, " "));
    await composer(page).getByRole("button", { name: "Choose a category" }).click();
    await page.waitForTimeout(600);
    const personalPick = personalCats.find((c) => !groupCats.some((g) => g.name === c.name)) ?? personalCats[0];
    await sheet(page).getByRole("button", { name: new RegExp(personalPick.name) }).first().click();
    await page.waitForTimeout(500);
    const personalChip = await composer(page).getByRole("button", { name: /^Category:|^Choose a category$/ }).innerText();
    await openGroupSplit(page, group.name);
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(700);
    const groupChip = await composer(page).getByRole("button", { name: /^Category:|^Choose a category$/ }).innerText();
    console.log(`   category chip: personal "${personalChip.trim()}" → group "${groupChip.trim()}"`);
    ok("6a. a personal category does not survive into a group",
      personalChip.includes(personalPick.name) && !groupChip.includes(personalPick.name),
      `${personalChip.trim()} vs ${groupChip.trim()}`);

    // The picker must offer the group's list, not the owner's.
    await composer(page).getByRole("button", { name: /^Category:|^Choose a category$/ }).click();
    await page.waitForTimeout(700);
    const offered = (await sheet(page).innerText()).replace(/\s+/g, " ");
    const personalOnly = personalCats.filter((c) => !groupCats.some((g) => g.name === c.name)).map((c) => c.name);
    ok("6b. the picker lists the group's categories", groupCats.every((c) => offered.includes(c.name)), offered.slice(0, 160));
    ok("6c. and none of the owner's personal-only ones", !personalOnly.some((n) => new RegExp(`\\b${n}\\b`).test(offered)),
      personalOnly.filter((n) => new RegExp(`\\b${n}\\b`).test(offered)).join(", ") || "none leaked");
    const pick = groupCats.find((c) => c.name === "Bills") ?? groupCats[0];
    await sheet(page).getByRole("button", { name: new RegExp(pick.name) }).first().click();
    await page.waitForTimeout(500);
    await nameIt(page, gm);
    await swipe(page);
    const rg = await stored(user.id, gm);
    ok("6d. a group expense saves", rg !== null, rg?.tx.id ?? "not saved");
    if (rg) {
      created.push(rg.tx.id);
      ok("6e. its category belongs to the group namespace", rg.tx.category?.groupId === group.id,
        `${rg.tx.category?.name} groupId=${rg.tx.category?.groupId ?? "null (personal)"}`);
      ok("6f. and is the one that was picked", rg.tx.categoryId === pick.id, rg.tx.category?.name ?? "none");

      // It must read back correctly in the edit form's group picker.
      await openDetail(page, gm);
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await composer(page).waitFor({ timeout: 15000 });
      await page.waitForTimeout(700);
      const selected = await composer(page).getByRole("button", { name: /^Category:|^Choose a category$/ }).innerText();
      ok("6g. the edit composer shows that category as the current one", selected.includes(pick.name), `"${selected.replace(/\s+/g, " ").trim()}"`);
      await composer(page).getByRole("button", { name: "Cancel" }).click();
      await page.waitForTimeout(500);
    }

    // Personal stays personal.
    const pm = `ZFixCatPersonal-${tag}`;
    await openComposer(page);
    await type(page, "400");
    // Chosen, not seeded — there is no default to inherit any more.
    await composer(page).getByRole("button", { name: "Choose a category" }).click();
    await page.waitForTimeout(600);
    await sheet(page).getByRole("button", { name: new RegExp(personalCats[0].name) }).first().click();
    await page.waitForTimeout(500);
    await nameIt(page, pm);
    await swipe(page);
    const rp = await stored(user.id, pm);
    ok("6h. a personal expense saves", rp !== null, rp?.tx.id ?? "not saved");
    if (rp) {
      created.push(rp.tx.id);
      ok("6i. its category is the owner's own, not a group's", rp.tx.category?.groupId === null && rp.tx.category?.userId === user.id,
        `${rp.tx.category?.name} groupId=${rp.tx.category?.groupId ?? "null"}`);
    }

    // Group → Personal has to let go of the group's category too.
    await openComposer(page);
    await type(page, "300");
    await openGroupSplit(page, group.name);
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(600);
    const groupOnly = groupCats.find((c) => !personalCats.some((pc) => pc.name === c.name)) ?? groupCats[0];
    await composer(page).getByRole("button", { name: "Choose a category" }).click();
    await page.waitForTimeout(600);
    await sheet(page).getByRole("button", { name: new RegExp(groupOnly.name) }).first().click();
    await page.waitForTimeout(500);
    const asGroup = await composer(page).getByRole("button", { name: /^Category:|^Choose a category$/ }).innerText();
    await composer(page).getByRole("button", { name: "Personal", exact: true }).click();
    await page.waitForTimeout(900);
    const asPersonal = await composer(page).getByRole("button", { name: /^Category:|^Choose a category$/ }).innerText();
    // It goes back to unset rather than to some other category: the reader
    // picks the replacement, the composer does not pick one for them.
    ok("6j. a group category does not survive back into Personal",
      asGroup.includes(groupOnly.name) && !asPersonal.includes(groupOnly.name) && asPersonal.includes("Category"),
      `${asGroup.trim()} → ${asPersonal.trim()}`);
    await composer(page).getByRole("button", { name: "Close" }).click();
    await page.waitForTimeout(400);

    console.log(`\nCREATED: ${created.join(",")}`);
  } catch (e) {
    // Without this the suite lied. `process.exit()` in the finally block
    // discards whatever exception was in flight, so a section that threw
    // half way — a selector that stopped matching, say — vanished silently
    // and the run still printed "N/N checks passed" for the checks it had
    // managed to reach. A suite that hides its own failure is worse than one
    // that fails.
    ok("script error", false, e instanceof Error ? `${e.message.split("\n")[0]}` : String(e));
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
