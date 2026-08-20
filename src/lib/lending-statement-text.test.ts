// The shared lending statement — what lands in someone's WhatsApp.
//
// It is read by the other party, so the bar is: their name, their real dates
// and amounts, a balance stated in words rather than a sign they have to guess
// at, and nothing from inside the database.

import { describe, expect, it } from "vitest";
import { balanceWording, lendingStatementText, type StatementTextEntry } from "./lending-statement-text";

const rup = (n: number) => Math.round(n * 100);
const e = (ymd: string, createdAt: string, kind: "GAVE" | "GOT", amount: number, bal: number): StatementTextEntry =>
  ({ ymd, createdAt, kind, amount, balanceAfterPaise: bal });

// Newest first, as the ledger holds them.
const ENTRIES = [
  e("2026-08-20", "2026-08-20T07:03:00.000Z", "GOT", rup(300), rup(7700)),
  e("2026-08-01", "2026-08-01T07:03:00.000Z", "GAVE", rup(8000), rup(8000)),
];
const base = {
  contactName: "Asha",
  periodLabel: "All time",
  entries: ENTRIES,
  totalGavePaise: rup(8000),
  totalGotPaise: rup(300),
  closingBalancePaise: rup(7700),
};

describe("13 — the statement says the right things", () => {
  const text = lendingStatementText(base);

  it("names the real contact", () => {
    expect(text).toContain("Person: Asha");
    expect(text).toContain("Period: All time");
  });

  it("carries real dates and recorded-at times", () => {
    expect(text).toContain("20 Aug 2026 · added 12:33 PM");
    expect(text).toContain("01 Aug 2026 · added 12:33 PM");
  });

  it("labels the time as when it was ADDED, never as when the money moved", () => {
    // occurredAt has no time of day; claiming one would be invented precision.
    expect(text).toMatch(/· added \d{1,2}:\d{2} (AM|PM)/);
  });

  it("shows each transaction's direction, amount and balance", () => {
    expect(text).toContain("You Got ₹300");
    expect(text).toContain("You Gave ₹8,000");
    expect(text).toContain("Balance: ₹7,700 owed to you");
  });

  it("totals match the entries", () => {
    expect(text).toContain("You gave: ₹8,000");
    expect(text).toContain("You got: ₹300");
    expect(text).toContain("Net: ₹7,700 owed to you");
  });

  it("states the balance in words, not a bare sign", () => {
    // The reference design shows this as "-7,700", which reads as the opposite
    // of the dashboard's "You'll get ₹7,700" two taps away.
    expect(text).not.toContain("-7,700");
    expect(text).not.toContain("−₹7,700");
  });
});

describe("14 — nothing internal leaks", () => {
  it("contains no ids, no field names, no implementation detail", () => {
    const text = lendingStatementText({ ...base, entries: ENTRIES });
    for (const banned of ["cuid", "participantId", "userId", "GAVE", "GOT", "occurredAt", "createdAt", "balanceAfterPaise", "paise", "null", "undefined"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("uses the contact's name rather than an identifier", () => {
    expect(lendingStatementText({ ...base, contactName: "Ravi Kumar" })).toContain("Person: Ravi Kumar");
  });
});

describe("17 — empty, single and very large histories", () => {
  it("says so plainly when there is nothing", () => {
    const text = lendingStatementText({ ...base, entries: [], totalGavePaise: 0, totalGotPaise: 0, closingBalancePaise: 0 });
    expect(text).toContain("No transactions yet.");
    expect(text).toContain("settled up with Asha");
    expect(text).not.toContain("Transactions:");
  });

  it("handles a single entry", () => {
    const text = lendingStatementText({ ...base, entries: [ENTRIES[1]], totalGotPaise: 0, closingBalancePaise: rup(8000) });
    expect(text).toContain("You Gave ₹8,000");
    expect(text).toContain("Net: ₹8,000 owed to you");
  });

  it("trims a very long history and says how many were left out", () => {
    const many = Array.from({ length: 500 }, (_, i) => e("2026-08-20", "2026-08-20T07:03:00.000Z", "GAVE", rup(10), rup(10 * (i + 1))));
    const text = lendingStatementText({ ...base, entries: many, maxRows: 40 });
    expect(text).toContain("…and 460 earlier entries. Export the PDF for the full statement.");
    // exactly 40 transaction lines — the summary's "You gave:" is lower-case
    // and does not match
    expect(text.split("You Gave ").length - 1).toBe(40);
  });

  it("does not trim when the history fits", () => {
    expect(lendingStatementText(base)).not.toContain("earlier entries");
  });
});

describe("balance wording", () => {
  it("reads from the owner's side, matching the rest of the app", () => {
    expect(balanceWording(rup(7700), "Asha")).toBe("₹7,700 owed to you");
    expect(balanceWording(rup(-800), "Asha")).toBe("you owe ₹800");
    expect(balanceWording(0, "Asha")).toBe("settled up with Asha");
  });
});
