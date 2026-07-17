import { describe, expect, it } from "vitest";
import { intentLabel } from "./offline-context";

// Phase 3 widened intentLabel to cover update/delete kinds alongside the
// original creates — pin the exact label text each kind produces, since it's
// what the transaction list badge, Sync Center queue, and activity feed all
// render verbatim.
describe("intentLabel", () => {
  it("labels an expense create", () => {
    expect(intentLabel({ kind: "expense.create", payload: { amount: "420", merchant: "Swiggy" } })).toBe("₹420 · Swiggy");
  });

  it("labels an expense update the same way as a create", () => {
    expect(intentLabel({ kind: "expense.update", payload: { amount: "420", merchant: "Swiggy" } })).toBe("₹420 · Swiggy");
  });

  it("labels an income update", () => {
    expect(intentLabel({ kind: "income.update", payload: { amount: "25000", merchant: "Salary" } })).toBe("₹25,000 · Salary");
  });

  it("labels a transfer update as Transfer regardless of payload merchant", () => {
    expect(intentLabel({ kind: "transfer.update", payload: { amount: "500" } })).toBe("₹500 · Transfer");
  });

  it("labels a delete from its {amount, merchant} display snapshot", () => {
    expect(intentLabel({ kind: "tx.delete", payload: { amount: "180", merchant: "Uber" } })).toBe("₹180 · Uber");
  });

  it("falls back to a generic name when merchant is missing", () => {
    expect(intentLabel({ kind: "income.update", payload: { amount: "100" } })).toBe("₹100 · Income");
  });
});
