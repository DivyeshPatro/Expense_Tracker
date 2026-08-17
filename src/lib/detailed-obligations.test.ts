// Detailed obligations — "who owes whom, based on the actual expenses?"
//
// The rule these cases protect: an obligation is owed to THE PERSON WHO PAID.
// The previous shape had two buckets per member, both keyed to the owner, so
// it could not express "Ben owes Ana". When a member fronted a bill split five
// ways, the ₹992 they were owed collapsed into a single "owner → payer ₹992"
// row — aggregating three other people's ₹248 obligations and attributing them
// all to the owner — while those three were shown owing the OWNER instead.
//
// Detailed is un-minimised on purpose: minimizeSettlements() is what collapses
// these into the fewest transfers, and the two answers must stay mathematically
// consistent without being the same list.

import { describe, expect, it } from "vitest";
import {
  computeDetailedObligations,
  computeMemberBalances,
  computeSuggestions,
  OWNER_SENTINEL,
  type GroupExpenseRow,
  type GroupSettlementRow,
} from "./group-dashboard";

const OWNER = null;
const A = "p-a", B = "p-b", C = "p-c", D = "p-d";
const ALL = [A, B, C, D];
const r = (n: number) => Math.round(n * 100);

const expense = (
  id: string,
  paidBy: string | null,
  splits: [string | null, number][]
): GroupExpenseRow => ({
  id,
  // Amount always equals the sum of its splits — splitEqual/splitByWeights/
  // splitExact all guarantee that, so no fixture here may violate it.
  amount: splits.reduce((s, [, owed]) => s + r(owed), 0),
  ymd: "2026-08-17",
  paidByParticipantId: paidBy,
  categoryId: null,
  category: null,
  icon: "",
  color: "",
  splits: splits.map(([participantId, owed]) => ({ participantId, owedAmount: r(owed) })),
});

const equal = (id: string, paidBy: string | null, each: number, who: (string | null)[]) =>
  expense(id, paidBy, who.map((p) => [p, each] as [string | null, number]));

/** Collapses -0 onto 0 — Object.is (and so toBe) treats them as different. */
const norm = (n: number) => (n === 0 ? 0 : n);

/** What `who` owes out, minus what is owed to them. */
const position = (rows: { fromId: string; toId: string; amount: number }[], who: string) =>
  norm(rows.reduce((t, x) => t + (x.fromId === who ? x.amount : 0) - (x.toId === who ? x.amount : 0), 0));

/** Every participant's detailed position must equal their engine net. */
function expectReconciles(expenses: GroupExpenseRow[], memberIds: string[], settlements: GroupSettlementRow[] = []) {
  const rows = computeDetailedObligations(expenses, settlements, memberIds);
  const { members, youNet } = computeMemberBalances(expenses, settlements, memberIds);
  for (const m of members) {
    if (m.participantId === null) continue;
    expect(position(rows, m.participantId)).toBe(m.net);
  }
  // The owner's net is reported from their own side, so it flips.
  expect(position(rows, OWNER_SENTINEL)).toBe(norm(-youNet));
  // Nothing created, nothing lost.
  expect(rows.reduce((t, x) => t + x.amount, 0) >= 0).toBe(true);
  return rows;
}

describe("A — the owner pays for everyone", () => {
  const rows = expectReconciles([equal("t1", OWNER, 250, [OWNER, A, B, C, D])], ALL);

  it("everyone who shared owes the owner their share", () => {
    expect(rows).toHaveLength(4);
    expect(rows.every((x) => x.toId === OWNER_SENTINEL && x.amount === r(250))).toBe(true);
  });

  it("the owner's own share is not an obligation", () => {
    expect(rows.some((x) => x.fromId === OWNER_SENTINEL)).toBe(false);
  });
});

describe("B — a member pays for everyone (the reported bug)", () => {
  // A pays ₹1,240 split five ways at ₹248.
  const rows = expectReconciles([equal("cab", A, 248, [OWNER, A, B, C, D])], ALL);

  it("every other participant owes ₹248 TO THE PAYER", () => {
    expect(rows).toHaveLength(4);
    expect(rows.every((x) => x.toId === A && x.amount === r(248))).toBe(true);
    expect(rows.map((x) => x.fromId).sort()).toEqual([B, C, D, OWNER_SENTINEL].sort());
  });

  it("never aggregates the other members' shares onto the owner", () => {
    // The old output was a single "owner → payer ₹992".
    expect(rows.some((x) => x.amount === r(992))).toBe(false);
    expect(rows.find((x) => x.fromId === OWNER_SENTINEL)!.amount).toBe(r(248));
  });

  it("still totals the ₹992 the payer fronted", () => {
    expect(rows.reduce((t, x) => t + x.amount, 0)).toBe(r(992));
  });

  it("the payer owes nobody for their own bill", () => {
    expect(rows.some((x) => x.fromId === A)).toBe(false);
  });
});

describe("C — several members pay different expenses", () => {
  const expenses = [
    equal("t1", OWNER, 100, [OWNER, A, B, C]),
    equal("t2", A, 200, [OWNER, A, B, C]),
    equal("t3", B, 50, [OWNER, A, B, C]),
  ];
  const rows = expectReconciles(expenses, [A, B, C]);

  it("obligations point at each payer independently", () => {
    expect(rows.filter((x) => x.toId === OWNER_SENTINEL)).toHaveLength(3);
    expect(rows.filter((x) => x.toId === A)).toHaveLength(3);
    expect(rows.filter((x) => x.toId === B)).toHaveLength(3);
  });

  it("C, who paid nothing, owes all three payers separately", () => {
    const cOwes = rows.filter((x) => x.fromId === C);
    expect(cOwes).toHaveLength(3);
    expect(cOwes.reduce((t, x) => t + x.amount, 0)).toBe(r(350));
  });
});

describe("D — unequal splits", () => {
  // B's share is double everyone else's.
  const expenses = [expense("lunch", A, [[OWNER, 422], [A, 422], [B, 844], [C, 422]])];
  const rows = expectReconciles(expenses, [A, B, C]);

  it("each obligation is that person's own share, not an average", () => {
    expect(rows.find((x) => x.fromId === B)!.amount).toBe(r(844));
    expect(rows.find((x) => x.fromId === OWNER_SENTINEL)!.amount).toBe(r(422));
    expect(rows.find((x) => x.fromId === C)!.amount).toBe(r(422));
  });

  it("the payer is owed exactly the rest of the bill", () => {
    expect(rows.reduce((t, x) => t + x.amount, 0)).toBe(r(422 + 844 + 422));
  });
});

describe("E — some of it already settled", () => {
  const expenses = [equal("t1", OWNER, 300, [OWNER, A, B])];

  it("a settlement reduces the obligation it paid down", () => {
    const settlements: GroupSettlementRow[] = [
      { id: "s1", participantId: A, direction: "TO_OWNER", amount: r(100), settledAt: "2026-08-17T00:00:00Z" },
    ];
    const rows = expectReconciles(expenses, [A, B], settlements);
    expect(rows.find((x) => x.fromId === A)!.amount).toBe(r(200));
    expect(rows.find((x) => x.fromId === B)!.amount).toBe(r(300));
  });

  it("over-settling flips the direction instead of going negative", () => {
    const settlements: GroupSettlementRow[] = [
      { id: "s1", participantId: A, direction: "TO_OWNER", amount: r(500), settledAt: "2026-08-17T00:00:00Z" },
    ];
    const rows = expectReconciles(expenses, [A, B], settlements);
    expect(rows.every((x) => x.amount > 0)).toBe(true);
    expect(rows.find((x) => x.toId === A)!.amount).toBe(r(200)); // owner now owes A
    expect(rows.some((x) => x.fromId === A)).toBe(false);
  });

  it("a fully settled group produces no obligations", () => {
    const settlements: GroupSettlementRow[] = [
      { id: "s1", participantId: A, direction: "TO_OWNER", amount: r(300), settledAt: "2026-08-17T00:00:00Z" },
      { id: "s2", participantId: B, direction: "TO_OWNER", amount: r(300), settledAt: "2026-08-17T00:00:00Z" },
    ];
    expect(computeDetailedObligations(expenses, settlements, [A, B])).toHaveLength(0);
  });
});

describe("F — member-to-member obligations, with the owner uninvolved", () => {
  const rows = expectReconciles([equal("t1", A, 100, [A, B, C])], [A, B, C]);

  it("stays between the two members", () => {
    expect(rows).toHaveLength(2);
    expect(rows.every((x) => x.toId === A)).toBe(true);
    expect(rows.some((x) => x.fromId === OWNER_SENTINEL || x.toId === OWNER_SENTINEL)).toBe(false);
  });
});

describe("G — the same group, whoever is looking", () => {
  // computeDetailedObligations takes no viewer at all: the same expenses
  // entered from any account produce the same obligations. Here the account
  // holder (participantId null) rotates through three different people.
  const asOwner = [equal("t1", null, 300, [null, "x", "y"])]; //  owner is the payer
  const asX = [equal("t1", "o", 300, ["o", null, "y"])]; //        X's account: payer is participant "o"
  const asY = [equal("t1", "o", 300, ["o", "x", null])]; //        Y's account

  const canon = (rows: { fromId: string; toId: string; amount: number }[], self: string) =>
    rows.map((x) => `${x.fromId === OWNER_SENTINEL ? self : x.fromId}→${x.toId === OWNER_SENTINEL ? self : x.toId} ${x.amount}`).sort();

  it("produces identical obligations from every account", () => {
    const fromOwner = canon(computeDetailedObligations(asOwner, [], ["x", "y"]), "o");
    expect(canon(computeDetailedObligations(asX, [], ["o", "y"]), "x")).toEqual(fromOwner);
    expect(canon(computeDetailedObligations(asY, [], ["o", "x"]), "y")).toEqual(fromOwner);
  });
});

describe("H — Detailed vs Fewest Payments: different lists, same maths", () => {
  // A owes the owner ₹500; the owner owes B ₹500. Two obligations, one payment.
  const expenses = [
    expense("t1", OWNER, [[A, 500]]),
    expense("t2", B, [[OWNER, 500]]),
  ];

  it("Detailed lists the raw obligations", () => {
    const rows = computeDetailedObligations(expenses, [], [A, B]);
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.fromId === A)!.toId).toBe(OWNER_SENTINEL);
    expect(rows.find((x) => x.fromId === OWNER_SENTINEL)!.toId).toBe(B);
  });

  it("Fewest Payments collapses them into one hop", () => {
    const { members } = computeMemberBalances(expenses, [], [A, B]);
    const plan = computeSuggestions(members.map((m) => ({ participantId: m.participantId, net: m.net, name: m.participantId ?? "me" })));
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ fromId: A, toId: B, amount: r(500) });
  });

  it("both leave every participant at exactly zero", () => {
    const rows = computeDetailedObligations(expenses, [], [A, B]);
    const { members } = computeMemberBalances(expenses, [], [A, B]);
    const plan = computeSuggestions(members.map((m) => ({ participantId: m.participantId, net: m.net, name: m.participantId ?? "me" })));
    for (const who of [A, B, OWNER_SENTINEL]) {
      const viaDetailed = position(rows, who);
      const viaPlan = plan.reduce((t, x) => t + (x.fromId === who ? x.amount : 0) - (x.toId === who ? x.amount : 0), 0);
      expect(viaDetailed).toBe(viaPlan);
    }
  });

  it("Detailed is never shorter than the minimised plan", () => {
    const bigger = [
      equal("e1", OWNER, 100, [OWNER, A, B, C]),
      equal("e2", A, 200, [OWNER, A, B, C]),
      equal("e3", B, 50, [OWNER, A, B, C]),
    ];
    const rows = computeDetailedObligations(bigger, [], [A, B, C]);
    const { members } = computeMemberBalances(bigger, [], [A, B, C]);
    const plan = computeSuggestions(members.map((m) => ({ participantId: m.participantId, net: m.net, name: m.participantId ?? "me" })));
    expect(plan.length).toBeLessThanOrEqual(rows.length);
  });
});

describe("conservation across the whole group", () => {
  it("every obligation owed by someone is owed to someone — the group nets to zero", () => {
    const expenses = [
      equal("e1", OWNER, 100, [OWNER, A, B, C, D]),
      equal("e2", A, 248, [OWNER, A, B, C, D]),
      expense("e3", C, [[OWNER, 30], [A, 60], [C, 10]]),
    ];
    const rows = expectReconciles(expenses, ALL);
    const total = [...ALL, OWNER_SENTINEL].reduce((t, who) => t + position(rows, who), 0);
    expect(total).toBe(0);
  });

  it("holds to the paisa when a split does not divide evenly", () => {
    // ₹1,265 three ways: 421.66 / 421.67 / 421.67 — the payer absorbs the odd paisa.
    const expenses = [expense("odd", A, [[OWNER, 421.66], [A, 421.67], [B, 421.67]])];
    const rows = expectReconciles(expenses, [A, B]);
    expect(rows.reduce((t, x) => t + x.amount, 0)).toBe(r(421.66) + r(421.67));
    expect(rows.every((x) => Number.isInteger(x.amount))).toBe(true);
  });
});
