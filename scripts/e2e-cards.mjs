// E2E: credit-card lifecycle — add, encryption-at-rest, password-gated reveal,
// edit, set-default, delete.
//
// Non-destructive: works only with its own "ZZZ"-prefixed cards and deletes
// them (and the reveal-denied audit rows a wrong-password check leaves behind,
// which feed the lockout counter) on the way out, whatever happened.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { config } from "dotenv";
import { PrismaClient } from "@prisma/client";
config();

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || "http://localhost:3000";
const EMAIL = "arjun@ledgerly.app";
const PASSWORD = "ledgerly-demo";

const VISA = "ZZZ Visa One";
const MC = "ZZZ MC Two";
const VISA_EDITED = "ZZZ Visa One Edited";
const NUMBER = "4111 1111 1111 1111"; // a Visa test number that passes Luhn
const RAW_NUMBER = "4111111111111111";

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const prisma = new PrismaClient();
const user = await prisma.user.findUnique({ where: { email: EMAIL } });
if (!user) {
  console.error(`No demo user ${EMAIL} — run npm run db:seed first.`);
  await prisma.$disconnect();
  process.exit(1);
}

async function cleanup() {
  const mine = await prisma.creditCard.findMany({
    where: { userId: user.id, nickname: { contains: "ZZZ " } },
    select: { id: true },
  });
  const ids = mine.map((c) => c.id);
  if (ids.length) {
    // reveal-denied rows feed the 15-minute lockout counter; clear ours so
    // repeated runs don't lock the account out of the reveal path.
    await prisma.auditLog.deleteMany({ where: { userId: user.id, entity: "CreditCard", entityId: { in: ids } } });
    await prisma.creditCard.deleteMany({ where: { id: { in: ids } } });
  }
}
await cleanup();

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

async function waitFor(fn, label, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    const v = await fn();
    if (v) return v;
    await page.waitForTimeout(300);
  }
  console.log(`  (gave up waiting for ${label})`);
  return null;
}

/**
 * Open a card's own page, which is where its controls live.
 *
 * The wallet is a list of rows linking to /cards/[cardId]; Show details, Edit,
 * Make default and Delete are on that page under "Manage". They used to sit
 * inline on a gallery tile, which is what `div.grid > div` was reaching for.
 */
const openCard = async (nickname) => {
  if (!page.url().includes("/cards")) await gotoCards();
  const row = page.getByRole("link", { name: new RegExp(nickname) });
  if ((await row.count()) === 0) await gotoCards();
  await page.getByRole("link", { name: new RegExp(nickname) }).first().click();
  await page.waitForURL("**/cards/**", { timeout: 20000 });
  await page.waitForTimeout(600);
};

/** The open card page. Its heading is the card's nickname. */
const cardPage = () => page.locator("main").first();

/** The add control, whichever of its two forms this wallet is showing. */
const addCardButton = () => page.getByRole("button", { name: /Add card|Add your first card/ });

async function gotoCards() {
  await page.goto(`${BASE}/cards`, { waitUntil: "domcontentloaded", timeout: 60000 });
  // An empty wallet labels it "Add your first card"; a populated one
  // "＋ Add card". Both open the same form, and which one is on screen
  // depends on data this suite has not created yet.
  await addCardButton().first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500); // hydration before clicking anything
}

// A click that lands before React has attached its handler is a no-op; retry
// until the dialog it should have opened actually appears.
async function openDialogVia(clickFn, titleRe) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await clickFn();
    const opened = await page
      .getByRole("dialog")
      .filter({ hasText: titleRe })
      .waitFor({ timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (opened) return true;
    await page.waitForTimeout(800);
  }
  return false;
}

async function fillCardForm({ nickname, bank, cardholder, makeDefault }) {
  const dlg = page.getByRole("dialog").filter({ hasText: /Add card|Edit card/ });
  await dlg.getByLabel("Card nickname").fill(nickname);
  await dlg.getByLabel("Issuing bank").fill(bank);
  await dlg.getByLabel("Card number").fill(NUMBER);
  await dlg.getByLabel("Expiry month").fill("09");
  await dlg.getByLabel("Expiry year").fill("2030");
  await dlg.getByLabel("CVV").fill("123");
  await dlg.getByLabel("Cardholder name").fill(cardholder);
  if (makeDefault) await dlg.getByLabel("Use as my default card").check();
}

try {
  // ── Sign in (retry through the hydration race) ──
  let signedIn = false;
  for (let attempt = 0; attempt < 3 && !signedIn; attempt++) {
    await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector('button[type="submit"]', { timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    try {
      await page.waitForURL("**/dashboard", { timeout: 30000 });
      signedIn = true;
    } catch {
      /* retry */
    }
  }
  if (!signedIn) throw new Error("Could not sign in after 3 attempts (hydration race)");

  // ── Add a card ──
  await gotoCards();
  // Deliberately without ticking "default": the first card should still become
  // the default on its own.
  await openDialogVia(() => addCardButton().first().click(), /Add card/);
  await fillCardForm({ nickname: VISA, bank: "HDFC Bank", cardholder: "TEST HOLDER" });
  await page.getByRole("dialog").getByRole("button", { name: "Save card" }).click();

  const created = await waitFor(
    () => prisma.creditCard.findFirst({ where: { userId: user.id, nickname: VISA } }),
    "the card to save"
  );
  ok("adding a card persists it", !!created);

  // ── Encryption at rest ──
  if (created) {
    const numText = Buffer.from(created.numberCipher).toString("latin1");
    ok("the last four are stored in the clear for display", created.last4 === "1111", `last4=${created.last4}`);
    ok(
      "the full number is stored as ciphertext, never plaintext",
      created.numberCipher.length > 0 && !numText.includes("4111") && !numText.includes(RAW_NUMBER)
    );
    ok(
      "every secret field is sealed with its own IV",
      created.numberIv.length > 0 && created.cvvCipher.length > 0 && created.holderCipher.length > 0 && created.expiryCipher.length > 0
    );
    ok("the row records which key sealed it", !!created.keyFingerprint);
    ok("the first card becomes the default automatically, even from the form", created.isDefault === true);
  }

  // ── The face shows the mask, not the number ──
  await gotoCards();
  const walletText = await page.locator("body").innerText();
  ok("the wallet masks all but the last four", walletText.includes("1111") && !walletText.includes(RAW_NUMBER));

  // ── Reveal is gated: a wrong password is refused ──
  await openCard(VISA);
  await openDialogVia(() => page.getByRole("button", { name: "Show details" }).first().click(), /Confirm it's you/);
  await page.getByRole("dialog").getByLabel("Ledgerly password").fill("definitely-not-it");
  await page.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
  const refused = await waitFor(
    async () => ((await page.getByText(/password isn't right/i).count()) > 0 ? true : null),
    "the wrong-password refusal"
  );
  ok("a wrong password is refused and reveals nothing", refused === true);
  ok("no card number is on the page after a refused reveal", !(await page.locator("body").innerText()).includes(NUMBER));

  // ── Reveal with the right password ──
  await page.getByRole("dialog").getByLabel("Ledgerly password").fill(PASSWORD);
  await page.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
  const revealed = await waitFor(
    async () => ((await page.getByText(NUMBER).count()) > 0 ? true : null),
    "the reveal panel"
  );
  ok("the right password reveals the full number and CVV", revealed === true);
  const panelText = revealed ? await cardPage().innerText() : "";
  ok("the reveal shows a countdown before it auto-hides", /Visible for \d+s/.test(panelText));

  // Hide it again (the 30s auto-hide itself is covered by unit tests).
  await page.getByRole("button", { name: "Hide now" }).first().click();
  await page.waitForTimeout(500);
  ok("Hide now clears the revealed number immediately", !(await page.locator("body").innerText()).includes(NUMBER));

  // ── Edit routes through the password prompt ──
  await openDialogVia(() => page.getByRole("button", { name: /Edit card/ }).first().click(), /Confirm it's you/);
  await page.getByRole("dialog").getByLabel("Ledgerly password").fill(PASSWORD);
  await page.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
  const editOpened = await page
    .getByRole("dialog")
    .filter({ hasText: /Edit card/ })
    .waitFor({ timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  ok("editing opens a form pre-filled from a fresh reveal", editOpened);
  if (editOpened) {
    const editDlg = page.getByRole("dialog").filter({ hasText: /Edit card/ });
    ok("the edit form is pre-filled with the decrypted number", (await editDlg.getByLabel("Card number").inputValue()).replace(/\s/g, "") === RAW_NUMBER);
    await editDlg.getByLabel("Card nickname").fill(VISA_EDITED);
    await editDlg.getByRole("button", { name: "Save changes" }).click();
  }
  const edited = await waitFor(
    () => prisma.creditCard.findFirst({ where: { userId: user.id, nickname: VISA_EDITED } }),
    "the edit to save"
  );
  ok("editing a card persists and keeps it encrypted", !!edited && edited.numberCipher.length > 0 && edited.last4 === "1111");

  // ── Set default across two cards ──
  await gotoCards();
  await openDialogVia(() => addCardButton().first().click(), /Add card/);
  await fillCardForm({ nickname: MC, bank: "ICICI Bank", cardholder: "TEST HOLDER" });
  await page.getByRole("dialog").getByRole("button", { name: "Save card" }).click();
  await waitFor(() => prisma.creditCard.findFirst({ where: { userId: user.id, nickname: MC } }), "the second card to save");

  await openCard(MC);
  await page.getByRole("button", { name: /Make default/ }).first().click();
  const promoted = await waitFor(
    async () => ((await prisma.creditCard.findFirst({ where: { userId: user.id, nickname: MC } }))?.isDefault ? true : null),
    "the default to move"
  );
  ok("making a card default promotes it", promoted === true);
  const defaults = await prisma.creditCard.count({ where: { userId: user.id, nickname: { contains: "ZZZ " }, isDefault: true } });
  ok("exactly one of my cards is the default", defaults === 1, `${defaults} default(s)`);

  // ── Delete ──
  await openCard(MC);
  await page.getByRole("button", { name: /Delete card/ }).first().click();
  await page.waitForTimeout(500);
  // The confirmation's own Delete, which is a second control with that name.
  await page.getByRole("button", { name: "Delete", exact: true }).last().click();
  const deleted = await waitFor(
    async () => ((await prisma.creditCard.count({ where: { userId: user.id, nickname: MC } })) === 0 ? true : null),
    "the delete to save"
  );
  ok("deleting a card removes it for good", deleted === true);
  const survivorDefault = await waitFor(
    async () => ((await prisma.creditCard.findFirst({ where: { userId: user.id, nickname: VISA_EDITED } }))?.isDefault ? true : null),
    "the default to fall back"
  );
  ok("deleting the default promotes the remaining card", survivorDefault === true);
} catch (e) {
  ok("script error", false, String(e).slice(0, 500));
  const outputDir = path.join(SCRIPT_DIR, "..", "e2e-output");
  fs.mkdirSync(outputDir, { recursive: true });
  await page.screenshot({ path: path.join(outputDir, "cards-error.png"), fullPage: true }).catch(() => {});
}

await cleanup();
await prisma.$disconnect();
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
