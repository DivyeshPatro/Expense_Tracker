import { describe, expect, it } from "vitest";
import {
  deserializeExpiry,
  detectNetwork,
  formatCardNumber,
  formatExpiry,
  isPlausibleLength,
  isValidCvv,
  isValidLuhn,
  lastFour,
  maskCardNumber,
  maskFromLast4,
  networkLabel,
  normalizeCardNumber,
  parseExpiry,
  serializeExpiry,
} from "./card-identity";

// Standard published test numbers — these are the issuers' own non-functional
// samples, not real cards.
const VISA = "4111111111111111";
const VISA_13 = "4222222222222";
const MASTERCARD = "5555555555554444";
const MASTERCARD_2 = "2223003122003222";
const AMEX = "378282246310005";
const DINERS = "36227206271667";

describe("normalizeCardNumber", () => {
  it("strips the spacing and dashes people actually paste", () => {
    expect(normalizeCardNumber("4111 1111 1111 1111")).toBe(VISA);
    expect(normalizeCardNumber("4111-1111-1111-1111")).toBe(VISA);
    expect(normalizeCardNumber(" 4111 1111-1111 1111 ")).toBe(VISA);
  });
});

describe("isValidLuhn", () => {
  it("accepts valid numbers, spaced or not", () => {
    for (const n of [VISA, MASTERCARD, MASTERCARD_2, AMEX, DINERS, VISA_13]) {
      expect(isValidLuhn(n)).toBe(true);
    }
    expect(isValidLuhn("4111 1111 1111 1111")).toBe(true);
  });

  it("rejects a single mistyped digit", () => {
    expect(isValidLuhn("4111111111111112")).toBe(false);
  });

  // The classic transposition Luhn exists to catch.
  it("rejects transposed adjacent digits", () => {
    expect(isValidLuhn("5555555555544454")).toBe(false);
  });

  it("rejects non-numeric and empty input", () => {
    expect(isValidLuhn("")).toBe(false);
    expect(isValidLuhn("abcd")).toBe(false);
    expect(isValidLuhn("4111-1111-1111-111x")).toBe(false);
  });
});

describe("detectNetwork", () => {
  it("identifies each supported network from its IIN", () => {
    expect(detectNetwork(VISA)).toBe("VISA");
    expect(detectNetwork(MASTERCARD)).toBe("MASTERCARD");
    expect(detectNetwork(MASTERCARD_2)).toBe("MASTERCARD"); // 2-series
    expect(detectNetwork(AMEX)).toBe("AMEX");
    expect(detectNetwork(DINERS)).toBe("DINERS");
    expect(detectNetwork("6521123412341234")).toBe("RUPAY");
    expect(detectNetwork("8123456789012345")).toBe("RUPAY");
    expect(detectNetwork("6012345678901234")).toBe("RUPAY");
  });

  it("does not guess when the range is unrecognised", () => {
    expect(detectNetwork("9999999999999999")).toBe("OTHER");
    expect(detectNetwork("7012345678901234")).toBe("OTHER");
  });

  it("works from a partial number, as typed", () => {
    expect(detectNetwork("41")).toBe("VISA");
    expect(detectNetwork("34")).toBe("AMEX");
    expect(detectNetwork("65")).toBe("RUPAY");
  });

  it("returns OTHER rather than throwing on junk", () => {
    expect(detectNetwork("")).toBe("OTHER");
    expect(detectNetwork("4")).toBe("OTHER"); // too short to classify
    expect(detectNetwork("abcd")).toBe("OTHER");
  });

  // RuPay's 65 and Mastercard's 51–55 are adjacent enough to be worth pinning.
  it("does not confuse RuPay 65 with the Mastercard 51-55 range", () => {
    expect(detectNetwork("6512345678901234")).toBe("RUPAY");
    expect(detectNetwork("5512345678901234")).toBe("MASTERCARD");
  });
});

describe("isPlausibleLength", () => {
  it("enforces the per-network digit counts", () => {
    expect(isPlausibleLength(AMEX)).toBe(true);           // 15
    expect(isPlausibleLength(DINERS)).toBe(true);         // 14
    expect(isPlausibleLength(VISA)).toBe(true);           // 16
    expect(isPlausibleLength(VISA_13)).toBe(true);        // 13, legacy
    expect(isPlausibleLength("378282246310")).toBe(false); // short Amex
    expect(isPlausibleLength("41111111111111111")).toBe(false); // 17
  });
});

describe("lastFour / masking", () => {
  it("derives the last four digits", () => {
    expect(lastFour("4111 1111 1111 4242")).toBe("4242");
    expect(lastFour(AMEX)).toBe("0005");
  });

  it("masks everything except the last four", () => {
    const masked = maskCardNumber(VISA);
    expect(masked).toBe("•••• •••• •••• 1111");
    expect(masked).not.toContain("4111");
  });

  it("masks Amex in its printed 4-6-5 grouping", () => {
    expect(maskCardNumber(AMEX)).toBe("•••• •••••• •0005");
  });

  // The gallery has last4 and nothing else, so it masks from that rather than
  // from a number it was never given.
  it("builds the same mask from last4 alone", () => {
    expect(maskFromLast4("VISA", "1111")).toBe(maskCardNumber(VISA));
    expect(maskFromLast4("AMEX", "0005")).toBe(maskCardNumber(AMEX));
    expect(maskFromLast4("RUPAY", "4242")).toBe("•••• •••• •••• 4242");
  });

  it("stays the right shape if last4 is somehow short", () => {
    expect(maskFromLast4("VISA", "42")).toBe("•••• •••• •••• ••42");
    expect(maskFromLast4("VISA", "")).toBe("•••• •••• •••• ••••");
  });

  it("formats a revealed number in the printed grouping", () => {
    expect(formatCardNumber(VISA)).toBe("4111 1111 1111 1111");
    expect(formatCardNumber(AMEX)).toBe("3782 822463 10005");
  });
});

describe("parseExpiry", () => {
  const now = new Date("2026-07-30T00:00:00Z");

  it("accepts a future expiry", () => {
    const r = parseExpiry(9, 2029, now);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.parts).toEqual({ month: 9, year: 2029 });
    expect(r.expired).toBe(false);
  });

  // Cards work through the last day of their expiry month.
  it("treats the expiry month itself as still valid", () => {
    const r = parseExpiry(7, 2026, now);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.expired).toBe(false);
  });

  it("flags a past expiry as expired rather than rejecting it", () => {
    const r = parseExpiry(6, 2026, now);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.expired).toBe(true);
  });

  it("rejects an out-of-range month", () => {
    for (const m of [0, 13, -1, 1.5]) {
      expect(parseExpiry(m, 2029, now).ok).toBe(false);
    }
  });

  // A two-digit year is ambiguous; asking is better than guessing the century.
  it("requires a four-digit year", () => {
    expect(parseExpiry(9, 29, now).ok).toBe(false);
    expect(parseExpiry(9, 1999, now).ok).toBe(false);
    expect(parseExpiry(9, 2100, now).ok).toBe(false);
  });

  it("accepts numeric strings, as they arrive from a form", () => {
    const r = parseExpiry("09", "2029", now);
    expect(r.ok).toBe(true);
  });
});

describe("expiry formatting and storage", () => {
  it("displays as printed on the card", () => {
    expect(formatExpiry(9, 2029)).toBe("09 / 29");
    expect(formatExpiry(12, 2030)).toBe("12 / 30");
  });

  it("stores unambiguously and round-trips", () => {
    expect(serializeExpiry(9, 2029)).toBe("09/2029");
    expect(deserializeExpiry("09/2029")).toEqual({ month: 9, year: 2029 });
  });

  it("returns null for a malformed stored value instead of guessing", () => {
    expect(deserializeExpiry("9/2029")).toBeNull();
    expect(deserializeExpiry("09/29")).toBeNull();
    expect(deserializeExpiry("")).toBeNull();
  });
});

describe("isValidCvv", () => {
  it("requires 4 digits for Amex and 3 for everything else", () => {
    expect(isValidCvv("1234", "AMEX")).toBe(true);
    expect(isValidCvv("123", "AMEX")).toBe(false);
    expect(isValidCvv("123", "VISA")).toBe(true);
    expect(isValidCvv("1234", "VISA")).toBe(false);
    expect(isValidCvv("123")).toBe(true);
  });

  it("rejects non-numeric input", () => {
    expect(isValidCvv("12a")).toBe(false);
    expect(isValidCvv("")).toBe(false);
  });
});

describe("networkLabel", () => {
  it("gives the display name for each network", () => {
    expect(networkLabel("VISA")).toBe("Visa");
    expect(networkLabel("RUPAY")).toBe("RuPay");
    expect(networkLabel("MASTERCARD")).toBe("Mastercard");
    expect(networkLabel("OTHER")).toBe("Other");
  });
});
