// Demo seed — recreates the prototype's realistic Indian dataset relative to
// today (IST): 5 accounts, 6 months of history, shared splits with flatmates,
// budgets, bills, one settlement. Run: npm run db:seed
// Demo login: arjun@ledgerly.app / ledgerly-demo

import { PrismaClient } from "@prisma/client";
import { auth } from "../src/server/auth";
import { GROUP_DEFAULT_CATEGORIES } from "../src/lib/categories";
import { splitEqual } from "../src/lib/money";
import { addDaysYMD, currentMonthKey, istNoon, shiftMonthKey, todayYMD } from "../src/lib/dates";

const prisma = new PrismaClient();

const EMAIL = "arjun@ledgerly.app";
const PASSWORD = "ledgerly-demo";

// target closing balances in paise (match the prototype)
const ACCOUNTS = [
  { key: "hdfc", name: "HDFC Savings", type: "BANK", icon: "🏦", color: "#2a63f6", target: 52_340_00 },
  { key: "icici", name: "ICICI Salary", type: "BANK", icon: "🏦", color: "#6d5ae6", target: 184_210_00 },
  { key: "cash", name: "Cash Wallet", type: "CASH", icon: "💵", color: "#149356", target: 2_450_00 },
  { key: "phonepe", name: "PhonePe", type: "WALLET", icon: "📱", color: "#7c3aed", target: 4_320_00 },
  { key: "axis", name: "Axis Credit Card", type: "CREDIT_CARD", icon: "💳", color: "#d13f45", target: -12_450_00 },
] as const;

type AccKey = (typeof ACCOUNTS)[number]["key"];

interface SeedTx {
  type: "EXPENSE" | "INCOME" | "TRANSFER";
  rupees: number;
  acc?: AccKey;
  to?: AccKey;
  cat?: string;
  merchant: string;
  ymd: string;
  notes?: string;
  recurring?: boolean;
  receipt?: boolean;
  split?: { payer: "me" | string; friends: string[] }; // friend keys: rohan/karan/priya
}

async function main() {
  console.log("Seeding Ledgerly demo data…");

  const existing = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (existing) {
    console.log("Demo user exists — wiping and recreating.");
    await prisma.group.deleteMany({ where: { createdById: existing.id } });
    await prisma.auditLog.deleteMany({ where: { userId: existing.id } });
    await prisma.user.delete({ where: { id: existing.id } });
  }

  // Sign up through Better Auth so the password hash + onboarding hook are real.
  await auth.api.signUpEmail({ body: { name: "Arjun", email: EMAIL, password: PASSWORD } });
  const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
  await prisma.account.deleteMany({ where: { userId: user.id } }); // replace onboarding starter account

  const categories = await prisma.category.findMany({ where: { userId: user.id } });
  const cat = (name: string) => categories.find((c) => c.name === name)?.id ?? null;

  // friends + group
  const friendDefs = [
    { key: "rohan", name: "Rohan", color: "#6d5ae6" },
    { key: "karan", name: "Karan", color: "#0f766e" },
    { key: "priya", name: "Priya", color: "#d1497e" },
  ];
  const friends = new Map<string, string>();
  for (const f of friendDefs) {
    const p = await prisma.participant.create({ data: { ownerId: user.id, displayName: f.name, color: f.color } });
    friends.set(f.key, p.id);
  }
  const flat402 = await prisma.group.create({
    data: {
      name: "Flat 402",
      createdById: user.id,
      members: {
        create: friendDefs.map((f, i) => ({ participantId: friends.get(f.key)!, role: i === 0 ? "ADMIN" : "MEMBER" })),
      },
    },
  });
  // group-expenses-sprint: the service-layer createGroup() seeds these
  // transactionally for a real user; this script creates the demo group
  // directly (bypassing the service, like the rest of this file's bulk
  // inserts), so it needs the same seeding done explicitly here.
  await prisma.category.createMany({
    data: GROUP_DEFAULT_CATEGORIES.map((c) => ({ groupId: flat402.id, name: c.name, kind: c.kind, icon: c.icon, color: c.color })),
  });

  // ── build 6 months of history relative to today (IST) ──
  const today = todayYMD();
  const day = Number(today.slice(8));
  const thisKey = currentMonthKey();
  const txs: SeedTx[] = [];
  const d = (key: string, dd: number) => `${key}-${String(dd).padStart(2, "0")}`;

  const spend: [string, string, number, AccKey][] = [
    ["Groceries", "BigBasket", 7400, "hdfc"],
    ["Food", "Swiggy", 8600, "phonepe"],
    ["Shopping", "Amazon", 5200, "axis"],
    ["Travel", "Uber", 3600, "phonepe"],
    ["Entertainment", "BookMyShow", 1400, "axis"],
    ["Misc", "Local store", 3100, "cash"],
  ];
  for (let back = 5; back >= 1; back--) {
    const key = shiftMonthKey(thisKey, -back);
    const k = 5 - back;
    txs.push({ type: "INCOME", rupees: 120000, acc: "icici", cat: "Salary", merchant: "Salary · Acme Corp", ymd: d(key, 1) });
    txs.push({ type: "EXPENSE", rupees: 12000, acc: "hdfc", cat: "Rent", merchant: "Rent (your share)", ymd: d(key, 2), recurring: true });
    txs.push({ type: "EXPENSE", rupees: 18500, acc: "icici", cat: "EMI", merchant: "Bike EMI · HDFC", ymd: d(key, 5), recurring: true });
    spend.forEach(([c, merchant, base, acc], j) => {
      txs.push({ type: "EXPENSE", rupees: Math.round(base * (0.82 + ((k * 7 + j * 3) % 10) / 28)), acc, cat: c, merchant, ymd: d(key, 8 + j * 3) });
    });
    txs.push({ type: "EXPENSE", rupees: 948, acc: "axis", cat: "Subscription", merchant: "Netflix + Spotify", ymd: d(key, 8), recurring: true });
  }

  // current month (clamped to today so re-seeding any day stays sensible)
  const cur: SeedTx[] = [
    { type: "INCOME", rupees: 120000, acc: "icici", cat: "Salary", merchant: "Salary · Acme Corp", ymd: d(thisKey, 1) },
    { type: "EXPENSE", rupees: 18500, acc: "icici", cat: "EMI", merchant: "Bike EMI · HDFC", ymd: d(thisKey, 1), recurring: true },
    { type: "EXPENSE", rupees: 1840, acc: "hdfc", cat: "Electricity", merchant: "BESCOM · " + today.slice(0, 4), ymd: d(thisKey, 2), split: { payer: "me", friends: ["rohan", "karan"] } },
    { type: "TRANSFER", rupees: 3000, acc: "hdfc", to: "cash", merchant: "ATM withdrawal", ymd: d(thisKey, 3) },
    { type: "EXPENSE", rupees: 1200, cat: "Travel", merchant: "Airport cab", ymd: d(thisKey, 3), split: { payer: "karan", friends: ["karan"] } },
    { type: "EXPENSE", rupees: 299, acc: "phonepe", cat: "Subscription", merchant: "Jio Recharge", ymd: d(thisKey, 4), recurring: true },
    { type: "EXPENSE", rupees: 3150, acc: "axis", cat: "Shopping", merchant: "Amazon", ymd: d(thisKey, 5), notes: "Desk lamp + cables" },
    { type: "EXPENSE", rupees: 2500, acc: "axis", cat: "Food", merchant: "Barbeque Nation", ymd: d(thisKey, 6), receipt: true, split: { payer: "me", friends: ["rohan", "karan", "priya"] } },
    { type: "EXPENSE", rupees: 36000, acc: "hdfc", cat: "Rent", merchant: "Rent · Flat 402", ymd: d(thisKey, 7), recurring: true, split: { payer: "me", friends: ["rohan", "karan"] } },
    { type: "EXPENSE", rupees: 649, acc: "axis", cat: "Subscription", merchant: "Netflix", ymd: d(thisKey, 8), recurring: true },
    { type: "EXPENSE", rupees: 840, cat: "Food", merchant: "Zomato · dinner", ymd: d(thisKey, 8), split: { payer: "rohan", friends: ["rohan"] } },
    { type: "EXPENSE", rupees: 1240, acc: "phonepe", cat: "Groceries", merchant: "Blinkit", ymd: d(thisKey, 9) },
    { type: "EXPENSE", rupees: 1700, cat: "Entertainment", merchant: "PVR · movie night", ymd: d(thisKey, 9), split: { payer: "priya", friends: ["priya"] } },
    { type: "EXPENSE", rupees: 240, acc: "phonepe", cat: "Travel", merchant: "Uber", ymd: d(thisKey, 10) },
    { type: "EXPENSE", rupees: 420, acc: "phonepe", cat: "Food", merchant: "Swiggy", ymd: d(thisKey, 10) },
  ];
  txs.push(...cur.filter((t) => Number(t.ymd.slice(8)) <= day));

  // accounts (balances fixed up after inserts so opening + Σ ledger = target)
  const accountIds = new Map<AccKey, string>();
  for (const a of ACCOUNTS) {
    const acc = await prisma.account.create({
      data: { userId: user.id, name: a.name, type: a.type, icon: a.icon, color: a.color },
    });
    accountIds.set(a.key, acc.id);
  }

  const deltas = new Map<AccKey, number>(ACCOUNTS.map((a) => [a.key, 0]));
  for (const t of txs) {
    const paise = t.rupees * 100;
    const payerIsMe = !t.split || t.split.payer === "me";
    const splitCreate = t.split
      ? splitEqual(paise, [null, ...t.split.friends.map((f) => friends.get(f)!)], t.split.payer === "me" ? null : friends.get(t.split.payer)!).map(
          (s) => ({ participantId: s.participantId, owedAmount: s.owedAmount, method: "EQUAL" as const })
        )
      : undefined;

    const created = await prisma.transaction.create({
      data: {
        userId: user.id,
        type: t.type,
        amount: paise,
        accountId: payerIsMe && t.acc ? accountIds.get(t.acc)! : null,
        toAccountId: t.to ? accountIds.get(t.to)! : null,
        categoryId: t.cat ? cat(t.cat) : null,
        merchant: t.merchant,
        occurredAt: istNoon(t.ymd),
        notes: t.notes ?? null,
        isRecurring: t.recurring ?? false,
        paidByParticipantId: payerIsMe ? null : friends.get(t.split!.payer)!,
        splits: splitCreate ? { create: splitCreate } : undefined,
      },
    });
    if (t.receipt) {
      await prisma.receipt.create({
        data: { txId: created.id, userId: user.id, storagePath: `receipts/${user.id}/${created.id}.jpg`, mimeType: "image/jpeg", sizeBytes: 182_400 },
      });
    }
    if (payerIsMe && t.acc) {
      const delta = t.type === "INCOME" ? paise : -paise;
      deltas.set(t.acc, deltas.get(t.acc)! + delta);
    }
    if (t.type === "TRANSFER" && t.to) deltas.set(t.to, deltas.get(t.to)! + paise);
  }

  // The gap between the 6 months of seeded transactions and each account's target
  // closing balance becomes a real dated "Opening balance" transaction (just before
  // the seeded window) rather than a synthetic openingBalance plug — otherwise
  // "Clear transactions" (balance -> openingBalance) resets accounts to a
  // meaningless number instead of a sane one.
  const openingDate = addDaysYMD(d(shiftMonthKey(thisKey, -5), 1), -1);
  for (const a of ACCOUNTS) {
    const gap = a.target - deltas.get(a.key)!;
    if (gap !== 0) {
      await prisma.transaction.create({
        data: {
          userId: user.id,
          type: gap > 0 ? "INCOME" : "EXPENSE",
          amount: Math.abs(gap),
          accountId: accountIds.get(a.key)!,
          merchant: "Opening balance",
          occurredAt: istNoon(openingDate),
          notes: "Balance carried in from before you started tracking in Ledgerly",
        },
      });
    }
    await prisma.account.update({
      where: { id: accountIds.get(a.key)! },
      data: { openingBalance: 0, balance: a.target },
    });
  }

  // budgets (monthly, per category)
  const budgets: [string, number][] = [["Food", 8000], ["Groceries", 6000], ["Shopping", 3000], ["Travel", 3000], ["Entertainment", 2500]];
  for (const [c, limit] of budgets) {
    await prisma.budget.create({ data: { userId: user.id, categoryId: cat(c), period: "MONTHLY", limit: limit * 100 } });
  }

  // bills relative to today
  const addDays = (n: number) => {
    const dt = new Date(istNoon(today));
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt;
  };
  const bills: [string, string, number, number][] = [
    ["ACT Fibernet", "Internet", 1180, 2],
    ["Electricity · BESCOM", "Electricity", 1900, 5],
    ["Axis Credit Card bill", "EMI", 12450, 8],
    ["Term Insurance", "Insurance", 2340, 15],
    ["Rent · Flat 402", "Rent", 36000, 22],
  ];
  for (const [name, c, rupees, inDays] of bills) {
    await prisma.bill.create({
      data: { userId: user.id, name, amount: rupees * 100, categoryId: cat(c), dueDate: addDays(inDays), cadence: "MONTHLY" },
    });
  }

  // one settlement: Rohan paid you ₹5,000 a week ago
  await prisma.settlement.create({
    data: {
      userId: user.id,
      participantId: friends.get("rohan")!,
      direction: "TO_OWNER",
      amount: 5000 * 100,
      method: "UPI",
      settledAt: addDays(-7),
    },
  });

  // a recurring rule the cron can materialize (Netflix, next month)
  await prisma.recurringRule.create({
    data: {
      userId: user.id,
      cadence: "MONTHLY",
      interval: 1,
      nextRunAt: istNoon(`${shiftMonthKey(thisKey, 1)}-08`),
      kind: "TRANSACTION",
      template: { type: "EXPENSE", amount: 649 * 100, accountId: accountIds.get("axis"), categoryId: cat("Subscription"), merchant: "Netflix" },
    },
  });

  console.log(`Done. Sign in as ${EMAIL} / ${PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
