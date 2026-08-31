// Offline-sync Phase 2 (spec §5, §12): category soft-heal. A category can be
// deleted out from under a still-queued offline intent (deleteCategory's
// in-use guard only counts already-synced transactions — an unsynced intent
// doesn't count). When the queue drains, the FK violation on categoryId
// should auto-heal to uncategorized (INVALID_REF_SOFT), not needs-attention.
// Combines Prisma (to delete the category out-of-band, mid-flight, the way a
// second device would) with Playwright (real browser outbox + drain).
// Run: npx tsx scripts/e2e-offline-p2-softheal.ts
import { chromium } from "playwright";
import { composerOf, saveComposer, setMerchant, topSheet, typeAmount } from "./e2e-composer.mjs";
import { prisma } from "../src/server/db";

const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

async function main() {
  const user = await prisma.user.findFirst({ where: { email: "arjun@ledgerly.app" } });
  if (!user) throw new Error("Demo user not found — run db:seed first");

  const category = await prisma.category.create({
    data: { userId: user.id, name: "P2SoftHealProbe", kind: "EXPENSE", icon: "🧪" },
  });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  try {
    await page.goto("http://localhost:3000/sign-in", { waitUntil: "load" });
    await page.fill('input[type="email"]', "arjun@ledgerly.app");
    await page.fill('input[type="password"]', "ledgerly-demo");
    await page.click('button[type="submit"]');
    await page.waitForURL("**/dashboard", { timeout: 15000 });
    // Exact: a loose match also resolves the mobile hero's "Total balance".
    await page.getByText(/^(TOTAL BALANCE|BALANCE · .+)$/).first().waitFor({ timeout: 20000 });

    await context.setOffline(true);
    // The composer: the category is a sheet of buttons rather than a <select>,
    // and the create confirms with its success wash rather than a toast.
    await page.click('button:has-text("＋ Add expense")');
    await typeAmount(page, "80");
    await setMerchant(page, "P2SoftHeal");
    await composerOf(page).getByRole("button", { name: /^Category:|Choose a category/ }).click();
    await page.waitForTimeout(600);
    await topSheet(page).getByRole("button", { name: /P2SoftHealProbe/ }).first().click();
    await page.waitForTimeout(400);
    await saveComposer(page);

    // still offline: the queued intent references `category`, which we now
    // delete server-side directly — simulating another device deleting it
    // before this device's queue ever gets a chance to sync
    await prisma.category.delete({ where: { id: category.id } });

    await context.setOffline(false);
    await page.waitForSelector("text=Waiting to sync", { state: "detached", timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);

    const tx = await prisma.transaction.findFirst({ where: { userId: user.id, merchant: "P2SoftHeal", deletedAt: null } });
    ok("the transaction synced despite its category being deleted mid-flight", !!tx);
    ok("it auto-healed to uncategorized rather than parking as needs-attention", tx?.categoryId === null);

    await page.goto("http://localhost:3000/transactions?p=all", { waitUntil: "load" });
    // Search is a collapsed <details> — opt-in, so open it before typing.
    {
      const field = page.locator('input[placeholder^="Search"]');
      if (!(await field.isVisible())) await page.locator("summary").filter({ hasText: "Search" }).first().click();
      await field.waitFor({ state: "visible", timeout: 15000 });
      await page.waitForTimeout(200);
      await field.fill("P2SoftHeal");
    }
    await page.waitForTimeout(600);
    const stillPending = (await page.evaluate(() => document.body.innerText)).includes("Needs your attention");
    ok("no needs-attention badge shown for the soft-healed item", !stillPending);

    if (tx) {
      await prisma.transaction.delete({ where: { id: tx.id } });
      await prisma.auditLog.deleteMany({ where: { userId: user.id, entityId: tx.id } });
      await prisma.intent.deleteMany({ where: { userId: user.id, entityId: tx.id } });
    }
  } finally {
    await browser.close();
  }
}

main()
  .catch((e) => {
    ok("script error", false, String(e).slice(0, 500));
  })
  .finally(async () => {
    await prisma.category.deleteMany({ where: { name: "P2SoftHealProbe" } }).catch(() => {});
    await prisma.$disconnect();
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  });
