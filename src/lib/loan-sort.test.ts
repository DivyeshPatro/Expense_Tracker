// Display order for the Lending history — and proof it stays display-only.
//
// The danger in putting a sort control next to a money ledger is that the two
// get wired together. FIFO has its own fixed rule (FIFO_ORDER: oldest date,
// then oldest entry); choosing "Highest amount" must change what you look at
// first and nothing else.

import { describe, expect, it } from "vitest";
import { allocateFifo, type OpenLoan } from "./loan-settlement";
import { DEFAULT_LOAN_SORT, groupsByMonth, LOAN_SORTS, parseLoanSort, sortLoanEntries, type LoanSort } from "./loan-sort";

const e = (id: string, amount: number, ymd: string, createdAt: string) => ({ id, amount, ymd, createdAt });

// Two on one day (b entered after a), one earlier, one later.
const ROWS = [
  e("a", 100, "2026-02-01", "2026-02-01T09:00:00.000Z"),
  e("b", 500, "2026-02-01", "2026-02-01T18:00:00.000Z"),
  e("early", 300, "2026-01-01", "2026-01-01T09:00:00.000Z"),
  e("late", 200, "2026-03-01", "2026-03-01T09:00:00.000Z"),
];
const ids = (sort: LoanSort) => sortLoanEntries(ROWS, sort).map((r) => r.id);

describe("A — the default", () => {
  it("is Recent", () => {
    expect(DEFAULT_LOAN_SORT).toBe("recent");
    expect(parseLoanSort(undefined)).toBe("recent");
    expect(parseLoanSort("nonsense")).toBe("recent");
    expect(LOAN_SORTS[0].value).toBe("recent");
  });

  it("offers exactly the four options", () => {
    expect(LOAN_SORTS.map((s) => s.label)).toEqual(["Recent", "Oldest", "Highest amount", "Lowest amount"]);
  });
});

describe("B — Recent: date desc, then entered desc", () => {
  it("newest day first, and the later entry first within a day", () => {
    expect(ids("recent")).toEqual(["late", "b", "a", "early"]);
  });
});

describe("C — Oldest: date asc, then entered asc", () => {
  it("is the exact reverse", () => {
    expect(ids("oldest")).toEqual(["early", "a", "b", "late"]);
  });
});

describe("D — Highest amount", () => {
  it("largest first", () => {
    expect(ids("highest")).toEqual(["b", "early", "late", "a"]);
  });

  it("falls back to recency when amounts tie", () => {
    const tied = [
      e("older", 100, "2026-01-01", "2026-01-01T09:00:00.000Z"),
      e("newer", 100, "2026-05-01", "2026-05-01T09:00:00.000Z"),
    ];
    expect(sortLoanEntries(tied, "highest").map((r) => r.id)).toEqual(["newer", "older"]);
  });
});

describe("E — Lowest amount", () => {
  it("smallest first", () => {
    expect(ids("lowest")).toEqual(["a", "late", "early", "b"]);
  });

  it("still falls back to recency, not to oldest", () => {
    const tied = [
      e("older", 100, "2026-01-01", "2026-01-01T09:00:00.000Z"),
      e("newer", 100, "2026-05-01", "2026-05-01T09:00:00.000Z"),
    ];
    expect(sortLoanEntries(tied, "lowest").map((r) => r.id)).toEqual(["newer", "older"]);
  });
});

describe("F — same-day entries are deterministic", () => {
  it("every sort gives the same answer whatever order the rows arrive in", () => {
    for (const s of LOAN_SORTS.map((x) => x.value)) {
      const forwards = sortLoanEntries(ROWS, s).map((r) => r.id);
      const backwards = sortLoanEntries([...ROWS].reverse(), s).map((r) => r.id);
      expect(backwards).toEqual(forwards);
    }
  });

  it("is stable across repeated calls", () => {
    const runs = Array.from({ length: 10 }, () => sortLoanEntries([...ROWS].reverse(), "highest").map((r) => r.id).join());
    expect(new Set(runs).size).toBe(1);
  });
});

describe("G — sorting changes nothing underneath", () => {
  it("never mutates or reorders the caller's array", () => {
    const original = [...ROWS];
    for (const s of LOAN_SORTS.map((x) => x.value)) sortLoanEntries(ROWS, s);
    expect(ROWS).toEqual(original);
    expect(ROWS.map((r) => r.id)).toEqual(original.map((r) => r.id));
  });

  it("returns the same rows, only reordered", () => {
    for (const s of LOAN_SORTS.map((x) => x.value)) {
      const out = sortLoanEntries(ROWS, s);
      expect(out).toHaveLength(ROWS.length);
      expect([...out].map((r) => r.id).sort()).toEqual(ROWS.map((r) => r.id).sort());
      expect(out.reduce((t, r) => t + r.amount, 0)).toBe(ROWS.reduce((t, r) => t + r.amount, 0));
    }
  });
});

describe("H — display sort cannot influence FIFO", () => {
  // The loans the allocator sees, in the shape it takes.
  const loans: OpenLoan[] = [
    { id: "a", amount: 100_000, settledAmount: 0, occurredAt: "2026-01-10", createdAt: "2026-01-10T09:00:00.000Z" },
    { id: "b", amount: 50_000, settledAmount: 0, occurredAt: "2026-01-10", createdAt: "2026-01-10T15:00:00.000Z" },
  ];

  it("a repayment lands on the same loan under every display sort", () => {
    const expected = [{ gaveEntryId: "a", amount: 70_000 }];
    for (const s of LOAN_SORTS.map((x) => x.value)) {
      // Feed the allocator rows in the order that display sort would show them.
      const displayed = sortLoanEntries(
        loans.map((l) => ({ ...l, ymd: l.occurredAt, amount: l.amount })),
        s
      );
      const reordered = displayed.map((d) => loans.find((l) => l.id === d.id)!);
      expect(allocateFifo(70_000, reordered)).toEqual(expected);
    }
  });

  it("even 'Highest amount', which would otherwise put the bigger loan first", () => {
    const displayed = sortLoanEntries(loans.map((l) => ({ ...l, ymd: l.occurredAt })), "highest");
    expect(displayed[0].id).toBe("a"); // a is 1000, b is 500 — a is bigger anyway
    const lowestFirst = sortLoanEntries(loans.map((l) => ({ ...l, ymd: l.occurredAt })), "lowest");
    expect(lowestFirst[0].id).toBe("b"); // b first on screen …
    const reordered = lowestFirst.map((d) => loans.find((l) => l.id === d.id)!);
    expect(allocateFifo(70_000, reordered)).toEqual([{ gaveEntryId: "a", amount: 70_000 }]); // … but a is still paid
  });
});

describe("month headings", () => {
  it("apply only while the list runs in date order", () => {
    expect(groupsByMonth("recent")).toBe(true);
    expect(groupsByMonth("oldest")).toBe(true);
    expect(groupsByMonth("highest")).toBe(false);
    expect(groupsByMonth("lowest")).toBe(false);
  });
});
