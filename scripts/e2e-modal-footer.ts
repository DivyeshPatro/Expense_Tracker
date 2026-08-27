// The sticky submit footer must not paint over the last field.
//
// SubmitButton pins itself to the bottom of the modal's scroll body so a long
// form scrolls under it. It cancels the body's 22px bottom padding with a
// negative margin to sit flush at the panel edge — and sticky resolves `bottom`
// against the MARGIN box, so `bottom: 0` pinned it 22px ABOVE its own place in
// the flow, across the last control. Short forms had nothing to scroll, so
// there was no way out from under it: the Add friend modal shipped with the
// name input's bottom border and focus ring covered.
//
// A bounding-box overlap check does NOT catch this — border boxes exclude the
// focus ring, and the two boxes never intersected. What matters is the gap
// between the footer's top edge and the last control's bottom edge, which must
// leave room for a ring. That is what this measures, on a form that fits and a
// form that scrolls, at the sizes where it was reported.

import { chromium, type Browser, type Page } from "playwright";
import { auth } from "../src/server/auth";
import { prisma } from "../src/server/db";

const BASE = "http://localhost:3000";
const PASSWORD = "ledgerly-demo";
/** Clearance a focus ring needs below a control's border box. */
const RING = 4;

const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? ` · ${detail}` : ""}`);
};

async function session(browser: Browser, email: string, w: number, h: number) {
  const r = (await auth.api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true })) as { headers: Headers };
  const cookies = (r.headers.getSetCookie?.() ?? []).map((sc) => {
    const p = sc.split(";")[0];
    const i = p.indexOf("=");
    return { name: p.slice(0, i), value: p.slice(i + 1), domain: "localhost", path: "/" };
  });
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  return { ctx, page };
}

/** Footer geometry relative to the last control, and whether it still pins. */
async function measure(page: Page) {
  return page.getByRole("dialog").evaluate((root) => {
    const footer = root.querySelector("div.sticky") as HTMLElement | null;
    const body = root.querySelector("div.overflow-auto") as HTMLElement | null;
    const controls = Array.from(root.querySelectorAll("input, select, textarea")) as HTMLElement[];
    const last = controls[controls.length - 1];
    if (!footer || !body || !last) return null;
    const scrolls = body.scrollHeight > body.clientHeight;
    // Measure the gap with the form scrolled all the way down, which is where
    // the last control and the footer actually meet. Anywhere above that, a
    // long form is SUPPOSED to run under the footer.
    body.scrollTop = body.scrollHeight;
    const gap = Math.round(footer.getBoundingClientRect().top - last.getBoundingClientRect().bottom);
    body.scrollTop = 0;
    const b = body.getBoundingClientRect();
    const f = footer.getBoundingClientRect();
    return { gap, scrolls, pinnedAtTop: f.bottom <= b.bottom + 2 && f.top < b.bottom };
  });
}

async function openQuickAdd(page: Page, action: RegExp) {
  await page.getByRole("button", { name: /quick add/i }).filter({ visible: true }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: action }).first().click();
  await page.waitForTimeout(900);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const email = `modal-footer-${Date.now()}@test.local`;
  await auth.api.signUpEmail({ body: { name: "Footer", email, password: PASSWORD } });

  try {
    // The reported size, plus an ordinary phone.
    for (const [w, h] of [[583, 337], [390, 844]] as const) {
      const { ctx, page } = await session(browser, email, w, h);

      // ── A form with ONE field: nothing to scroll, so the footer's position
      //    is the only thing keeping the control visible.
      await page.goto(`${BASE}/people`, { waitUntil: "load" });
      await page.waitForTimeout(1200);
      const cta = page.getByRole("button", { name: /Add a friend/ }).first();
      if (await cta.count()) await cta.click();
      else await openQuickAdd(page, /Add (a )?friend|Add contact/);
      await page.waitForTimeout(700);
      await page.getByRole("dialog").locator("input.field").first().focus();
      await page.waitForTimeout(250);

      const short = await measure(page);
      ok(`${w}x${h} short form: the footer clears the last field`, short !== null && short.gap >= RING, short ? `gap=${short.gap}px` : "not measured");
      ok(`${w}x${h} short form: it is the no-scroll case, so position is all there is`, short?.scrolls === false);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);

      // ── A form with many fields, which must still scroll under a pinned footer.
      await page.goto(`${BASE}/lending`, { waitUntil: "load" });
      await page.waitForTimeout(1200);
      await openQuickAdd(page, /You gave money/);
      const long = await measure(page);
      ok(`${w}x${h} long form: the footer clears the last field too`, long !== null && long.gap >= RING, long ? `gap=${long.gap}px` : "not measured");
      if (long?.scrolls) {
        ok(`${w}x${h} long form: the footer still pins while the body scrolls under it`, long.pinnedAtTop === true);
      } else {
        ok(`${w}x${h} long form: fits without scrolling at this height`, true, "sticky case covered at the smaller height");
      }

      await ctx.close();
    }
  } catch (e) {
    ok("script error", false, String(e).slice(0, 300));
  } finally {
    await prisma.user.deleteMany({ where: { email } }).catch(() => {});
    await prisma.$disconnect();
    await browser.close();
  }
}

main().then(() => {
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
});
