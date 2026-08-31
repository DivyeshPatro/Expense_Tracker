// Group Expenses UX sprint — Paid By, group-owned categories, participant
// removal, and the themed date picker. Combines Prisma-direct assertions
// (settlement math, category isolation) with real-browser UI flows (the
// redesigned SplitEditor, GroupCategorySelect, DateField), following this
// project's established hybrid pattern.
// Run: npx tsx scripts/e2e-group-expenses.ts
import { randomUUID } from "node:crypto";
import { chromium, type Page } from "playwright";
import { prisma } from "../src/server/db";
import { netBalances } from "../src/server/services/shared";
import { createGroup } from "../src/server/services/groups";
import { applyBalances } from "../src/server/services/transactions";

const BASE = "http://localhost:3000";
const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

/** Scoped to the topmost open sheet — the transactions list behind it can
 * already contain rows whose text coincidentally matches a friend's name.
 *
 * Adding an expense is the full-screen composer now, and every field it does
 * not put on the first screen (split, category, date, merchant) lives in a
 * BottomSheet opened from a chip. Those sheets ARE role="dialog", and they
 * render the same SplitEditor / DateField / MerchantInput the classic modal
 * did — so everything below still drives the real controls, just reached
 * through the composer rather than through one long scrolling form. */
function modal(page: Page) {
  return page.getByRole("dialog").last();
}

/** The composer itself. Present only while it is open. */
const composer = (page: Page) => page.locator("div[data-composer]");

const KEY_ARIA: Record<string, string> = { ".": "Decimal point" };

/** Open the composer from the Spending screen and tap in an amount. */
async function openComposer(page: Page, amount: string) {
  await page.click('button:has-text("＋ Add expense")');
  await composer(page).waitFor({ timeout: 20000 });
  await composer(page).getByRole("button", { name: "Clear amount" }).click();
  for (const ch of amount) {
    await composer(page).getByRole("button", { name: KEY_ARIA[ch] ?? ch, exact: true }).click();
    await page.waitForTimeout(50);
  }
}

/** The merchant lives behind the "Who's it for?" sheet. */
async function setMerchant(page: Page, merchant: string) {
  await composer(page).getByRole("button", { name: "Merchant and notes" }).click();
  await page.waitForTimeout(400);
  await modal(page).locator("input").first().fill(merchant);
  await modal(page).getByRole("button", { name: "Done", exact: true }).click();
  await page.waitForTimeout(300);
}

/** Open one of the composer's chips by its accessible name. */
async function openChip(page: Page, name: RegExp) {
  await composer(page).getByRole("button", { name }).click();
  await page.waitForTimeout(500);
}

/** Close whichever sheet is on top. */
async function sheetDone(page: Page) {
  await modal(page).getByRole("button", { name: "Done", exact: true }).click();
  await page.waitForTimeout(350);
}

/** Drag the confirm handle the whole way — the composer has no Save button. */
async function saveComposer(page: Page) {
  // A sheet left open sits over the swipe track. Closing it is what a person
  // does too — the sheet's own Done is the way back to the screen.
  while (await page.getByRole("dialog").count()) {
    const done = page.getByRole("dialog").last().getByRole("button", { name: "Done", exact: true });
    if (!(await done.count())) break;
    await done.click();
    await page.waitForTimeout(350);
  }
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
  await composer(page).waitFor({ state: "detached", timeout: 20000 });
  await page.waitForTimeout(300);
}

/** Open the split sheet and make sure the split itself is switched on.
 *  The line reads "Choose who's splitting" until somebody is chosen and
 *  "N people · <mode>" after — either way it is the way in. */
async function openSplit(page: Page) {
  await openChip(page, /people ·|Choose who's splitting|Split with someone/);
  const sw = modal(page).locator('[role="switch"]').first();
  if ((await sw.getAttribute("aria-checked")) !== "true") {
    await modal(page).getByText("👥 Split with friends").first().click();
    await page.waitForTimeout(250);
  }
  // Whoever the entry point pre-ticked is not what these cases are about —
  // each one names its own people, so start from nobody.
  for (const b of await modal(page).locator('button[aria-pressed="true"]').all()) {
    await b.click();
    await page.waitForTimeout(80);
  }
}

async function toggleParticipant(page: Page, name: string) {
  await modal(page).getByRole("button", { name, exact: false }).first().click();
}

async function removeParticipant(page: Page, name: string) {
  await modal(page).getByRole("button", { name: `Remove ${name} from the split` }).click();
}

/** Choose a group by name from the composer's group sheet.
 *  The way in is the Personal|Group segmented control above the amount. */
async function selectGroup(page: Page, groupName: string): Promise<boolean> {
  await composer(page).getByRole("group", { name: "Personal or group" }).getByRole("button").last().click();
  await page.waitForTimeout(500);
  const row = modal(page).getByRole("button", { name: new RegExp(groupName) }).first();
  if (!(await row.count())) return false;
  await row.click();
  await page.waitForTimeout(700);
  // Choosing a group that has members opens the split sheet straight away,
  // which is right for a person and in the way of a category assertion.
  if (await modal(page).getByRole("button", { name: "Done", exact: true }).count()) await sheetDone(page);
  return true;
}

/** Fills the EXACT-mode per-person input for `name`, found by locating that
 * person's own row rather than a fixed index — SplitEditor orders `selected`
 * by refData.participants' own (alphabetical) order, not click/toggle order,
 * so a fixed nth() silently grabs the wrong person's field. */
async function fillExactAmount(page: Page, name: string, amount: string) {
  const row = modal(page)
    .locator("div.flex.items-center.gap-2\\.5", { hasText: name })
    .filter({ has: page.locator('input[type="number"]') });
  const input = row.locator('input[type="number"]');
  await input.fill(amount);
  // Committing the field is what the editor listens for — redistribution runs
  // on blur, deliberately, so it cannot move the other boxes while a number is
  // still being typed. Filling straight from one field into the next left the
  // previous one uncommitted and raced its rebalance against this one's value:
  // measured, it put "366.66200" in a number input. A person tabbing away, or
  // reaching for Save, blurs; the suite has to as well.
  await input.blur();
  await page.waitForTimeout(150);
}

/** `<option>` elements inside a closed `<select>` never register as "visible"
 * to Playwright's actionability checks, so waitForSelector on their text
 * hangs forever even once the option is genuinely in the DOM — poll the
 * modal's rendered text instead. */
async function waitForModalText(page: Page, text: string, tries = 75) {
  for (let i = 0; i < tries; i++) {
    if ((await modal(page).innerText()).includes(text)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`text "${text}" never appeared in the modal within ${tries * 200}ms`);
}

/** Server creates go through the offline outbox before landing in Postgres —
 * the UI's success toast only confirms the intent was queued, not synced.
 * Poll instead of guessing a fixed delay. */
async function waitForSyncedTx(merchant: string) {
  for (let i = 0; i < 30; i++) {
    const tx = await prisma.transaction.findFirst({ where: { merchant }, include: { splits: true } });
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`transaction with merchant "${merchant}" never synced to the server within 9s`);
}

async function main() {
  const suffix = randomUUID().slice(0, 8);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(30000);

  const alice = await prisma.user.findFirstOrThrow({ where: { email: "arjun@ledgerly.app" } });
  const rohan = await prisma.participant.findFirstOrThrow({ where: { ownerId: alice.id, displayName: "Rohan" } });
  const karan = await prisma.participant.findFirstOrThrow({ where: { ownerId: alice.id, displayName: "Karan" } });
  await prisma.participant.findFirstOrThrow({ where: { ownerId: alice.id, displayName: "Priya" } }); // precondition: seed data has Priya

  const txIds: string[] = [];
  const groupIds: string[] = [];

  try {
    await page.goto(`${BASE}/sign-in`, { waitUntil: "load" });
    await page.fill('input[type="email"]', "arjun@ledgerly.app");
    await page.fill('input[type="password"]', "ledgerly-demo");
    // The submit button stays disabled until React hydrates (auth-form.tsx
    // gates it on "busy || !hydrated"), which a cold dev compile makes slow.
    await page.waitForFunction(() => {
      const b = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
      return !!b && !b.disabled;
    }, undefined, { timeout: 60000 });
    await page.click('button[type="submit"]');
    await page.waitForURL("**/dashboard", { timeout: 20000 });

    // ═══════════════════════ 1. Paid By defaults to Me ═══════════════════════
    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await openComposer(page, "300");
    await setMerchant(page, `GEDefault-${suffix}`);
    await openSplit(page);
    await page.waitForSelector("text=Split between");
    await toggleParticipant(page, "Rohan");
    await saveComposer(page);
    const txDefault = await waitForSyncedTx(`GEDefault-${suffix}`);
    txIds.push(txDefault.id);
    ok("Paid By defaults to Me (paidByParticipantId null) when left untouched", txDefault.paidByParticipantId === null);

    // ═══════════════════════ 2. Paid By = someone else, and it affects settlement ═══════════════════════
    const beforeNets = await netBalances(alice.id);
    const rohanBefore = beforeNets.find((n) => n.id === rohan.id)?.net ?? 0;

    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await openComposer(page, "2000");
    await setMerchant(page, `GEPaidByRohan-${suffix}`);
    await openSplit(page);
    await page.waitForSelector("text=Split between");
    await toggleParticipant(page, "Rohan");
    await page.waitForSelector('[aria-label="Paid by"]');
    await page.locator('[aria-label="Paid by"]').selectOption({ label: "Rohan" });
    const bodyBeforeSubmit = await modal(page).innerText();
    ok('the Split Between row for the selected payer shows a "paid" badge', /Rohan[\s\S]{0,10}·\s*paid/.test(bodyBeforeSubmit));
    await saveComposer(page);

    const txPaidByRohan = await waitForSyncedTx(`GEPaidByRohan-${suffix}`);
    txIds.push(txPaidByRohan.id);
    ok("Paid By persists the selected participant, not the creator", txPaidByRohan.paidByParticipantId === rohan.id);
    ok("a friend-paid expense doesn't touch the owner's own account (accountId null)", txPaidByRohan.accountId === null);

    const afterNets = await netBalances(alice.id);
    const rohanAfter = afterNets.find((n) => n.id === rohan.id)?.net ?? 0;
    // EQUAL split of ₹2000 between Alice + Rohan, Rohan paid: Alice owes her
    // ₹1000 share to Rohan — his net (positive = they owe you) DECREASES by 1000
    ok(
      "settlement math reflects the selected payer, not the creator (Rohan's net drops by his share paid on Alice's behalf)",
      rohanAfter === rohanBefore - 100000,
      `before=${rohanBefore}, after=${rohanAfter}, delta=${rohanAfter - rohanBefore}`
    );

    // ═══════════════════════ 3. Split modes: equal / exact / two-person / multi-person ═══════════════════════
    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await openComposer(page, "900");
    await setMerchant(page, `GEEqualTwo-${suffix}`);
    await openSplit(page);
    await page.waitForSelector("text=Split between");
    await toggleParticipant(page, "Rohan");
    await saveComposer(page);
    const txEqualTwo = await waitForSyncedTx(`GEEqualTwo-${suffix}`);
    txIds.push(txEqualTwo.id);
    const rohanShareEqualTwo = txEqualTwo.splits.find((s) => s.participantId === rohan.id)?.owedAmount;
    ok("equal split, two-person (you + Rohan): ₹900 → ₹450 each", Number(rohanShareEqualTwo) === 45000, String(rohanShareEqualTwo));

    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await openComposer(page, "900");
    await setMerchant(page, `GEEqualMulti-${suffix}`);
    await openSplit(page);
    await page.waitForSelector("text=Split between");
    await toggleParticipant(page, "Rohan");
    await toggleParticipant(page, "Karan");
    await toggleParticipant(page, "Priya");
    await saveComposer(page);
    const txEqualMulti = await waitForSyncedTx(`GEEqualMulti-${suffix}`);
    txIds.push(txEqualMulti.id);
    ok(
      "equal split, multi-person (you + 3 friends): ₹900 → ₹225 each",
      txEqualMulti.splits.every((s) => Number(s.owedAmount) === 22500) && txEqualMulti.splits.length === 4,
      JSON.stringify(txEqualMulti.splits.map((s) => Number(s.owedAmount)))
    );

    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await openComposer(page, "1000");
    await setMerchant(page, `GEExact-${suffix}`);
    await openSplit(page);
    await page.waitForSelector("text=Split between");
    await toggleParticipant(page, "Rohan");
    await toggleParticipant(page, "Karan");
    await page.getByRole("button", { name: "Exact amounts", exact: true }).click();
    await fillExactAmount(page, "Rohan", "300");
    await fillExactAmount(page, "Karan", "200");
    await saveComposer(page);
    const txExact = await waitForSyncedTx(`GEExact-${suffix}`);
    txIds.push(txExact.id);
    const rohanExact = Number(txExact.splits.find((s) => s.participantId === rohan.id)?.owedAmount);
    const karanExact = Number(txExact.splits.find((s) => s.participantId === karan.id)?.owedAmount);
    const myExact = Number(txExact.splits.find((s) => s.participantId === null)?.owedAmount);
    ok(
      "exact-amount split: ₹300 Rohan, ₹200 Karan, remainder ₹500 to you",
      rohanExact === 30000 && karanExact === 20000 && myExact === 50000,
      `rohan=${rohanExact}, karan=${karanExact}, me=${myExact}`
    );

    // ═══════════════════════ 4. Remove participant + guard the last one ═══════════════════════
    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await openComposer(page, "600");
    await setMerchant(page, `GERemove-${suffix}`);
    await openSplit(page);
    await page.waitForSelector("text=Split between");
    await toggleParticipant(page, "Rohan");
    await toggleParticipant(page, "Karan");
    const breakdownWithTwo = await modal(page).innerText();
    ok("the split breakdown shows ₹200 each across you + 2 friends", breakdownWithTwo.includes("₹200"), breakdownWithTwo.slice(0, 160).replace(/\n/g, " | "));
    await removeParticipant(page, "Karan");
    await page.waitForTimeout(400);
    const breakdownWithOne = await modal(page).innerText();
    ok(
      "removing a participant immediately updates the split math (₹200 each -> ₹300 each)",
      breakdownWithOne.includes("₹300") && !(await modal(page).getByRole("button", { name: "Remove Karan from the split" }).count()),
      breakdownWithOne.slice(0, 160).replace(/\n/g, " | ")
    );
    const lastRemoveBtn = modal(page).getByRole("button", { name: "Remove Rohan from the split" });
    ok("the ✕ on the LAST remaining participant is disabled (can't remove down to zero)", await lastRemoveBtn.isDisabled());
    await saveComposer(page);
    const txRemove = await waitForSyncedTx(`GERemove-${suffix}`);
    txIds.push(txRemove.id);
    ok(
      "the removed participant never made it into the submitted split",
      !txRemove.splits.some((s) => s.participantId === karan.id) && txRemove.splits.some((s) => s.participantId === rohan.id)
    );

    // ═══════════════════════ 5. Personal (non-group) expense flow is unchanged ═══════════════════════
    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await openComposer(page, "150");
    await setMerchant(page, `GEPersonal-${suffix}`);
    await openChip(page, /^Category:|Choose a category/);
    const personalCategoryBody = await modal(page).innerText();
    await modal(page).getByRole("button", { name: /Groceries|Grocery/ }).first().click();
    await page.waitForTimeout(400);
    // The composer has no <select> at all — group and category are sheets of
    // buttons. What the old count was really asserting is that a personal
    // expense engages no group-category machinery, so assert that directly:
    // the group line still says Personal.
    // "Personal" is the pressed half of the segmented control while no group
    // is in play — that is what "engages no group-category machinery" means
    // on this screen.
    const personalPressed = await composer(page)
      .getByRole("group", { name: "Personal or group" })
      .getByRole("button")
      .first()
      .getAttribute("aria-pressed");
    await saveComposer(page);
    const txPersonal = await waitForSyncedTx(`GEPersonal-${suffix}`);
    txIds.push(txPersonal.id);
    ok("a personal (no group) expense takes its category from the personal list", !!txPersonal.categoryId);
    ok(
      "the personal list is the one on offer, not a group's",
      personalCategoryBody.includes("Fuel") || personalCategoryBody.includes("Insurance"),
      personalCategoryBody.slice(0, 120).replace(/\n/g, " | ")
    );
    ok("a personal expense never gets a groupId", txPersonal.groupId === null);
    ok(
      "a personal expense's form engages no group-category machinery (no group is in play)",
      personalPressed === "true",
      String(personalPressed)
    );

    // ═══════════════════════ 6. Group categories: isolation + persistence + "+ Create New Category" ═══════════════════════
    const groupName = `GEFlat-${suffix}`;
    await createGroup(alice.id, groupName, [rohan.id]);
    const flat = await prisma.group.findFirstOrThrow({ where: { name: groupName, createdById: alice.id } });
    groupIds.push(flat.id);
    const defaultCats = await prisma.category.findMany({ where: { groupId: flat.id } });
    ok("createGroup seeds exactly the 9 default group categories", defaultCats.length === 9, String(defaultCats.length));
    ok(
      "the default set matches the spec exactly",
      ["Food", "Grocery", "Rent", "Bills", "Shopping", "Transport", "Entertainment", "Travel", "Miscellaneous"].every((n) =>
        defaultCats.some((c) => c.name === n)
      )
    );

    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await openComposer(page, "500");
    await setMerchant(page, `GECatTest-${suffix}`);
    await selectGroup(page, groupName);
    // The category sheet is filled from the same listGroupCategoriesAction the
    // classic select used, so it too shows nothing real until the fetch lands.
    await openChip(page, /^Category:|Choose a category/);
    await waitForModalText(page, "Food");
    const groupCategoryBody = await modal(page).innerText();
    ok(
      "switching to a group swaps the category list to the group's own (personal categories like Electricity/Fuel disappear)",
      groupCategoryBody.includes("Food") && !groupCategoryBody.includes("Fuel") && !groupCategoryBody.includes("Insurance")
    );
    // Naming a category while recording the expense that needs it: the classic
    // form's "+ Create New Category", in the composer's sheet.
    await modal(page).getByRole("button", { name: /New category/ }).click();
    await page.waitForSelector('input[placeholder="New category name"]');
    await page.fill('input[placeholder="New category name"]', `Pool Maintenance ${suffix}`);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.waitForTimeout(900);
    const newCat = await prisma.category.findFirstOrThrow({ where: { groupId: flat.id, name: `Pool Maintenance ${suffix}` } });
    const catChipLabel = await composer(page)
      .getByRole("button", { name: /^Category:|Choose a category/ })
      .first()
      .getAttribute("aria-label");
    ok(
      '"+ New category" creates it scoped to the group and auto-selects it',
      (catChipLabel ?? "").includes(`Pool Maintenance ${suffix}`),
      String(catChipLabel)
    );
    await saveComposer(page);
    const txGroupCat = await waitForSyncedTx(`GECatTest-${suffix}`);
    txIds.push(txGroupCat.id);
    ok("the custom group category was actually applied to the transaction", txGroupCat.categoryId === newCat.id);

    // isolation: the new category must never appear for a DIFFERENT group or personal use
    const otherGroupName = `GEOtherFlat-${suffix}`;
    await createGroup(alice.id, otherGroupName, []);
    const otherFlat = await prisma.group.findFirstOrThrow({ where: { name: otherGroupName, createdById: alice.id } });
    groupIds.push(otherFlat.id);
    const otherGroupCats = await prisma.category.findMany({ where: { groupId: otherFlat.id } });
    ok("a brand-new different group never sees another group's custom category", !otherGroupCats.some((c) => c.id === newCat.id));
    const alicePersonalCats = await prisma.category.findMany({ where: { userId: alice.id } });
    ok("group categories never leak into the owner's personal category list", !alicePersonalCats.some((c) => c.id === newCat.id));
    ok("personal categories never leak into the group's category list", !defaultCats.some((c) => alicePersonalCats.some((pc) => pc.id === c.id)));

    // persistence: categories are tied to the group row, not to any one
    // member's presence — removing a member must never touch them (literal
    // "creator leaves" is blocked by leaveGroup's own pre-existing, unrelated
    // ownership-transfer gap — this verifies the actual underlying property:
    // no FK/cascade from Category to any individual membership row)
    const { removeGroupMember } = await import("../src/server/services/groups");
    const rohanParticipantInFlat = await prisma.groupMember.findFirstOrThrow({ where: { groupId: flat.id, participantId: rohan.id } });
    await removeGroupMember(alice.id, flat.id, rohanParticipantInFlat.participantId);
    const catsAfterMemberLeft = await prisma.category.findMany({ where: { groupId: flat.id } });
    ok(
      "group categories persist after a member is removed (no cascade tied to any one membership row)",
      catsAfterMemberLeft.length === defaultCats.length + 1, // 9 defaults + the custom one
      String(catsAfterMemberLeft.length)
    );

    // ═══════════════════════ 7. Date picker ═══════════════════════
    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await openComposer(page, "100");
    // The composer's date chip opens a sheet holding the SAME DateField, whose
    // own trigger then opens the themed calendar.
    await openChip(page, /^Date:/);
    const dateTrigger = modal(page).getByRole("button", { name: /\d{4}$/ }); // "17 Jul 2026"-shaped trigger
    await dateTrigger.click();
    await page.waitForSelector('[role="dialog"][aria-label="Choose date"]');
    ok("no native browser date input is used anywhere in the form", (await page.locator('input[type="date"]').count()) === 0);
    await page.locator('[aria-label="Month"]').selectOption({ label: "Jan" });
    await page.waitForTimeout(100);
    const dayCell = page.locator('[data-day="15"]').first();
    await dayCell.click();
    await page.waitForTimeout(250);
    const dateNowShown = await dateTrigger.innerText();
    ok("picking a day in the themed calendar updates the field (month + day applied)", dateNowShown.includes("Jan") && dateNowShown.includes("15"));

    // keyboard: Escape closes without changing anything already committed
    await dateTrigger.click();
    await page.waitForSelector('[role="dialog"][aria-label="Choose date"]');
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    ok("Escape closes the calendar popover", !(await page.locator('[role="dialog"][aria-label="Choose date"]').isVisible()));

    // same component reused across forms: Income and Transfer quick-add.
    // page.goto (not Escape — there's no global Escape-to-close for this
    // modal, only for the mobile sheets) guarantees a clean, un-obstructed
    // reload before each new modal is opened.
    // Same component reused across entry surfaces: a Credit in the composer,
    // and a Transfer in the classic modal it deliberately still uses.
    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await page.getByRole("button", { name: /quick add/i }).filter({ visible: true }).first().click();
    await page.getByRole("button", { name: /Add income/i }).filter({ visible: true }).first().click();
    await composer(page).waitFor({ timeout: 20000 });
    await composer(page).getByRole("button", { name: /Credit/ }).click();
    await page.waitForTimeout(300);
    await openChip(page, /^Date:/);
    const incomeDateTrigger = modal(page).getByRole("button", { name: /\d{4}$/ });
    ok(
      "a Credit uses the same themed DateField, not a native picker",
      (await page.locator('input[type="date"]').count()) === 0 && (await incomeDateTrigger.count()) >= 1
    );

    await page.goto(`${BASE}/accounts`, { waitUntil: "load" });
    await page.getByRole("button", { name: /quick add/i }).filter({ visible: true }).first().click();
    await page.getByRole("button", { name: /Transfer money/i }).filter({ visible: true }).first().click();
    await page.waitForSelector('input[placeholder="0"]');
    ok("Add Transfer uses the same themed DateField, not a native picker", (await modal(page).locator('input[type="date"]').count()) === 0);
  } catch (e) {
    ok("script error", false, String(e).slice(0, 800));
    await page.screenshot({ path: "e2e-output/group-expenses-error.png", fullPage: true }).catch(() => {});
  } finally {
    for (const id of txIds) {
      const t = await prisma.transaction.findUnique({ where: { id } });
      if (t && t.deletedAt === null && t.accountId) await applyBalances(prisma, t, -1);
    }
    await prisma.expenseSplit.deleteMany({ where: { txId: { in: txIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...txIds, ...groupIds] } } });
    await prisma.intent.deleteMany({ where: { entityId: { in: txIds } } });
    await prisma.transaction.deleteMany({ where: { id: { in: txIds } } });
    await prisma.groupMember.deleteMany({ where: { groupId: { in: groupIds } } });
    await prisma.group.deleteMany({ where: { id: { in: groupIds } } }); // cascades categories
    await browser.close();
  }
}

main()
  .catch((e) => {
    ok("script error", false, String(e).slice(0, 800));
  })
  .finally(async () => {
    await prisma.$disconnect();
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  });
