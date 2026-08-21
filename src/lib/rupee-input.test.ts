// Prefilling an amount field must not lose paise.
//
// Settling a balance offered a whole-rupee figure: every call site wrote
// String(Math.round(paise / 100)), so a ₹745.33 balance prefilled ₹745 and
// settling it left 33 paise behind. Group balances are already carrying
// sub-rupee residue from exact-paise splitting; a settle flow that rounds is
// how that residue becomes permanent, because the one action meant to clear a
// balance can never quite reach it.
//
// The property that matters is the round trip: whatever goes into the field
// must come back out as the same number of paise, since toPaise() is what the
// submitted value is parsed with.

import { describe, expect, it } from "vitest";
import { toPaise, toRupeeInput } from "./money";

describe("toRupeeInput", () => {
  it("keeps the paise", () => {
    expect(toRupeeInput(74533)).toBe("745.33"); // the Srisailam balance
    expect(toRupeeInput(133)).toBe("1.33");
    expect(toRupeeInput(34)).toBe("0.34");
    expect(toRupeeInput(1)).toBe("0.01");
  });

  it("omits the decimals when there are none", () => {
    // "600.00" in a field the user is about to edit is noise; formatPaise makes
    // the same distinction.
    expect(toRupeeInput(60000)).toBe("600");
    expect(toRupeeInput(100)).toBe("1");
    expect(toRupeeInput(0)).toBe("0");
  });

  it("pads a single-digit paise value", () => {
    // 705 paise is ₹7.05, not ₹7.5 — the bug this padding prevents.
    expect(toRupeeInput(705)).toBe("7.05");
    expect(toRupeeInput(1005)).toBe("10.05");
  });

  it("drops the sign, as formatPaise does — direction is carried separately", () => {
    expect(toRupeeInput(-74533)).toBe("745.33");
    expect(toRupeeInput(-1)).toBe("0.01");
  });

  it("accepts bigint, since that is how amounts come out of the database", () => {
    expect(toRupeeInput(74533n)).toBe("745.33");
    expect(toRupeeInput(60000n)).toBe("600");
  });

  it("handles amounts past the lakh, where float division starts to drift", () => {
    expect(toRupeeInput(1234567891)).toBe("12345678.91");
    expect(toRupeeInput(999999999999)).toBe("9999999999.99");
  });

  it("round-trips through toPaise, which is what parses the submitted value", () => {
    const cases = [0, 1, 7, 34, 99, 100, 133, 705, 74533, 60000, 1234567891];
    for (const paise of cases) {
      expect({ paise, back: toPaise(toRupeeInput(paise)) }).toEqual({ paise, back: paise });
    }
  });

  it("round-trips across a dense sweep, including every paise remainder", () => {
    for (let p = 0; p < 1000; p++) expect(toPaise(toRupeeInput(p))).toBe(p);
    for (let p = 99_000; p < 99_200; p++) expect(toPaise(toRupeeInput(p))).toBe(p);
  });

  it("settling a balance clears it exactly, which the old rounding could not", () => {
    // The regression, stated as the behaviour that failed: prefill the field
    // from a balance, submit it unchanged, and nothing should remain.
    for (const balance of [74533, 133, 34, 25_034, 60_000]) {
      const submitted = toPaise(toRupeeInput(balance));
      expect(balance - submitted).toBe(0);
      // what the old code would have offered instead
      const old = Math.round(Math.abs(balance) / 100) * 100;
      if (balance % 100 !== 0) expect(balance - old).not.toBe(0);
    }
  });
});
