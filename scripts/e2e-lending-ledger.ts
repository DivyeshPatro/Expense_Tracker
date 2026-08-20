// Lending → Contact → Transactions: the ledger itself.
//
// The row is a four-column ledger line — DATE & TIME | NOTES | YOU GAVE |
// YOU GOT — with the actions beside it and the funding source plus running
// balance on a supporting line. Three things about that can only be checked in
// a real browser, and all three have broken before:
//
//   • the two amount columns must stay separate, and an entry must appear in
//     exactly one of them (a combined "YOU GOT ₹5,000" block is what this
//     layout replaced)
//   • the row and the account link are two click targets that must not overlap
//     — when the link was nested inside the row's button, a tap dead-centre
//     navigated to /accounts instead of opening the transaction
//   • it has to hold together at 360px without horizontal scrolling
//
// Run: npx tsx scripts/e2e-lending-ledger.ts
import { randomUUID } from "node:crypto";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { prisma } from "../src/server/db";
import { istNoon } from "../src/lib/dates";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SHOT = path.join(process.cwd(), "e2e-output");
const S = randomUUID().slice(0, 6);
const results: { name: string; pass: boolean; note?: string }[] = [];
const ok = (name: string, pass: boolean, note?: string) => {
  results.push({ name, pass, note });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${note ? ` · ${note}` : ""}`);
};

async function signIn(page: Page) {
  await page.goto(`${BASE}/sign-in`, { waitUntil: "load" });
  await page.fill('input[type="email"]', "arjun@ledgerly.app");
  await page.fill('input[type="password"]', "ledgerly-demo");
  await page.waitForFunction(
    () => {
      const b = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
      return !!b && !b.disabled;
    },
    undefined,
    { timeout: 60000 }
  );
  await page.click('button[type="submit"]');
  for (let i = 0; i < 80 && !page.url().includes("/dashboard"); i++) await page.waitForTimeout(500);
  if (!page.url().includes("/dashboard")) throw new Error("sign-in failed");
}

/** The ledger renders in a modal sheet on a phone and an inline pane on
 *  desktop; the Transactions tab has to be opened either way. */
async function openLedger(page: Page, participantId: string) {
  await page.goto(`${BASE}/lending?contact=${participantId}`, { waitUntil: "load" });
  await page.getByRole("tab", { name: "transactions" }).first().waitFor({ state: "visible", timeout: 30000 });
  await page.getByRole("tab", { name: "transactions" }).first().click();
  await page.getByLabel("Search transactions").waitFor({ state: "visible", timeout: 15000 });
}

/** One transaction's card: the ledger line, the source line and the balance
 *  strip. The button is a direct child of the card, so the innermost div
 *  holding it IS the card. */
function row(page: Page, reason: string) {
  return page
    .locator("div")
    .filter({ has: page.getByRole("button", { name: new RegExp(`View details .*${reason}`) }) })
    .last();
}

async function main() {
  const user = await prisma.user.findFirstOrThrow({ where: { email: "arjun@ledgerly.app" } });
  const account = await prisma.account.findFirstOrThrow({ where: { userId: user.id, name: "HDFC Savings" } });
  const contactName = `ZLedger-${S}`;
  // Readable, note-shaped fixtures: this suite's screenshots are what the
  // Notes column looks like to a reviewer, and an id-shaped reason there
  // invites exactly the wrong conclusion about what the column renders.
  const GAVE_NOTE = `Bike repair ${S}`;
  const GOT_NOTE = `Part repayment ${S}`;
  const CARD_NOTE = `Settled by transfer ${S}`;
  const contact = await prisma.participant.create({ data: { ownerId: user.id, displayName: contactName } });

  // Three entries across two months: one account-funded, two cash, both
  // directions, so every column and the month grouping all have something to
  // show. Amounts are distinct so the amount sorts are unambiguous.
  const mk = (kind: "GAVE" | "GOT", amount: number, ymd: string, reason: string, accountId?: string) =>
    prisma.loanEntry.create({ data: { userId: user.id, participantId: contact.id, kind, amount, occurredAt: istNoon(ymd), reason, accountId } });
  await mk("GAVE", 2000000, "2026-04-23", GAVE_NOTE);
  await new Promise((r) => setTimeout(r, 20));
  await mk("GOT", 1000000, "2026-04-26", GOT_NOTE);
  await new Promise((r) => setTimeout(r, 20));
  await mk("GOT", 500000, "2026-08-20", CARD_NOTE, account.id);

  // A second contact for the geometry checks: five entries covering every
  // combination of note and funding source that could plausibly change a
  // card's height. Kept apart from the fixture above so measuring them cannot
  // disturb the running balances the other checks assert.
  const geomContact = await prisma.participant.create({ data: { ownerId: user.id, displayName: `ZGeom-${S}` } });
  const mkGeom = (kind: "GAVE" | "GOT", amount: number, ymd: string, reason: string | null, accountId?: string) =>
    prisma.loanEntry.create({ data: { userId: user.id, participantId: geomContact.id, kind, amount, occurredAt: istNoon(ymd), reason, accountId } });
  // Six times the Notes column's width at 360px, which is all case E needs to
  // prove: longer still would also widen the dashboard's own recent-entries
  // panel, an unrelated pre-existing issue in lending-workspace.tsx.
  const LONG_NOTE = `Far too long for this column ${S}`;
  await mkGeom("GAVE", 110000, "2026-02-01", `Dinner with the team ${S}`, account.id); // A: note + account
  await new Promise((r) => setTimeout(r, 20));
  await mkGeom("GOT", 120000, "2026-02-02", null, account.id); // B: no note + account
  await new Promise((r) => setTimeout(r, 20));
  await mkGeom("GAVE", 130000, "2026-02-03", `Petrol ${S}`); // C: note + cash
  await new Promise((r) => setTimeout(r, 20));
  await mkGeom("GOT", 140000, "2026-02-04", null); // D: no note + cash
  await new Promise((r) => setTimeout(r, 20));
  await mkGeom("GAVE", 150000, "2026-02-05", LONG_NOTE); // E: long note + cash

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  try {
    await signIn(page);
    await openLedger(page, contact.id);
    const body = await page.locator("body").innerText();

    // ══════════════ 1. Four columns, headed ══════════════
    for (const label of ["Date · added", "Notes", "You gave", "You got"]) {
      ok(`column header "${label}" is present`, new RegExp(label.replace(/[·]/g, "."), "i").test(body));
    }

    // ══════════════ 2. You Gave / You Got never share a cell ══════════════
    const gaveRowText = (await row(page, GAVE_NOTE).innerText()).replace(/\s+/g, " ");
    const gotRowText = (await row(page, GOT_NOTE).innerText()).replace(/\s+/g, " ");
    ok("a You Gave entry shows its amount and an em dash for You Got", gaveRowText.includes("₹20,000") && gaveRowText.includes("—"), gaveRowText.slice(0, 80));
    ok("a You Got entry shows its amount and an em dash for You Gave", gotRowText.includes("₹10,000") && gotRowText.includes("—"), gotRowText.slice(0, 80));
    ok("no row prints both amounts", !gaveRowText.includes("₹10,000") && !gotRowText.includes("₹20,000"));

    const colour = (reason: string) =>
      row(page, reason).evaluate((el) => {
        const cells = [...el.querySelectorAll("span")].filter((s) => /^(₹[\d,.]+|—)$/.test((s.textContent ?? "").trim()));
        return cells.map((s) => ({ text: (s.textContent ?? "").trim(), color: getComputedStyle(s).color }));
      });
    const gaveCells = await colour(GAVE_NOTE);
    const gotCells = await colour(GOT_NOTE);
    const amountCell = (cells: { text: string; color: string }[]) => cells.find((c) => c.text.startsWith("₹"));
    ok("You Gave is red", (amountCell(gaveCells)?.color ?? "").includes("rgb"), `${amountCell(gaveCells)?.text} ${amountCell(gaveCells)?.color}`);
    ok("You Got is green, and a different colour from You Gave", amountCell(gotCells)?.color !== amountCell(gaveCells)?.color, `gave ${amountCell(gaveCells)?.color} vs got ${amountCell(gotCells)?.color}`);
    ok("both columns exist on every row (amount + dash)", gaveCells.length === 2 && gotCells.length === 2, `${gaveCells.length} / ${gotCells.length} cells`);

    // ══════════════ 3. Date over recorded time ══════════════
    ok("the transaction date renders in full", body.includes("23 Apr 2026") && body.includes("20 Aug 2026"));
    ok("the recorded time renders beneath it", /\d{1,2}:\d{2} (AM|PM)/.test(gaveRowText), (gaveRowText.match(/\d{1,2}:\d{2} (AM|PM)/) ?? [""])[0]);

    // ══════════════ 4. Notes carry context, not the contact's name ══════════════
    ok("the note itself shows", gaveRowText.includes(GAVE_NOTE));
    // Where the money sat is metadata for one transaction, not something you
    // scan a list by, so the list omits it and the detail sheet carries it.
    const cardRowText = await row(page, CARD_NOTE).innerText();
    const cashRowText = await row(page, GAVE_NOTE).innerText();
    ok("an account-funded row does not name the account", !/via HDFC Savings|Untracked/.test(cardRowText), cardRowText.replace(/\s+/g, " ").slice(0, 70));
    ok("a cash row does not say 'Untracked / cash' either", !/Untracked/.test(cashRowText), cashRowText.replace(/\s+/g, " ").slice(0, 70));
    ok("no row in the list carries an account link", (await page.getByRole("link", { name: /funded from/ }).count()) === 0);
    const rowTexts = await Promise.all([GAVE_NOTE, GOT_NOTE, CARD_NOTE].map((r) => row(page, r).innerText()));
    const naming = rowTexts.filter((t) => t.includes(contactName)).length;
    ok("no transaction row repeats the contact's name", naming === 0, `${naming} of ${rowTexts.length} rows name the contact`);
    ok("no row says '<contact> owes you'", !new RegExp(`${contactName} owes you`).test(body));
    ok("the panel still names the contact once, at the top", body.includes(contactName));
    // The Notes column reads entry.reason / entry.notes and nothing else. This
    // is the guard that it stays that way: no cuid, no uuid, no bare 20+ char
    // identifier anywhere in a row, whatever the seed data happens to be.
    const idShaped = rowTexts.flatMap((t) => t.match(/c[a-z0-9]{20,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []);
    ok("no row exposes an internal id", idShaped.length === 0, idShaped.join(", ") || "none found");
    ok("no row exposes the participant id", !rowTexts.some((t) => t.includes(contact.id)));

    // ══════════════ 5. Running balance stays compact and correct ══════════════
    // chronological: gave 20,000 → 20,000 out; got 10,000 → 10,000; got 5,000 → 5,000
    ok("balance after the oldest entry", gaveRowText.includes("Balance: You'll get ₹20,000"), gaveRowText.slice(-40));
    ok("balance after the repayment", gotRowText.includes("Balance: You'll get ₹10,000"));
    ok("balance after the newest entry matches the contact's net", (await row(page, CARD_NOTE).innerText()).includes("Balance: You'll get ₹5,000"));

    // ══════════════ 6. Month grouping follows the sort ══════════════
    const months = () => page.getByText(/^(Apr|Aug) 2026$/i).count();
    ok("month headings show under a date sort", (await months()) === 2, `${await months()} headings`);
    const sort = page.getByLabel("Sort transactions");
    await sort.selectOption("highest");
    await page.waitForTimeout(600);
    ok("month headings hide under an amount sort", (await months()) === 0);
    await sort.selectOption("recent");
    await page.waitForTimeout(600);
    ok("month headings return", (await months()) === 2);

    // ══════════════ 7. Sorting still orders the list ══════════════
    const order = async () => {
      const t = await page.locator("body").innerText();
      return [GAVE_NOTE, GOT_NOTE, CARD_NOTE].map((r) => t.indexOf(r));
    };
    for (const [value, first] of [["recent", CARD_NOTE], ["oldest", GAVE_NOTE], ["highest", GAVE_NOTE], ["lowest", CARD_NOTE]] as const) {
      await sort.selectOption(value);
      await page.waitForTimeout(600);
      const t = await page.locator("body").innerText();
      const idx = [GAVE_NOTE, GOT_NOTE, CARD_NOTE].map((r) => t.indexOf(r));
      ok(`sort "${value}" leads with the expected entry`, t.indexOf(first) === Math.min(...idx), first);
    }
    await sort.selectOption("recent");
    await page.waitForTimeout(500);
    void (await order());

    // ══════════════ 8. Search still filters, alongside the sort ══════════════
    await page.getByLabel("Search transactions").fill(GOT_NOTE);
    await page.waitForTimeout(700);
    const searched = await page.locator("body").innerText();
    ok("search narrows the ledger", searched.includes(GOT_NOTE) && !searched.includes(GAVE_NOTE));
    await page.getByLabel("Search transactions").fill("");
    await page.waitForTimeout(600);

    // ══════════════ 9. Share and PDF survive the redesign ══════════════
    await page.getByRole("button", { name: "Share or export statement" }).click();
    await page.waitForTimeout(400);
    ok(
      "share menu still offers both",
      (await page.getByRole("menuitem", { name: "Share statement" }).count()) === 1 && (await page.getByRole("menuitem", { name: "Export as PDF" }).count()) === 1
    );
    await page.getByRole("menuitem", { name: "Share statement" }).click();
    await page.waitForTimeout(1000);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    ok("the shared statement still carries every entry and the totals", clip.includes("You Gave ₹20,000") && clip.includes("You Got ₹10,000") && clip.includes("Net: ₹5,000 owed to you"));
    ok("the shared statement leaks no ids", !clip.includes(contact.id));

    await page.goto(`${BASE}/lending/statement/${contact.id}`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    const statement = await page.locator("body").innerText();
    ok("the printable statement still lists every entry", [GAVE_NOTE, GOT_NOTE, CARD_NOTE].every((r) => statement.includes(r)));
    ok("the printable statement still offers print/PDF", (await page.getByRole("button", { name: /print|pdf/i }).count()) > 0);

    // ══════════════ 10. Hit targets, at every width ══════════════
    for (const w of [360, 390, 430, 1440]) {
      const p2 = await ctx.newPage();
      await p2.setViewportSize({ width: w, height: w >= 1440 ? 950 : 844 });
      await openLedger(p2, contact.id);

      const cardRow = row(p2, CARD_NOTE);
      const primary = cardRow.getByRole("button", { name: new RegExp(`View details .*${CARD_NOTE}`) });
      const pb = await primary.boundingBox();

      ok(`${w}px: the row is a single click target`, (await cardRow.getByRole("link").count()) === 0 && (await cardRow.getByRole("button").count()) === 1);
      ok(`${w}px: the row carries no per-row edit/delete controls`, (await p2.getByRole("button", { name: /^(Edit|Delete) .* entry of/ }).count()) === 0);
      ok(`${w}px: the row target is 44px+`, (pb?.height ?? 0) >= 44, `${Math.round(pb?.height ?? 0)}px`);

      // ── every card measures the same, whatever its content ────────────
      await openLedger(p2, geomContact.id);
      const geom = await p2.evaluate(`(() => {
        const cards = [...document.querySelectorAll("button")]
          .filter((b) => (b.getAttribute("aria-label") || "").startsWith("View details"))
          .map((b) => b.parentElement)
          .filter(Boolean);
        return cards.map((c) => {
          const r = c.getBoundingClientRect();
          const kids = [...c.children].map((k) => Math.round(k.getBoundingClientRect().height));
          const balance = [...c.children].find((k) => (k.textContent || "").startsWith("Balance:"));
          return {
            h: Math.round(r.height),
            slots: kids,
            balanceTop: balance ? Math.round(balance.getBoundingClientRect().top - r.top) : -1,
          };
        });
      })()`) as { h: number; slots: number[]; balanceTop: number }[];
      const heights = [...new Set(geom.map((g) => g.h))];
      ok(`${w}px: every card is the same height whatever its content`, heights.length === 1, `${geom.length} cards, heights ${heights.join("/")}`);
      const slotShapes = [...new Set(geom.map((g) => g.slots.join("/")))];
      ok(`${w}px: every card has the same slot structure`, slotShapes.length === 1, slotShapes.join(" vs "));
      const balanceTops = [...new Set(geom.map((g) => g.balanceTop))];
      ok(`${w}px: the balance strip starts at the same offset on every card`, balanceTops.length === 1 && balanceTops[0] > 0, `${balanceTops.join("/")}px from card top`);
      console.log(`    ${w}px card geometry — height ${heights[0]}px, slots ${geom[0].slots.join("/")}, balance at +${balanceTops[0]}px`);

      // The long note must stay inside its card. (The page-level check runs on
      // the main fixture below: the Lending dashboard's own "Recent entries"
      // panel renders reasons untruncated and widens behind the modal, which
      // predates this layout — HEAD overflows identically — and belongs to
      // lending-workspace.tsx rather than the card.)
      const cardOverflow = await p2.evaluate(`(() => {
        const cards = [...document.querySelectorAll("button")]
          .filter((b) => (b.getAttribute("aria-label") || "").startsWith("View details"))
          .map((b) => b.parentElement);
        return cards.some((c) => c && c.scrollWidth > c.clientWidth + 1);
      })()`);
      ok(`${w}px: a note too long for the column stays inside its card`, !cardOverflow);
      await openLedger(p2, contact.id);
      const overflow = await p2.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      ok(`${w}px: no horizontal overflow`, !overflow);
      const rowText = (await cardRow.innerText()).replace(/\s+/g, " ");
      ok(`${w}px: the amount stays visible`, rowText.includes("₹5,000"));
      ok(`${w}px: search, sort and share stay usable`,
        ((await p2.getByLabel("Search transactions").boundingBox())?.height ?? 0) >= 40 &&
          ((await p2.getByLabel("Sort transactions").boundingBox())?.height ?? 0) >= 40 &&
          ((await p2.getByRole("button", { name: "Share or export statement" }).boundingBox())?.height ?? 0) >= 40);

      // clicking the row opens the transaction; clicking the link opens /accounts
      await primary.click();
      await p2.waitForSelector("text=Funding Source", { timeout: 10000 });
      const opened = await p2.locator(".fixed.inset-0").first().innerText();
      ok(`${w}px: clicking the row opens that transaction`, opened.includes("₹5,000") && p2.url().includes("/lending"));
      // and the sheet is where editing and deleting live now
      ok(`${w}px: the transaction offers Edit and Delete`,
        (await p2.getByRole("button", { name: "Edit", exact: true }).count()) === 1 && (await p2.getByRole("button", { name: "Delete", exact: true }).count()) === 1);
      ok(`${w}px: the sheet names the funding account the list omits`, opened.includes("HDFC Savings"));
      // and a cash entry says so there too
      await openLedger(p2, contact.id);
      await row(p2, GAVE_NOTE).getByRole("button", { name: new RegExp(`View details .*${GAVE_NOTE}`) }).click();
      await p2.waitForSelector("text=Funding Source", { timeout: 10000 });
      ok(`${w}px: the sheet marks a cash entry Untracked / cash`, (await p2.locator(".fixed.inset-0").first().innerText()).includes("Untracked / cash"));

      if (w === 390 || w === 1440) {
        await openLedger(p2, contact.id);
        await p2.screenshot({ path: path.join(SHOT, `ledger-${w}.png`) });
      }
      await p2.close();
    }
  } catch (e) {
    ok("script error", false, String(e).slice(0, 400));
  } finally {
    await browser.close();
    await prisma.loanAllocation.deleteMany({
      where: { OR: [{ gaveEntry: { participantId: contact.id } }, { gotEntry: { participantId: contact.id } }] },
    });
    await prisma.loanEntry.deleteMany({ where: { participantId: contact.id } });
    await prisma.loanEntry.deleteMany({ where: { participantId: geomContact.id } });
    await prisma.participant.delete({ where: { id: geomContact.id } }).catch(() => {});
    await prisma.participant.delete({ where: { id: contact.id } }).catch(() => {});
    await prisma.$disconnect();
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    for (const f of failed) console.log(`  ✗ ${f.name}${f.note ? ` · ${f.note}` : ""}`);
    process.exit(failed.length ? 1 : 0);
  }
}

main();
