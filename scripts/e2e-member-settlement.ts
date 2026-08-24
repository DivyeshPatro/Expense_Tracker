// #240 — a payment between two members is recordable from inside the group.
//
// The plan has always routed one member straight to another; those rows used to
// read "between them — settle outside the app", so the shortest plan contained
// rows the app could not act on. This drives the real UI: the Settle button on
// such a row, in both readings of the list, the dedicated form it opens, and
// the row disappearing once the payment is recorded.
//
// The seeded group has the owner paying everything, so no member owes another.
// This builds the shape that produces member→member rows — one member fronting
// a bill the others share — and removes it at the end.

import { chromium, type Page } from "playwright";
import { prisma } from "../src/server/db";

const results: { name: string; pass: boolean; detail: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const EMAIL = "arjun@ledgerly.app";
const BASE = "http://localhost:3000";
const rup = (n: number) => Math.round(n * 100);

const dialog = (page: Page) => page.getByRole("dialog");
/** The member→member Settle button, identified by the pair it names. */
const memberSettleBtn = (page: Page, from: string, to: string) => page.getByRole("button", { name: `Settle ${from} pays ${to}` });

async function openGroup(page: Page, groupId: string) {
  await page.goto(`${BASE}/shared/groups/${groupId}`, { waitUntil: "load" });
  await page.getByText(/Settle up|All settled/).first().waitFor();
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(30000);
  let groupId: string | null = null;

  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    const [rohan, karan, priya] = await Promise.all(
      ["Rohan", "Karan", "Priya"].map((displayName) => prisma.participant.findFirstOrThrow({ where: { ownerId: user.id, displayName } }))
    );

    groupId = (
      await prisma.group.create({
        data: {
          name: "E2EMemberSettle",
          createdById: user.id,
          members: { create: [rohan, karan, priya].map((p) => ({ participantId: p.id })) },
        },
      })
    ).id;
    // Rohan fronts ₹400 split four ways: Karan and Priya owe HIM, not the owner.
    await prisma.transaction.create({
      data: {
        userId: user.id,
        type: "EXPENSE",
        amount: rup(400),
        merchant: "E2EMemberDinner",
        occurredAt: new Date(),
        groupId,
        paidByParticipantId: rohan.id,
        splits: {
          create: [
            { participantId: null, owedAmount: rup(100) },
            { participantId: rohan.id, owedAmount: rup(100) },
            { participantId: karan.id, owedAmount: rup(100) },
            { participantId: priya.id, owedAmount: rup(100) },
          ],
        },
      },
    });

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

    // ── Simplify ON: the minimised plan ──
    await openGroup(page, groupId);
    const body = await page.locator("body").innerText();
    ok("the old non-actionable state is gone", !body.includes("between them"));
    ok("Simplify ON offers Settle on a member→member row", await memberSettleBtn(page, "Karan", "Rohan").first().isVisible());

    // ── the dedicated form ──
    await memberSettleBtn(page, "Karan", "Rohan").first().click();
    await dialog(page).getByText("pays").first().waitFor();
    const modal = await dialog(page).innerText();
    ok("the modal states who pays whom", /Karan\s+pays\s+Rohan/.test(modal.replace(/\n/g, " ")), modal.split("\n").slice(0, 3).join(" | "));
    ok("the modal shows the amount", (await dialog(page).locator('input[placeholder="0"]').inputValue()) === "100");
    ok("no account selector", (await dialog(page).getByLabel("ACCOUNT").count()) === 0);
    ok(
      "no owner direction selector",
      !/pays you back|You pay .* back/.test(modal) && (await dialog(page).getByRole("button", { name: /^(Pays you|You pay)$/ }).count()) === 0
    );
    ok("the primary action is Settle payment", await page.getByRole("button", { name: "Settle payment", exact: true }).isVisible());

    // ── recording it ──
    await page.getByRole("button", { name: "Settle payment", exact: true }).click({ force: true });
    await page.getByText("Payment recorded").first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);

    const written = await prisma.settlement.findFirstOrThrow({ where: { userId: user.id, groupId }, orderBy: { settledAt: "desc" } });
    ok(
      "it records as A → B with no owner side and no cash leg",
      written.fromParticipantId === karan.id &&
        written.toParticipantId === rohan.id &&
        written.participantId === null &&
        written.direction === null &&
        written.transactionId === null,
      `from=${written.fromParticipantId === karan.id} to=${written.toParticipantId === rohan.id} legacy=${written.participantId ?? "null"}/${written.direction ?? "null"}`
    );

    await openGroup(page, groupId);
    ok("the settled row leaves the plan", !(await memberSettleBtn(page, "Karan", "Rohan").first().isVisible()));
    ok("the other member→member row is untouched", await memberSettleBtn(page, "Priya", "Rohan").first().isVisible());

    // ── Simplify OFF: the un-minimised obligations ──
    await page.getByRole("switch", { name: /Simplify/i }).first().dispatchEvent("click");
    await page.waitForTimeout(600);
    ok("Simplify OFF offers Settle on a member→member row too", await memberSettleBtn(page, "Priya", "Rohan").first().isVisible());
  } catch (e) {
    ok("script error", false, String(e).slice(0, 300));
  } finally {
    if (groupId) {
      await prisma.settlement.deleteMany({ where: { groupId } }).catch(() => {});
      await prisma.transaction.deleteMany({ where: { groupId } }).catch(() => {});
      await prisma.group.delete({ where: { id: groupId } }).catch(() => {});
    }
    await prisma.$disconnect();
    await browser.close();
  }
}

main().then(() => {
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
});
