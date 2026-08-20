import { describe, expect, it } from "vitest";
import { amountColumns, compactBalanceLabel, entryNotes, ledgerTotals } from "./lending-row";
import { balanceAfterLabel } from "./lending";

describe("compactBalanceLabel", () => {
  it("says which way the money runs, in the app's own words", () => {
    expect(compactBalanceLabel(500000)).toEqual({ text: "You'll get ₹5,000", color: "var(--green)" });
    expect(compactBalanceLabel(-80000)).toEqual({ text: "You'll pay ₹800", color: "var(--red)" });
  });

  it("never names the contact — the panel header already does", () => {
    // The row this replaces read "Balance: Roshan Prusty RIT owes you ₹5,000",
    // repeated on every entry.
    for (const paise of [500000, -80000, 0, 100, -100]) {
      const { text } = compactBalanceLabel(paise);
      expect(text).not.toMatch(/owes you|You owe/);
      expect(text.split(" ").length).toBeLessThanOrEqual(3);
    }
  });

  it("keeps the ±₹1 settled deadband, so it can never disagree with balanceAfterLabel", () => {
    for (const paise of [0, 100, -100, 101, -101, 999999, -999999]) {
      const compactSettled = compactBalanceLabel(paise).text === "Settled up";
      const namedSettled = balanceAfterLabel(paise, "Someone").text === "Settled up";
      expect(compactSettled).toBe(namedSettled);
      // and the direction agrees too
      expect(compactBalanceLabel(paise).color).toBe(balanceAfterLabel(paise, "Someone").color);
    }
  });

  it("treats sub-rupee drift as settled, either way", () => {
    expect(compactBalanceLabel(100).text).toBe("Settled up");
    expect(compactBalanceLabel(-100).text).toBe("Settled up");
    expect(compactBalanceLabel(101).text).toBe("You'll get ₹1.01");
    expect(compactBalanceLabel(-101).text).toBe("You'll pay ₹1.01");
  });
});

describe("entryNotes", () => {
  it("pairs the reason with the funding source", () => {
    expect(entryNotes({ reason: "Rent help", accountName: "Cash Wallet" })).toEqual({
      note: "Rent help",
      noteLabel: "Rent help",
      source: "via Cash Wallet",
      linksToAccount: true,
    });
  });

  it("says 'Untracked / cash' when no account backs the entry, and offers no link", () => {
    expect(entryNotes({ reason: "Dinner", accountName: null })).toEqual({
      note: "Dinner",
      noteLabel: "Dinner",
      source: "Untracked / cash",
      linksToAccount: false,
    });
  });

  it("falls back to the free-text note when there is no reason", () => {
    expect(entryNotes({ reason: null, notes: "paid in two halves", accountName: null }).note).toBe("paid in two halves");
  });

  it("returns null rather than an empty line when there is nothing to say", () => {
    expect(entryNotes({ reason: null, notes: null, accountName: "HDFC Savings" }).note).toBeNull();
    expect(entryNotes({ reason: "   ", notes: "  ", accountName: null }).note).toBeNull();
  });

  it("says 'No note' rather than leaving the column blank", () => {
    expect(entryNotes({ reason: null, notes: null, accountName: "HDFC Savings" }).noteLabel).toBe("No note");
    expect(entryNotes({ reason: "   ", notes: null, accountName: null }).noteLabel).toBe("No note");
    // and steps aside the moment there is something real to show
    expect(entryNotes({ reason: "Rent help", accountName: null }).noteLabel).toBe("Rent help");
  });

  it("shows nothing but what a person typed — never an id", () => {
    // A LoanEntry carries several identifiers alongside the two text fields.
    // The column must be incapable of picking one up, whatever is passed in.
    const withIds = {
      id: "cmt1au3i40001l1p87jtttuhd",
      participantId: "cmt0zz9xk0002l1p8abcd1234",
      userId: "cmt0zz9xk0000l1p8wxyz9876",
      accountId: "cmt0zz9xk0003l1p8qrst5555",
      reason: null,
      notes: null,
      accountName: null,
    };
    const rendered = Object.values(entryNotes(withIds)).join(" ");
    for (const id of [withIds.id, withIds.participantId, withIds.userId, withIds.accountId]) {
      expect(rendered).not.toContain(id);
    }
    // nothing id-shaped at all: no cuid, no uuid
    expect(rendered).not.toMatch(/c[a-z0-9]{20,}/);
    expect(rendered).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(rendered.trim()).toBe("No note Untracked / cash false");
  });

  it("never carries the contact's name", () => {
    const n = entryNotes({ reason: "Rent help", accountName: "Cash Wallet" });
    expect(`${n.note} ${n.source}`).not.toMatch(/Roshan|owes|You owe/);
  });
});

describe("amountColumns", () => {
  it("puts money out in You Gave and leaves You Got empty", () => {
    expect(amountColumns({ kind: "GAVE", amount: 2000000 })).toEqual({ gave: "₹20,000", got: null });
  });

  it("puts money in in You Got and leaves You Gave empty", () => {
    expect(amountColumns({ kind: "GOT", amount: 500000 })).toEqual({ gave: null, got: "₹5,000" });
  });

  it("never fills both columns — the point of splitting them", () => {
    for (const kind of ["GAVE", "GOT"] as const) {
      const cols = amountColumns({ kind, amount: 1234 });
      expect([cols.gave, cols.got].filter(Boolean)).toHaveLength(1);
    }
  });

  it("formats in rupees, not paise", () => {
    expect(amountColumns({ kind: "GOT", amount: 1000000 }).got).toBe("₹10,000");
  });
});

describe("ledgerTotals", () => {
  const rows = [
    { kind: "GAVE", amount: 2000000 },
    { kind: "GOT", amount: 1000000 },
    { kind: "GOT", amount: 500000 },
  ] as const;

  it("totals each column separately", () => {
    expect(ledgerTotals([...rows])).toEqual({ gave: 2000000, got: 1500000, count: 3 });
  });

  it("counts what is on screen, so a filtered list totals the filtered rows", () => {
    expect(ledgerTotals(rows.filter((r) => r.kind === "GOT"))).toEqual({ gave: 0, got: 1500000, count: 2 });
  });

  it("an empty ledger totals zero rather than throwing", () => {
    expect(ledgerTotals([])).toEqual({ gave: 0, got: 0, count: 0 });
  });

  it("never mutates or reorders its input — display order is not its business", () => {
    const input = [...rows];
    const snapshot = JSON.stringify(input);
    ledgerTotals(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("stays in paise integers, so no float drift reaches the screen", () => {
    const t = ledgerTotals([
      { kind: "GAVE", amount: 1 },
      { kind: "GAVE", amount: 2 },
      { kind: "GOT", amount: 3 },
    ]);
    expect(Number.isInteger(t.gave) && Number.isInteger(t.got)).toBe(true);
    expect(t).toEqual({ gave: 3, got: 3, count: 3 });
  });
});
