import { describe, expect, it } from "vitest";
import { detectLendingSource, resolveColumns } from "./detect";
import { khatabookAdapter } from "./adapters";

describe("detectLendingSource", () => {
  it("recognises a classic Khatabook two-column export with high confidence", () => {
    const d = detectLendingSource(["Date", "Name", "You Gave", "You Got", "Balance"]);
    expect(d?.adapter.id).toBe("khatabook");
    expect(d?.auto).toBe(true);
    expect(d!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("recognises header wording variations (Customer / Debit / Credit)", () => {
    const d = detectLendingSource(["Txn Date", "Customer Name", "Debit", "Credit", "Remarks"]);
    expect(d?.adapter.id).toBe("khatabook");
    expect(d?.auto).toBe(true);
  });

  it("recognises the single amount + type shape", () => {
    const d = detectLendingSource(["Date", "Party", "Amount", "Type", "Note"]);
    expect(d?.adapter.id).toBe("khatabook");
    expect(d?.auto).toBe(true);
  });

  it("stays under the auto threshold when the direction columns are missing", () => {
    // A contact and a date but no gave/got/amount+type — not confidently lending.
    const d = detectLendingSource(["Date", "Name"]);
    expect(d).toBeNull();
  });

  it("does not claim a plain expense CSV as lending", () => {
    const d = detectLendingSource(["Date", "Category", "Merchant", "Amount"]);
    // No contact/party column, so no direction pairing that makes it a ledger.
    expect(d).toBeNull();
  });
});

describe("resolveColumns", () => {
  it("maps aliases to the actual header strings, once", () => {
    const cols = resolveColumns(["Date", "Customer Name", "You Gave", "You Got", "Details"], khatabookAdapter);
    expect(cols).toEqual({
      contact: "Customer Name",
      date: "Date",
      gave: "You Gave",
      got: "You Got",
      amount: undefined,
      type: undefined,
      note: "Details",
      balance: undefined,
    });
  });

  it("resolves the single amount + type shape", () => {
    const cols = resolveColumns(["Date", "Party", "Amount", "Type", "Note"], khatabookAdapter);
    expect(cols?.amount).toBe("Amount");
    expect(cols?.type).toBe("Type");
    expect(cols?.gave).toBeUndefined();
  });

  it("returns null when a mandatory column is absent", () => {
    expect(resolveColumns(["You Gave", "You Got"], khatabookAdapter)).toBeNull(); // no contact/date
  });

  it("does not assign one header to two fields", () => {
    // "Amount" should be claimed once; note must not also grab it.
    const cols = resolveColumns(["Date", "Name", "Amount", "Type"], khatabookAdapter);
    expect(cols?.amount).toBe("Amount");
    expect(cols?.note).toBeUndefined();
  });
});
