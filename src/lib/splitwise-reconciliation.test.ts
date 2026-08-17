// Reconciliation fixture — Ledgerly's balance engine vs a real Splitwise export
// of the SAME seven expenses.
//
// Why this exists: computeMemberBalances used to credit a non-owner payer only
// for the OWNER's share of the bill they had fronted. On the ₹1,240 expense
// below, the payer put up ₹1,240, consumed ₹248 of it, and was therefore owed
// ₹992 — but was credited ₹248, leaving ₹744 of other people's debt wrongly
// attached to them. Group totals hid it: Σ(paid − share) is always zero, so the
// owner's headline number stayed correct while every per-person row was off.
//
// The fixture is the arithmetic from the Splitwise CSV, so a regression here
// means Ledgerly and Splitwise would disagree about who owes whom.

import { describe, expect, it } from "vitest";
import { computeGrossObligations, computeMemberBalances, type GroupExpenseRow, type GroupSettlementRow } from "./group-dashboard";

// The owner + four others, as exported.
const ANA = "p-ana"; // the member who paid the ₹1,240
const BEN = "p-ben";
const CARA = "p-cara";
const DEV = "p-dev";
const OTHERS = [ANA, BEN, CARA, DEV];

const rupees = (n: number) => Math.round(n * 100);

const expense = (
  id: string,
  amount: number,
  paidBy: string | null,
  splits: [string | null, number][]
): GroupExpenseRow => ({
  id,
  amount: rupees(amount),
  ymd: "2026-08-16",
  paidByParticipantId: paidBy,
  categoryId: null,
  category: null,
  icon: "📦",
  color: "",
  splits: splits.map(([participantId, owed]) => ({ participantId, owedAmount: rupees(owed) })),
});

/** Equal five-way split, payer named. */
const equal5 = (id: string, amount: number, paidBy: string | null) => {
  const each = amount / 5;
  return expense(id, amount, paidBy, [[null, each], [ANA, each], [BEN, each], [CARA, each], [DEV, each]]);
};

// The seven rows of the Splitwise export, in order.
const EXPENSES: GroupExpenseRow[] = [
  equal5("bus", 5400, null), //            you paid → others −1080 each
  equal5("uber-to-bus", 315, null), //     you paid → others −63 each
  equal5("tiffin", 390, null), //          you paid → others −78 each
  equal5("cab-city", 4000, null), //        you paid → others −800 each
  equal5("cab-petrol", 1240, ANA), //  ANA paid → he is owed 992
  equal5("dinner", 1280, null), //         you paid → others −256 each
  // Lunch is deliberately unequal: Ana's share is double.
  expense("lunch", 2530, null, [[null, 422], [ANA, 842], [BEN, 422], [CARA, 422], [DEV, 422]]),
];

const balances = (expenses = EXPENSES, settlements: GroupSettlementRow[] = []) =>
  computeMemberBalances(expenses, settlements, OTHERS);

const netOf = (pid: string, r = balances()) => r.members.find((m) => m.participantId === pid)!.net;

describe("the ₹1,240 expense a non-owner paid", () => {
  const row = EXPENSES.find((e) => e.id === "cab-petrol")!;

  it("splits five ways at ₹248 each, including the payer's own share", () => {
    expect(row.amount).toBe(rupees(1240));
    expect(row.splits).toHaveLength(5);
    expect(row.splits.every((s) => s.owedAmount === rupees(248))).toBe(true);
    expect(row.splits.find((s) => s.participantId === ANA)!.owedAmount).toBe(rupees(248));
  });

  it("credits the payer ₹992 — the amount they fronted for everyone else", () => {
    const ownShare = row.splits.find((s) => s.participantId === ANA)!.owedAmount;
    expect(row.amount - ownShare).toBe(rupees(992));

    // In isolation the payer should end up ₹992 to the good.
    const only = computeMemberBalances([row], [], OTHERS);
    expect(only.members.find((m) => m.participantId === ANA)!.net).toBe(rupees(-992));
  });

  it("no longer credits only the owner's ₹248 share (the regression)", () => {
    const only = computeMemberBalances([row], [], OTHERS);
    expect(only.members.find((m) => m.participantId === ANA)!.net).not.toBe(rupees(-248));
  });

  it("charges the other three members their ₹248 for it", () => {
    const only = computeMemberBalances([row], [], OTHERS);
    for (const p of [BEN, CARA, DEV]) {
      expect(only.members.find((m) => m.participantId === p)!.net).toBe(rupees(248));
    }
  });
});

describe("full group reconciliation against the Splitwise export", () => {
  it("matches Splitwise for every participant", () => {
    const r = balances();
    expect(r.youNet).toBe(rupees(10968)); // Splitwise: owner +10,968.00
    expect(netOf(ANA, r)).toBe(rupees(2127)); // Splitwise: Ana −2,127
    expect(netOf(BEN, r)).toBe(rupees(2947)); // Splitwise: Ben −2,947
    expect(netOf(CARA, r)).toBe(rupees(2947));
    expect(netOf(DEV, r)).toBe(rupees(2947));
  });

  it("does NOT reproduce the old wrong figures", () => {
    const r = balances();
    expect(netOf(ANA, r)).not.toBe(rupees(2871)); // what the old rule gave
    expect(netOf(BEN, r)).not.toBe(rupees(2699));
  });

  it("keeps the owner's total unchanged — the bug never moved it", () => {
    // The whole point: this figure was already right under the old engine.
    expect(balances().youNet).toBe(rupees(10968));
  });

  it("balances to zero across every participant", () => {
    const r = balances();
    const sum = r.members.filter((m) => m.participantId !== null).reduce((s, m) => s + m.net, 0) - r.youNet;
    expect(sum).toBe(0);
  });

  it("totals the same spend as the export", () => {
    expect(balances().totalSpend).toBe(rupees(15155));
  });

  it("leaves the six owner-paid expenses exactly as before", () => {
    // Everything except the cab-petrol row; these were always correct.
    const ownerPaid = EXPENSES.filter((e) => e.paidByParticipantId === null);
    const r = computeMemberBalances(ownerPaid, [], OTHERS);
    expect(netOf(BEN, r)).toBe(rupees(1080 + 63 + 78 + 800 + 256 + 422));
    expect(netOf(ANA, r)).toBe(rupees(1080 + 63 + 78 + 800 + 256 + 842));
    expect(r.youNet).toBe(rupees(4320 + 252 + 312 + 3200 + 1024 + 2108));
  });

  it("gross obligations reconcile with the corrected net", () => {
    const r = balances();
    const gross = computeGrossObligations(EXPENSES, [], OTHERS);
    for (const p of OTHERS) {
      const g = gross.find((x) => x.participantId === p)!;
      expect(g.owesYou - g.youOwe).toBe(netOf(p, r));
    }
    // and the payer's credit shows as the ₹992 they fronted
    expect(gross.find((g) => g.participantId === ANA)!.youOwe).toBe(rupees(992));
    expect(gross.find((g) => g.participantId === ANA)!.owesYou).toBe(rupees(3119));
  });
});

describe("payment shapes", () => {
  it("only the owner pays", () => {
    const r = computeMemberBalances([equal5("a", 500, null)], [], OTHERS);
    expect(r.youNet).toBe(rupees(400));
    for (const p of OTHERS) expect(netOf(p, r)).toBe(rupees(100));
  });

  it("only another member pays", () => {
    const r = computeMemberBalances([equal5("a", 500, BEN)], [], OTHERS);
    expect(netOf(BEN, r)).toBe(rupees(-400)); // owed what he fronted
    for (const p of [ANA, CARA, DEV]) expect(netOf(p, r)).toBe(rupees(100));
    expect(r.youNet).toBe(rupees(-100)); // you owe your share
  });

  it("multiple members pay", () => {
    const r = computeMemberBalances([equal5("a", 500, BEN), equal5("b", 1000, CARA)], [], OTHERS);
    expect(netOf(BEN, r)).toBe(rupees(100 + 200 - 500)); // −200
    expect(netOf(CARA, r)).toBe(rupees(100 + 200 - 1000)); // −700
    expect(netOf(ANA, r)).toBe(rupees(300));
    expect(r.youNet).toBe(rupees(-300));
    const sum = r.members.filter((m) => m.participantId !== null).reduce((s, m) => s + m.net, 0) - r.youNet;
    expect(sum).toBe(0);
  });

  it("one person both pays and owes", () => {
    // Srikant fronts one bill and owes on another.
    const r = computeMemberBalances([equal5("a", 500, null), equal5("b", 1000, ANA)], [], OTHERS);
    // share 100 + 200 = 300; paid 1000 → net −700
    expect(netOf(ANA, r)).toBe(rupees(-700));
    const gross = computeGrossObligations([equal5("a", 500, null), equal5("b", 1000, ANA)], [], OTHERS);
    const g = gross.find((x) => x.participantId === ANA)!;
    expect(g.owesYou).toBe(rupees(100)); // his share of the bill you paid
    expect(g.youOwe).toBe(rupees(800)); // what he fronted for the other four
    expect(g.owesYou - g.youOwe).toBe(rupees(-700));
  });

  it("settlements already exist", () => {
    const settlements: GroupSettlementRow[] = [
      { id: "s1", participantId: BEN, direction: "TO_OWNER", amount: rupees(1000), settledAt: "2026-08-17T00:00:00Z" },
      { id: "s2", participantId: ANA, direction: "FROM_OWNER", amount: rupees(500), settledAt: "2026-08-17T00:00:00Z" },
    ];
    const before = balances();
    const after = balances(EXPENSES, settlements);
    expect(netOf(BEN, after)).toBe(netOf(BEN, before) - rupees(1000));
    expect(netOf(ANA, after)).toBe(netOf(ANA, before) + rupees(500));
    // the owner's side moves by the same amounts, so the group still balances
    expect(after.youNet).toBe(before.youNet - rupees(1000) + rupees(500));
    const sum = after.members.filter((m) => m.participantId !== null).reduce((s, m) => s + m.net, 0) - after.youNet;
    expect(sum).toBe(0);
  });

  it("rounding produces fractional paise without losing any", () => {
    // ₹1000 / 3 — the payer absorbs the remainder.
    const e = expense("odd", 1000, CARA, [[null, 333.33], [CARA, 333.34], [BEN, 333.33]]);
    const r = computeMemberBalances([e], [], [CARA, BEN]);
    expect(e.splits.reduce((s, x) => s + x.owedAmount, 0)).toBe(rupees(1000));
    expect(netOf(CARA, r)).toBe(rupees(333.34) - rupees(1000)); // −66,666 paise
    expect(netOf(BEN, r)).toBe(rupees(333.33));
    const sum = r.members.filter((m) => m.participantId !== null).reduce((s, m) => s + m.net, 0) - r.youNet;
    expect(sum).toBe(0); // not a paisa created or lost
  });
});
