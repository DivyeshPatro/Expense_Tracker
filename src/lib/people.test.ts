import { describe, expect, it } from "vitest";
import { combineBalances, sortByOutstanding, totals, type PersonSource } from "./people";

const p = (id: string, name: string): PersonSource => ({
  id,
  name,
  initial: name[0],
  color: "#000",
  linkedUserId: null,
});

const L = (net: number, overdueCount = 0) => ({ net, overdueCount });

describe("combineBalances — the bug this exists to fix (#207)", () => {
  it("adds the two ledgers into one number", () => {
    // the exact case reproduced during the audit
    const [karan] = combineBalances([p("k", "Karan")], new Map([["k", L(300000)]]), new Map([["k", 1263833]]));
    expect(karan.lendingNet).toBe(300000);
    expect(karan.sharedNet).toBe(1263833);
    expect(karan.net).toBe(1563833); // ₹15,638.33 — the number the app never said
    expect(karan.hasBothSources).toBe(true);
  });

  it("nets opposing debts against each other", () => {
    // you lent them ₹5,000; they covered ₹2,000 of your share of a dinner
    const [x] = combineBalances([p("x", "Priya")], new Map([["x", L(500000)]]), new Map([["x", -200000]]));
    expect(x.net).toBe(300000);
    expect(x.settled).toBe(false);
  });

  it("treats equal and opposite balances as settled", () => {
    const [x] = combineBalances([p("x", "Rohan")], new Map([["x", L(250000)]]), new Map([["x", -250000]]));
    expect(x.net).toBe(0);
    expect(x.settled).toBe(true);
  });

  it("ignores sub-rupee rounding dust from splits", () => {
    const [x] = combineBalances([p("x", "Dust")], new Map(), new Map([["x", 67]]));
    expect(x.settled).toBe(true);
  });

  it("handles a person present in only one ledger", () => {
    const [lendOnly] = combineBalances([p("a", "A")], new Map([["a", L(100000)]]), new Map());
    expect(lendOnly.net).toBe(100000);
    expect(lendOnly.hasBothSources).toBe(false);

    const [sharedOnly] = combineBalances([p("b", "B")], new Map(), new Map([["b", 90000]]));
    expect(sharedOnly.net).toBe(90000);
    expect(sharedOnly.hasBothSources).toBe(false);
  });

  it("carries overdue loans through", () => {
    const [x] = combineBalances([p("x", "X")], new Map([["x", L(100000, 2)]]), new Map());
    expect(x.overdueCount).toBe(2);
  });
});

describe("sortByOutstanding", () => {
  it("puts who owes you most first and settled people last", () => {
    const rows = combineBalances(
      [p("a", "A"), p("b", "B"), p("c", "C")],
      new Map([
        ["a", L(50000)],
        ["b", L(-90000)],
      ]),
      new Map([["c", 0]])
    );
    expect(sortByOutstanding(rows).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("totals", () => {
  it("splits owed-to-you from you-owe and counts what needs settling", () => {
    const rows = combineBalances(
      [p("a", "A"), p("b", "B"), p("c", "C")],
      new Map([
        ["a", L(300000, 1)],
        ["b", L(-100000)],
      ]),
      new Map([["a", 200000]])
    );
    const t = totals(rows);
    expect(t.owedToYou).toBe(500000);
    expect(t.youOwe).toBe(100000);
    expect(t.net).toBe(400000);
    expect(t.toSettle).toBe(2); // C is settled
    expect(t.overdueCount).toBe(1);
  });
});
