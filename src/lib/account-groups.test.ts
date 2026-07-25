import { describe, expect, it } from "vitest";
import { accountOptionLabel, cardSuffix, groupAccountsByType, type AccountForPicker } from "./account-groups";

const cash: AccountForPicker = { id: "1", name: "Cash Wallet", icon: "💵", type: "CASH" };
const bank: AccountForPicker = { id: "2", name: "HDFC Savings", icon: "🏦", type: "BANK" };
const bank2: AccountForPicker = { id: "3", name: "ICICI Salary", icon: "🏦", type: "BANK" };
const wallet: AccountForPicker = { id: "4", name: "PhonePe", icon: "📱", type: "WALLET" };
const card: AccountForPicker = {
  id: "5",
  name: "Axis Card",
  icon: "💳",
  type: "CREDIT_CARD",
  cardNetwork: "Visa",
  cardLast4: "4242",
};

describe("cardSuffix", () => {
  it("renders the Card Vault identity for a credit card", () => {
    expect(cardSuffix(card)).toBe(" · Visa •••• 4242");
  });

  it("uses whichever half of the Card Vault is filled in", () => {
    expect(cardSuffix({ ...card, cardLast4: null })).toBe(" · Visa");
    expect(cardSuffix({ ...card, cardNetwork: null })).toBe(" · •••• 4242");
  });

  it("adds nothing for a bare credit card or any non-card account", () => {
    expect(cardSuffix({ ...card, cardNetwork: null, cardLast4: null })).toBe("");
    // A bank account carrying stray card fields must not be labelled as a card.
    expect(cardSuffix({ ...bank, cardNetwork: "Visa", cardLast4: "4242" })).toBe("");
  });
});

describe("accountOptionLabel", () => {
  it("prefixes the icon and appends card identity only where it applies", () => {
    expect(accountOptionLabel(bank)).toBe("🏦 HDFC Savings");
    expect(accountOptionLabel(card)).toBe("💳 Axis Card · Visa •••• 4242");
  });
});

describe("groupAccountsByType", () => {
  it("orders groups Cash → Bank → Wallet → Credit card and keeps input order within one", () => {
    const groups = groupAccountsByType([bank, card, cash, bank2, wallet]);
    expect(groups?.map((g) => g.label)).toEqual(["Cash", "Bank", "Wallet", "Credit card"]);
    expect(groups?.find((g) => g.label === "Bank")?.items.map((a) => a.name)).toEqual([
      "HDFC Savings",
      "ICICI Salary",
    ]);
  });

  it("returns null when grouping would add nothing, so callers render a plain list", () => {
    expect(groupAccountsByType([bank, bank2])).toBeNull();
    expect(groupAccountsByType([])).toBeNull();
  });

  // refData.accounts types are optional; an account must never vanish from a
  // funding-source picker just because its type is missing or unrecognised.
  it("keeps untyped and unknown-typed accounts under Other", () => {
    const untyped: AccountForPicker = { id: "9", name: "Mystery", icon: "❓" };
    const weird: AccountForPicker = { id: "10", name: "Crypto", icon: "🪙", type: "SOMETHING_NEW" };
    const groups = groupAccountsByType([bank, untyped, weird]);
    expect(groups?.map((g) => g.label)).toEqual(["Bank", "Other"]);
    expect(groups?.find((g) => g.label === "Other")?.items.map((a) => a.name)).toEqual(["Mystery", "Crypto"]);
  });

  it("never drops an account", () => {
    const all = [bank, card, cash, bank2, wallet, { id: "11", name: "X", icon: "❓" }];
    const groups = groupAccountsByType(all);
    expect(groups!.flatMap((g) => g.items).length).toBe(all.length);
  });
});
