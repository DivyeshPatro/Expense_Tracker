// Display order for the Lending dashboard's contacts list.
//
// Same rule as the history sort: presentation only. The dashboard renders
// balances the server already computed, and FIFO reads the database — so
// nothing here can reach the money. These cases pin the orders, the
// interaction with search, and the fact that the source array is never touched.

import { describe, expect, it } from "vitest";
import {
  CONTACT_SORTS,
  DEFAULT_CONTACT_SORT,
  parseContactSort,
  sortLendingContacts,
  type ContactSort,
  type SortableContact,
} from "./loan-sort";

const c = (name: string, net: number, lastTransactionYmd: string | null): SortableContact => ({ name, net, lastTransactionYmd });

// A owes you the most; D you owe (negative); E has never transacted.
const ROWS: SortableContact[] = [
  c("Bela", 50_000, "2026-02-10"),
  c("Arun", 120_000, "2026-01-05"),
  c("Chandra", -90_000, "2026-03-01"), // you owe them ₹900
  c("Dev", 10_000, "2026-02-10"), // same day as Bela
  c("Esha", 0, null), // no transactions
];
const order = (s: ContactSort) => sortLendingContacts(ROWS, s).map((r) => r.name);

describe("1 — Recent (the default)", () => {
  it("is the default", () => {
    expect(DEFAULT_CONTACT_SORT).toBe("recent");
    expect(parseContactSort(undefined)).toBe("recent");
    expect(parseContactSort("nonsense")).toBe("recent");
  });

  it("orders by last activity, newest first", () => {
    expect(order("recent")).toEqual(["Chandra", "Bela", "Dev", "Arun", "Esha"]);
  });

  it("breaks a same-date tie by name, so it can never flip between renders", () => {
    expect(order("recent").indexOf("Bela")).toBeLessThan(order("recent").indexOf("Dev"));
  });
});

describe("2 — Oldest", () => {
  it("orders by last activity, oldest first", () => {
    expect(order("oldest")).toEqual(["Arun", "Bela", "Dev", "Chandra", "Esha"]);
  });

  it("still puts a contact with no transactions last — an empty contact is not 'the oldest'", () => {
    expect(order("oldest").at(-1)).toBe("Esha");
    expect(order("recent").at(-1)).toBe("Esha");
  });
});

describe("3 — Highest amount", () => {
  it("is the SIZE of the balance, so money you owe counts too", () => {
    expect(order("highest")).toEqual(["Arun", "Chandra", "Bela", "Dev", "Esha"]);
  });
});

describe("4 — Lowest amount", () => {
  it("smallest balance first", () => {
    expect(order("lowest")).toEqual(["Esha", "Dev", "Bela", "Chandra", "Arun"]);
  });
});

describe("5 — Person", () => {
  it("is alphabetical — the list's behaviour before the control existed", () => {
    expect(order("name")).toEqual(["Arun", "Bela", "Chandra", "Dev", "Esha"]);
  });
});

describe("6 — search and sort together", () => {
  it("sorting applies to what the search left behind", () => {
    // the component filters first, then sorts — mirrored here
    const matching = ROWS.filter((r) => r.name.toLowerCase().includes("a"));
    expect(sortLendingContacts(matching, "highest").map((r) => r.name)).toEqual(["Arun", "Chandra", "Bela", "Esha"]);
    expect(sortLendingContacts(matching, "name").map((r) => r.name)).toEqual(["Arun", "Bela", "Chandra", "Esha"]);
  });

  it("an empty result stays empty under every sort", () => {
    for (const s of CONTACT_SORTS) expect(sortLendingContacts([], s.value)).toEqual([]);
  });
});

describe("9 — the numbers are untouched by ordering", () => {
  it("every sort returns the same contacts with the same balances", () => {
    const total = ROWS.reduce((t, r) => t + r.net, 0);
    const owed = ROWS.filter((r) => r.net > 0).reduce((t, r) => t + r.net, 0);
    for (const s of CONTACT_SORTS) {
      const out = sortLendingContacts(ROWS, s.value);
      expect(out).toHaveLength(ROWS.length);
      expect(out.reduce((t, r) => t + r.net, 0)).toBe(total);
      expect(out.filter((r) => r.net > 0).reduce((t, r) => t + r.net, 0)).toBe(owed);
      expect(out.map((r) => r.name).sort()).toEqual(ROWS.map((r) => r.name).sort());
    }
  });
});

describe("11 — no mutation of the source", () => {
  it("never reorders or edits the caller's array", () => {
    const before = ROWS.map((r) => ({ ...r }));
    for (const s of CONTACT_SORTS) sortLendingContacts(ROWS, s.value);
    expect(ROWS).toEqual(before);
    expect(ROWS.map((r) => r.name)).toEqual(before.map((r) => r.name));
  });

  it("returns a new array each time", () => {
    expect(sortLendingContacts(ROWS, "name")).not.toBe(ROWS);
  });
});

describe("10 — deterministic", () => {
  it("gives the same answer whatever order the rows arrive in", () => {
    for (const s of CONTACT_SORTS) {
      const forwards = sortLendingContacts(ROWS, s.value).map((r) => r.name);
      const backwards = sortLendingContacts([...ROWS].reverse(), s.value).map((r) => r.name);
      expect(backwards).toEqual(forwards);
    }
  });

  it("is stable across repeated calls", () => {
    for (const s of CONTACT_SORTS) {
      const runs = Array.from({ length: 8 }, () => sortLendingContacts([...ROWS].reverse(), s.value).map((r) => r.name).join());
      expect(new Set(runs).size).toBe(1);
    }
  });
});

describe("the five options", () => {
  it("are exactly the ones asked for", () => {
    expect(CONTACT_SORTS.map((s) => s.label)).toEqual(["Recent", "Oldest", "Highest amount", "Lowest amount", "Person"]);
  });
});
