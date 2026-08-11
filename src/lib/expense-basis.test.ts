import { describe, expect, it } from "vitest";
import {
  BASIS_FIGURE_LABEL,
  BASIS_PREF,
  CANONICAL_EXPENSE_BASIS,
  DEFAULT_BASIS_PREF,
  EXPENSE_BASIS,
  basisFor,
  frontedForOthers,
  parseBasisPref,
  personalShare,
} from "./expense-basis";

describe("personalShare", () => {
  it("counts an unsplit expense in full", () => {
    expect(personalShare({ type: "EXPENSE", amount: 42000, ownShare: null })).toBe(42000);
  });

  it("counts only the owner's share of a split expense", () => {
    // ₹36,000 rent split 3 ways — you paid, but you bear ₹12,000
    expect(personalShare({ type: "EXPENSE", amount: 3600000, ownShare: 1200000 })).toBe(1200000);
  });

  it("counts your share of an expense a friend paid", () => {
    // Priya paid ₹1,700 for PVR, split 2 ways. You still owe ₹850, so it is your expense.
    expect(personalShare({ type: "EXPENSE", amount: 170000, ownShare: 85000 })).toBe(85000);
  });

  it("ignores income and transfers", () => {
    expect(personalShare({ type: "INCOME", amount: 12000000, ownShare: null })).toBe(0);
    expect(personalShare({ type: "TRANSFER", amount: 300000, ownShare: null })).toBe(0);
  });

  it("handles a fully-fronted expense (your share zero)", () => {
    expect(personalShare({ type: "EXPENSE", amount: 100000, ownShare: 0 })).toBe(0);
  });
});

describe("frontedForOthers", () => {
  it("is the gap between what you paid and what you bear", () => {
    expect(frontedForOthers(7771900, 5248734)).toBe(2523166);
  });

  it("is zero when nothing was fronted", () => {
    expect(frontedForOthers(5248734, 5248734)).toBe(0);
  });

  it("never goes negative when friends paid more than you", () => {
    // your share can exceed what you paid — you owe the difference, you did not front it
    expect(frontedForOthers(1000, 5000)).toBe(0);
  });
});

describe("basis metadata", () => {
  it("canonical basis is personal share", () => {
    expect(CANONICAL_EXPENSE_BASIS).toBe("personalShare");
  });

  it("every basis has a label and a hint so no figure ships unlabelled", () => {
    for (const meta of Object.values(EXPENSE_BASIS)) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.hint.length).toBeGreaterThan(0);
    }
  });
});

describe("basis preference", () => {
  it("defaults to cash — matches the bank statement and Accounts on day one", () => {
    expect(DEFAULT_BASIS_PREF).toBe("cash");
  });

  it("falls back to the default for missing, unknown or malformed cookie values", () => {
    expect(parseBasisPref(undefined)).toBe("cash");
    expect(parseBasisPref(null)).toBe("cash");
    expect(parseBasisPref("")).toBe("cash");
    expect(parseBasisPref("gross")).toBe("cash");
    expect(parseBasisPref("PERSONAL")).toBe("cash"); // case-sensitive on purpose
    expect(parseBasisPref("'; DROP TABLE")).toBe("cash");
  });

  it("round-trips both valid values", () => {
    expect(parseBasisPref("cash")).toBe("cash");
    expect(parseBasisPref("personal")).toBe("personal");
  });

  it("maps each preference to the internal basis it selects", () => {
    expect(basisFor("cash")).toBe("paidByYou");
    expect(basisFor("personal")).toBe("personalShare");
  });

  it("never maps a preference to the gross basis — gross is for auditing a list, not a headline", () => {
    expect(basisFor("cash")).not.toBe("gross");
    expect(basisFor("personal")).not.toBe("gross");
  });

  it("both preferences have settings copy and a figure label", () => {
    for (const id of ["cash", "personal"] as const) {
      expect(BASIS_PREF[id].label.length).toBeGreaterThan(0);
      expect(BASIS_PREF[id].description.length).toBeGreaterThan(0);
      expect(BASIS_FIGURE_LABEL[id].length).toBeGreaterThan(0);
    }
  });
});
