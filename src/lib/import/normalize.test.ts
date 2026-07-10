import { describe, expect, it } from "vitest";
import { emptyMapping } from "./types";
import { normalizeRow } from "./normalize";

describe("normalizeRow", () => {
  it("reads a single signed amount column (negative = expense, the default)", () => {
    const mapping = { ...emptyMapping(), date: "Date", amount: "Amount", merchant: "Merchant" };
    const row = normalizeRow({ Date: "2026-07-10", Amount: "-420", Merchant: "Swiggy" }, 0, mapping);
    expect(row).toMatchObject({ type: "EXPENSE", amountPaise: 42000, ymd: "2026-07-10", merchant: "Swiggy" });
  });

  it("reads a positive-is-expense convention", () => {
    const mapping = { ...emptyMapping(), date: "Date", amount: "Amount", amountSign: "positive-is-expense" as const, merchant: "M" };
    const row = normalizeRow({ Date: "2026-07-10", Amount: "420", M: "Swiggy" }, 0, mapping);
    expect(row.type).toBe("EXPENSE");
  });

  it("reads a debit/credit column pair", () => {
    const mapping = { ...emptyMapping(), date: "Date", debit: "Debit", credit: "Credit", merchant: "Narration" };
    const debitRow = normalizeRow({ Date: "2026-07-10", Debit: "420", Credit: "", Narration: "Swiggy" }, 0, mapping);
    expect(debitRow).toMatchObject({ type: "EXPENSE", amountPaise: 42000 });
    const creditRow = normalizeRow({ Date: "2026-07-01", Debit: "", Credit: "120000", Narration: "Salary" }, 1, mapping);
    expect(creditRow).toMatchObject({ type: "INCOME", amountPaise: 12000000 });
  });

  it("uses an explicit type column when present", () => {
    const mapping = { ...emptyMapping(), date: "Date", amount: "Amount", type: "Type", merchant: "M" };
    const row = normalizeRow({ Date: "2026-07-10", Amount: "420", Type: "Debit", M: "Swiggy" }, 0, mapping);
    expect(row.type).toBe("EXPENSE");
  });

  it("carries category/account/notes through as raw strings for later resolution", () => {
    const mapping = { ...emptyMapping(), date: "Date", amount: "Amount", merchant: "M", category: "Cat", account: "Acc", notes: "N" };
    const row = normalizeRow({ Date: "2026-07-10", Amount: "-420", M: "Swiggy", Cat: "Eating Out", Acc: "HDFC", N: "lunch" }, 0, mapping);
    expect(row.categoryRaw).toBe("Eating Out");
    expect(row.accountRaw).toBe("HDFC");
    expect(row.notes).toBe("lunch");
  });

  it("leaves type/amount null when nothing is parseable", () => {
    const mapping = { ...emptyMapping(), date: "Date", amount: "Amount", merchant: "M" };
    const row = normalizeRow({ Date: "garbage", Amount: "garbage", M: "Swiggy" }, 0, mapping);
    expect(row.ymd).toBeNull();
    expect(row.amountPaise).toBeNull();
    expect(row.type).toBeNull();
  });
});
