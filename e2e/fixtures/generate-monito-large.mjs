// Generates monito-large.csv: a large (~1500 row), multi-year, Monito-export-shaped
// synthetic fixture used by e2e-large-import.mjs, e2e-perf.mjs and repro-balance-bug.mjs
// to stress-test the import pipeline (transaction timeout, pagination) and reproduce
// the "no per-row account" balance bug. Deterministic (seeded RNG) so re-runs are stable.
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260713);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];

const EXPENSE_CATS = ["Food", "Groceries", "Rent", "Travel", "Shopping", "Entertainment", "Clothing", "Home", "Others", "Credit card Bill payment"];
const INCOME_CATS = ["Salary", "Refund"];
const NOTES = ["Swiggy", "Zomato", "BigBasket", "Uber", "Ola", "Amazon", "Flipkart", "Movie tickets", "", "", "Electricity board", "Local vendor"];

const rows = [];
let d = new Date("2021-01-01T00:00:00Z");
const end = new Date("2026-06-30T00:00:00Z");
const totalDays = Math.round((end - d) / 86400000);

for (let i = 0; i < 1500; i++) {
  const dayOffset = Math.floor((i / 1500) * totalDays) + Math.floor(rng() * 3);
  const cur = new Date(d.getTime() + dayOffset * 86400000);
  const dd = String(cur.getUTCDate()).padStart(2, "0");
  const mm = String(cur.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = cur.getUTCFullYear();
  const isIncome = rng() < 0.06;
  const type = isIncome ? "Income" : "Expense";
  const cat = isIncome ? pick(INCOME_CATS) : pick(EXPENSE_CATS);
  const note = isIncome ? "" : pick(NOTES);
  const amount = isIncome ? Math.round(30000 + rng() * 40000) : Math.round(50 + rng() * 3000);
  rows.push(`${dd}/${mm}/${yyyy},${type},${cat},${note},${amount}`);
}

const out = [
  "Monito Expense Manager,,,,",
  "Version 8.3,,,,",
  "Created on 13/07/2026,,,,",
  ",,,,",
  "Date,Category type,Category name,Note,Amount",
  ...rows,
].join("\n") + "\n";

const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "monito-large.csv");
fs.writeFileSync(outPath, out);
console.log(`Wrote ${rows.length} rows to ${outPath}`);
