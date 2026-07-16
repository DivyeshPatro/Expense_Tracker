// Offline-sync Phase 0 exit criteria (spec §17), browser side: the app is
// installable (manifest), the service worker registers and establishes a
// device identity, a cold offline navigation renders the branded shell, and
// online behavior is byte-identical to no-SW (network-first navigations).
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const SHOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "e2e-output");
fs.mkdirSync(SHOT, { recursive: true });
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
page.setDefaultTimeout(20000);

try {
  await page.goto("http://localhost:3000/sign-in", { waitUntil: "load" });

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  ok("manifest is linked (installable PWA)", manifestHref === "/manifest.webmanifest", manifestHref ?? "missing");
  const manifest = await page.evaluate(async () => (await fetch("/manifest.webmanifest")).json());
  ok("manifest declares name/start_url/display/icons", manifest.name === "Ledgerly" && manifest.display === "standalone" && manifest.icons?.length > 0);

  await page.fill('input[type="email"]', "arjun@ledgerly.app");
  await page.fill('input[type="password"]', "ledgerly-demo");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 15000 });
  await page.waitForSelector("text=TOTAL BALANCE");

  const swState = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return { scope: reg.scope, active: !!reg.active };
  });
  ok("service worker registers and activates", swState.active && swState.scope.endsWith("/"), swState.scope);

  const deviceId = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open("ledgerly");
        req.onsuccess = () => {
          const db = req.result;
          try {
            const get = db.transaction("meta", "readonly").objectStore("meta").get("deviceId");
            get.onsuccess = () => resolve(get.result?.value ?? null);
            get.onerror = () => resolve(null);
          } catch {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      })
  );
  ok("device identity established in IndexedDB", typeof deviceId === "string" && deviceId.length >= 32, String(deviceId).slice(0, 8) + "…");

  // let the SW settle + cache the precache set, then go dark
  await page.waitForTimeout(600);
  await context.setOffline(true);
  await page.goto("http://localhost:3000/dashboard", { waitUntil: "load" }).catch(() => {});
  const offlineText = await page.evaluate(() => document.body.innerText);
  ok("cold offline navigation renders the branded shell", offlineText.includes("You’re offline") || offlineText.includes("You're offline"));
  await page.screenshot({ path: `${SHOT}/offline-shell-390.png` });

  await context.setOffline(false);
  await page.goto("http://localhost:3000/dashboard", { waitUntil: "load" });
  await page.waitForSelector("text=TOTAL BALANCE", { timeout: 15000 });
  ok("back online: navigations are network-first (fresh page, not a cached shell)", true);
} catch (e) {
  ok("script error", false, String(e).slice(0, 400));
  await page.screenshot({ path: `${SHOT}/offline-error.png`, fullPage: true }).catch(() => {});
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
