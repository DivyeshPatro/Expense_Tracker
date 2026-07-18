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

/** Scoped to the open modal panel — the transactions list behind it can
 * already contain rows whose text coincidentally matches a friend's name. */
function modal(page: Page) {
  return page.locator(".fixed.inset-0.z-\\[60\\]").first();
}

async function toggleParticipant(page: Page, name: string) {
  await modal(page).getByRole("button", { name, exact: false }).first().click();
}

async function removeParticipant(page: Page, name: string) {
  await modal(page).getByRole("button", { name: `Remove ${name} from the split` }).click();
}

async function selectByOptionText(page: Page, optionText: string): Promise<boolean> {
  const selects = modal(page).locator("select");
  const count = await selects.count();
  for (let i = 0; i < count; i++) {
    const opts = await selects.nth(i).locator("option").allTextContents();
    const match = opts.find((o) => o.includes(optionText));
    if (match) {
      await selects.nth(i).selectOption({ label: match });
      return true;
    }
  }
  return false;
}

/** Fills the EXACT-mode per-person input for `name`, found by locating that
 * person's own row rather than a fixed index — SplitEditor orders `selected`
 * by refData.participants' own (alphabetical) order, not click/toggle order,
 * so a fixed nth() silently grabs the wrong person's field. */
async function fillExactAmount(page: Page, name: string, amount: string) {
  const row = modal(page)
    .locator("div.flex.items-center.gap-2\\.5", { hasText: name })
    .filter({ has: page.locator('input[type="number"]') });
  await row.locator('input[type="number"]').fill(amount);
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
  const priya = await prisma.participant.findFirstOrThrow({ where: { ownerId: alice.id, displayName: "Priya" } });

  const txIds: string[] = [];
  const groupIds: string[] = [];

  try {
    await page.goto(`${BASE}/sign-in`, { waitUntil: "load" });
    await page.fill('input[type="email"]', "arjun@ledgerly.app");
    await page.fill('input[type="password"]', "ledgerly-demo");
    await page.click('button[type="submit"]');
    await page.waitForURL("**/dashboard", { timeout: 20000 });

    // ═══════════════════════ 1. Paid By defaults to Me ═══════════════════════
    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await page.click('button:has-text("＋ Add expense")');
    await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
    await page.fill('input[placeholder="0"]', "300");
    await page.fill('input[placeholder="e.g. Swiggy"]', `GEDefault-${suffix}`);
    await page.click("text=👥 Split with friends");
    await page.waitForSelector("text=Split between");
    await toggleParticipant(page, "Rohan");
    await page.getByRole("button", { name: "Add expense", exact: true }).click();
    await page.waitForSelector("text=Split expense added");
    const txDefault = await waitForSyncedTx(`GEDefault-${suffix}`);
    txIds.push(txDefault.id);
    ok("Paid By defaults to Me (paidByParticipantId null) when left untouched", txDefault.paidByParticipantId === null);

    // ═══════════════════════ 2. Paid By = someone else, and it affects settlement ═══════════════════════
    const beforeNets = await netBalances(alice.id);
    const rohanBefore = beforeNets.find((n) => n.id === rohan.id)?.net ?? 0;

    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await page.click('button:has-text("＋ Add expense")');
    await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
    await page.fill('input[placeholder="0"]', "2000");
    await page.fill('input[placeholder="e.g. Swiggy"]', `GEPaidByRohan-${suffix}`);
    await page.click("text=👥 Split with friends");
    await page.waitForSelector("text=Split between");
    await toggleParticipant(page, "Rohan");
    await page.waitForSelector('[aria-label="Paid by"]');
    await page.locator('[aria-label="Paid by"]').selectOption({ label: "Rohan" });
    const bodyBeforeSubmit = await modal(page).innerText();
    ok('the Split Between row for the selected payer shows a "paid" badge', /Rohan[\s\S]{0,10}·\s*paid/.test(bodyBeforeSubmit));
    await page.getByRole("button", { name: "Add expense", exact: true }).click();
    await page.waitForSelector("text=Split expense added");

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
    await page.click('button:has-text("＋ Add expense")');
    await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
    await page.fill('input[placeholder="0"]', "900");
    await page.fill('input[placeholder="e.g. Swiggy"]', `GEEqualTwo-${suffix}`);
    await page.click("text=👥 Split with friends");
    await page.waitForSelector("text=Split between");
    await toggleParticipant(page, "Rohan");
    await page.getByRole("button", { name: "Add expense", exact: true }).click();
    await page.waitForSelector("text=Split expense added");
    const txEqualTwo = await waitForSyncedTx(`GEEqualTwo-${suffix}`);
    txIds.push(txEqualTwo.id);
    const rohanShareEqualTwo = txEqualTwo.splits.find((s) => s.participantId === rohan.id)?.owedAmount;
    ok("equal split, two-person (you + Rohan): ₹900 → ₹450 each", Number(rohanShareEqualTwo) === 45000, String(rohanShareEqualTwo));

    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await page.click('button:has-text("＋ Add expense")');
    await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
    await page.fill('input[placeholder="0"]', "900");
    await page.fill('input[placeholder="e.g. Swiggy"]', `GEEqualMulti-${suffix}`);
    await page.click("text=👥 Split with friends");
    await page.waitForSelector("text=Split between");
    await toggleParticipant(page, "Rohan");
    await toggleParticipant(page, "Karan");
    await toggleParticipant(page, "Priya");
    await page.getByRole("button", { name: "Add expense", exact: true }).click();
    await page.waitForSelector("text=Split expense added");
    const txEqualMulti = await waitForSyncedTx(`GEEqualMulti-${suffix}`);
    txIds.push(txEqualMulti.id);
    ok(
      "equal split, multi-person (you + 3 friends): ₹900 → ₹225 each",
      txEqualMulti.splits.every((s) => Number(s.owedAmount) === 22500) && txEqualMulti.splits.length === 4,
      JSON.stringify(txEqualMulti.splits.map((s) => Number(s.owedAmount)))
    );

    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await page.click('button:has-text("＋ Add expense")');
    await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
    await page.fill('input[placeholder="0"]', "1000");
    await page.fill('input[placeholder="e.g. Swiggy"]', `GEExact-${suffix}`);
    await page.click("text=👥 Split with friends");
    await page.waitForSelector("text=Split between");
    await toggleParticipant(page, "Rohan");
    await toggleParticipant(page, "Karan");
    await page.getByRole("button", { name: "Exact amounts", exact: true }).click();
    await fillExactAmount(page, "Rohan", "300");
    await fillExactAmount(page, "Karan", "200");
    await page.getByRole("button", { name: "Add expense", exact: true }).click();
    await page.waitForSelector("text=Split expense added");
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
    await page.click('button:has-text("＋ Add expense")');
    await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
    await page.fill('input[placeholder="0"]', "600");
    await page.fill('input[placeholder="e.g. Swiggy"]', `GERemove-${suffix}`);
    await page.click("text=👥 Split with friends");
    await page.waitForSelector("text=Split between");
    await toggleParticipant(page, "Rohan");
    await toggleParticipant(page, "Karan");
    const infoWithTwo = await modal(page).locator("text=/each · you \\+ 2 friends/").isVisible();
    ok("split info shows 2 friends before removal", infoWithTwo);
    await removeParticipant(page, "Karan");
    await page.waitForTimeout(150);
    const infoWithOne = await modal(page).locator("text=/each · you \\+ 1 friend$/").isVisible();
    ok("removing a participant immediately updates the split math (2 friends -> 1)", infoWithOne);
    const lastRemoveBtn = modal(page).getByRole("button", { name: "Remove Rohan from the split" });
    ok("the ✕ on the LAST remaining participant is disabled (can't remove down to zero)", await lastRemoveBtn.isDisabled());
    await page.getByRole("button", { name: "Add expense", exact: true }).click();
    await page.waitForSelector("text=Split expense added");
    const txRemove = await waitForSyncedTx(`GERemove-${suffix}`);
    txIds.push(txRemove.id);
    ok(
      "the removed participant never made it into the submitted split",
      !txRemove.splits.some((s) => s.participantId === karan.id) && txRemove.splits.some((s) => s.participantId === rohan.id)
    );

    // ═══════════════════════ 5. Personal (non-group) expense flow is unchanged ═══════════════════════
    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await page.click('button:has-text("＋ Add expense")');
    await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
    await page.fill('input[placeholder="0"]', "150");
    await page.fill('input[placeholder="e.g. Swiggy"]', `GEPersonal-${suffix}`);
    const personalCatSelectCount = await modal(page).locator("select").count();
    await page.getByRole("button", { name: "Add expense", exact: true }).click();
    await page.waitForSelector("text=Expense added");
    const txPersonal = await waitForSyncedTx(`GEPersonal-${suffix}`);
    txIds.push(txPersonal.id);
    ok("a personal (no group) expense still gets a categoryId from the personal list", !!txPersonal.categoryId);
    ok("a personal expense never gets a groupId", txPersonal.groupId === null);
    ok("a personal expense's form has exactly the pre-existing select count (account+category+group — no group-category machinery engaged)", personalCatSelectCount === 3, String(personalCatSelectCount));

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
    await page.click('button:has-text("＋ Add expense")');
    await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
    await page.fill('input[placeholder="0"]', "500");
    await page.fill('input[placeholder="e.g. Swiggy"]', `GECatTest-${suffix}`);
    await selectByOptionText(page, groupName);
    // GroupCategorySelect renders "Uncategorized" + "+ Create New Category"
    // immediately on mount and fills in real categories only once its fetch
    // resolves — wait for an actual seeded category, not the static chrome.
    await waitForModalText(page, "Food");
    const groupDropdownBody = await modal(page).innerText();
    ok(
      "switching to a group swaps the category dropdown to the group's own list (personal categories like Electricity/Fuel disappear)",
      groupDropdownBody.includes("Food") && !groupDropdownBody.includes("Fuel") && !groupDropdownBody.includes("Insurance")
    );
    const categorySelect = modal(page).locator('div.label-caps:text-is("CATEGORY") + select');
    await categorySelect.selectOption({ label: "+ Create New Category" });
    await page.waitForSelector('input[placeholder="New category name"]');
    await page.fill('input[placeholder="New category name"]', `Pool Maintenance ${suffix}`);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.waitForTimeout(600);
    const newCatSelected = await categorySelect.inputValue();
    const newCat = await prisma.category.findFirstOrThrow({ where: { groupId: flat.id, name: `Pool Maintenance ${suffix}` } });
    ok('"+ Create New Category" creates it scoped to the group and auto-selects it', newCatSelected === newCat.id);
    await page.getByRole("button", { name: "Add expense", exact: true }).click();
    await page.waitForSelector("text=Expense added");
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
    await page.click('button:has-text("＋ Add expense")');
    await page.waitForSelector('input[placeholder="e.g. Swiggy"]');
    const dateTrigger = modal(page).getByRole("button", { name: /\d{4}$/ }); // "17 Jul 2026"-shaped trigger
    await dateTrigger.click();
    await page.waitForSelector('[role="dialog"][aria-label="Choose date"]');
    ok("no native browser date input is used anywhere in the form", (await modal(page).locator('input[type="date"]').count()) === 0);
    await page.locator('[aria-label="Month"]').selectOption({ label: "Jan" });
    await page.waitForTimeout(100);
    const dayCell = page.locator('[data-day="15"]').first();
    await dayCell.click();
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
    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await page.click('button[aria-label="Quick add (desktop)"]');
    await page.getByRole("button", { name: "💰 Income" }).click();
    await page.waitForSelector('input[placeholder="e.g. Salary · Acme Corp"]');
    const incomeDateTrigger = modal(page).getByRole("button", { name: /\d{4}$/ });
    ok(
      "Add Income uses the same themed DateField, not a native picker",
      (await modal(page).locator('input[type="date"]').count()) === 0 && (await incomeDateTrigger.count()) >= 1
    );

    await page.goto(`${BASE}/transactions?p=all`, { waitUntil: "load" });
    await page.click('button[aria-label="Quick add (desktop)"]');
    await page.getByRole("button", { name: "⇄ Transfer" }).click();
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
