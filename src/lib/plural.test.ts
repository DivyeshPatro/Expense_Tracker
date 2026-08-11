import { describe, expect, it } from "vitest";
import { plural, pluralize } from "./plural";

describe("plural", () => {
  it("keeps the singular for exactly one — the '1 accounts' bug", () => {
    expect(plural(1, "account")).toBe("1 account");
  });
  it("pluralizes everything else, including zero", () => {
    expect(plural(0, "account")).toBe("0 accounts");
    expect(plural(2, "account")).toBe("2 accounts");
    expect(plural(17, "transaction")).toBe("17 transactions");
  });
  it("takes an explicit plural for irregular nouns", () => {
    expect(plural(1, "entry", "entries")).toBe("1 entry");
    expect(plural(3, "entry", "entries")).toBe("3 entries");
  });
  it("treats -1 as plural, matching English", () => {
    expect(plural(-1, "account")).toBe("-1 accounts");
  });
});

describe("pluralize", () => {
  it("returns just the noun", () => {
    expect(pluralize(1, "txn")).toBe("txn");
    expect(pluralize(5, "txn")).toBe("txns");
    expect(pluralize(1, "category", "categories")).toBe("category");
  });
});
