// #239 — settling someone who belongs to several groups must ask which one.
//
// The server refuses to guess (settlement-group-inference), which left the
// payment untagged and the group still asking for the money. This proves the
// other half: the form asks, blocks until answered, and the answer reaches the
// ledger it names.
//
// Seeded data puts Rohan in "Flat 402" alone, so the same person answers both
// questions: not asked while one group holds him, asked once a second does.
// The extra group is removed at the end.

import { chromium, type Page } from "playwright";
import { prisma } from "../src/server/db";

const results: { name: string; pass: boolean; detail: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const EMAIL = "arjun@ledgerly.app";
const BASE = "http://localhost:3000";

/** The person page carries the settle button, but only while a balance stands. */
async function openSettle(page: Page, participantId: string) {
  await page.goto(`${BASE}/people/${participantId}`, { waitUntil: "load" });
  await page.getByRole("button", { name: /^Settle up/ }).first().click();
  await page.getByText(/pays you back|You pay/).first().waitFor();
}

const groupSelect = (page: Page) => page.getByRole("dialog").getByLabel("Group");
const submitBtn = (page: Page) => page.getByRole("button", { name: "Record payment", exact: true });

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(30000);
  let secondGroupId: string | null = null;

  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    const rohan = await prisma.participant.findFirstOrThrow({ where: { ownerId: user.id, displayName: "Rohan" } });

    let signedIn = false;
    for (let attempt = 0; attempt < 3 && !signedIn; attempt++) {
      await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForSelector('button[type="submit"]', { timeout: 30000 });
      await page.waitForTimeout(1500);
      await page.fill('input[type="email"]', EMAIL);
      await page.fill('input[type="password"]', "ledgerly-demo");
      await page.click('button[type="submit"]');
      try {
        await page.waitForURL("**/dashboard", { timeout: 30000 });
        signedIn = true;
      } catch {
        /* retry */
      }
    }
    if (!signedIn) throw new Error("Could not sign in after 3 attempts");

    // ── one group: unchanged, the server still infers ──
    await openSettle(page, rohan.id);
    ok("a person in exactly one group is not asked", !(await groupSelect(page).isVisible()));
    ok("and recording is not blocked", !(await submitBtn(page).isDisabled()));

    // ── a second group now holds him: the answer is no longer knowable ──
    secondGroupId = (
      await prisma.group.create({
        data: { name: "E2EChoiceTrip", createdById: user.id, members: { create: [{ participantId: rohan.id }] } },
      })
    ).id;

    await openSettle(page, rohan.id);
    ok("a person in several groups is asked which one", await groupSelect(page).isVisible());

    const options = await groupSelect(page).locator("option").allTextContents();
    ok(
      "both of that person's groups are offered, plus an opt-out",
      options.some((o) => /Flat 402/.test(o)) && options.some((o) => /E2EChoiceTrip/.test(o)) && options.some((o) => /Not for a group/.test(o)),
      options.join(" | ")
    );
    ok("recording is blocked until the question is answered", await submitBtn(page).isDisabled());

    // ── answering unblocks, and the answer reaches the ledger ──
    const chosen = await groupSelect(page).locator("option").filter({ hasText: "E2EChoiceTrip" }).first().getAttribute("value");
    await groupSelect(page).selectOption(chosen!, { force: true });
    ok("choosing a group unblocks recording", !(await submitBtn(page).isDisabled()));

    await page.getByRole("dialog").locator('input[placeholder="0"]').fill("11");
    await submitBtn(page).click({ force: true });
    await page.getByText("Payment recorded").first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);

    const written = await prisma.settlement.findFirst({
      where: { userId: user.id, participantId: rohan.id },
      orderBy: { settledAt: "desc" },
    });
    ok("the settlement is tagged to the group that was chosen", written?.groupId === secondGroupId, `groupId=${written?.groupId ?? "null"}`);
    if (written) await prisma.settlement.delete({ where: { id: written.id } });
  } catch (e) {
    ok("script error", false, String(e).slice(0, 300));
  } finally {
    if (secondGroupId) await prisma.group.delete({ where: { id: secondGroupId } }).catch(() => {});
    await prisma.$disconnect();
    await browser.close();
  }
}

main().then(() => {
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
});
