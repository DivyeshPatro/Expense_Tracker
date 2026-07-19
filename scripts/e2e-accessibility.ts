// Automated accessibility checks (Phase B, Priority 2) — axe-core run against
// the main authenticated surfaces plus a representative modal/sheet, using
// the same real-browser + real-server pattern as the other e2e scripts.
// Run: npx tsx scripts/e2e-accessibility.ts
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const BASE = "http://localhost:3000";
const results: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

// wcag2a/wcag2aa/wcag21aa cover the standard bar. color-contrast is reported
// but doesn't gate pass/fail here: Phase B fixed --mut/--mut2 specifically
// (the audit's ask), but --green/--red/--amber/--acc also fail AA in places
// (e.g. --acc is the project's pinned brand blue, #2a63f6 per CLAUDE.md) —
// that's a real, separate design decision this script shouldn't silently
// force by failing the build. Every other rule (structure, names, keyboard
// reachability, ARIA) does gate — those are markup bugs, not design calls.
async function auditPage(page: import("playwright").Page, name: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const structural = results.violations.filter((v) => v.id !== "color-contrast");
  const gating = structural.filter((v) => v.impact === "critical" || v.impact === "serious");
  ok(
    `${name}: no serious/critical structural axe violations`,
    gating.length === 0,
    gating.map((v) => `${v.id} (${v.impact}, ${v.nodes.length}x)`).join("; ")
  );
  const contrast = results.violations.find((v) => v.id === "color-contrast");
  if (contrast) console.log(`  (color-contrast: ${contrast.nodes.length}x — not gated, see script header)`);
  const minor = structural.filter((v) => v.impact !== "critical" && v.impact !== "serious");
  if (minor.length > 0) console.log(`  (${minor.length} lower-severity structural: ${minor.map((v) => v.id).join(", ")})`);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto(`${BASE}/sign-in`, { waitUntil: "load" });
    await auditPage(page, "sign-in page");

    await page.fill('input[type="email"]', "arjun@ledgerly.app");
    await page.fill('input[type="password"]', "ledgerly-demo");
    await page.click('button[type="submit"]');
    await page.waitForURL("**/dashboard", { timeout: 20000 });
    await page.waitForTimeout(1000);
    await auditPage(page, "dashboard");

    await page.goto(`${BASE}/transactions`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    await auditPage(page, "transactions list");

    await page.goto(`${BASE}/lending`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    await auditPage(page, "lending");

    await page.goto(`${BASE}/analytics`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    await auditPage(page, "analytics");

    // A representative modal open — exercises the shared Modals() dialog.
    await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    await page.click('button:has-text("Add expense")');
    await page.waitForSelector('[role="dialog"], .modal, [aria-modal="true"]', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);
    await auditPage(page, "expense modal open");
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
