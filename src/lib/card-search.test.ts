import { describe, expect, it } from "vitest";
import { cardMatchesQuery } from "./card-search";
import type { CreditCardListItem } from "@/server/services/credit-cards";

function card(over: Partial<CreditCardListItem> = {}): CreditCardListItem {
  return {
    id: "c1",
    nickname: "Amazon Card",
    bank: "HDFC Bank",
    network: "VISA",
    last4: "4242",
    color: null,
    isDefault: false,
    isFavorite: false,
    isArchived: false,
    cardholderName: "DIVYESH PATRO",
    isExpired: false,
    keyMatches: true,
    ...over,
  };
}

describe("cardMatchesQuery", () => {
  it("matches everything when the query is blank", () => {
    expect(cardMatchesQuery(card(), "")).toBe(true);
    expect(cardMatchesQuery(card(), "   ")).toBe(true);
  });

  it("matches nickname, bank, last four, network and cardholder", () => {
    for (const q of ["amazon", "hdfc", "4242", "visa", "divyesh"]) {
      expect(cardMatchesQuery(card(), q), q).toBe(true);
    }
  });

  it("ignores case", () => {
    expect(cardMatchesQuery(card(), "AMAZON")).toBe(true);
  });

  // Terms are AND-ed across fields, so a query spanning two of them narrows
  // instead of matching nothing.
  it("requires every term, across different fields", () => {
    expect(cardMatchesQuery(card(), "hdfc 4242")).toBe(true);
    expect(cardMatchesQuery(card(), "hdfc 9999")).toBe(false);
  });

  it("does not match an unrelated query", () => {
    expect(cardMatchesQuery(card(), "axis")).toBe(false);
  });

  it("copes with a card whose holder couldn't be decrypted", () => {
    expect(cardMatchesQuery(card({ cardholderName: null }), "hdfc")).toBe(true);
    expect(cardMatchesQuery(card({ cardholderName: null }), "divyesh")).toBe(false);
  });
});
