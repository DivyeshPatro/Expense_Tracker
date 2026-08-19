import { describe, expect, it } from "vitest";
import { allocateFifo, computeLoanStatus, validateManualAllocation, type OpenLoan } from "./loan-settlement";

// createdAt defaults to the id, so existing cases keep a stable, explicit
// tiebreak without having to state one; same-day cases pass it deliberately.
const loan = (id: string, amount: number, occurredAt: string, settledAmount = 0, createdAt = id): OpenLoan => ({ id, amount, settledAmount, occurredAt, createdAt });

describe("allocateFifo", () => {
  it("allocates the full repayment to a single open loan when it covers it exactly", () => {
    const result = allocateFifo(50000, [loan("l1", 50000, "2026-06-01")]);
    expect(result).toEqual([{ gaveEntryId: "l1", amount: 50000 }]);
  });

  it("applies oldest-first across multiple loans, spilling into the next once one is covered", () => {
    const result = allocateFifo(70000, [loan("l2", 40000, "2026-06-15"), loan("l1", 50000, "2026-06-01")]);
    expect(result).toEqual([
      { gaveEntryId: "l1", amount: 50000 },
      { gaveEntryId: "l2", amount: 20000 },
    ]);
  });

  it("leaves a later loan untouched when the repayment doesn't reach it", () => {
    const result = allocateFifo(30000, [loan("l1", 50000, "2026-06-01"), loan("l2", 40000, "2026-06-15")]);
    expect(result).toEqual([{ gaveEntryId: "l1", amount: 30000 }]);
  });

  it("skips already-partially-settled loans' covered portion, applying only to the remaining balance", () => {
    const result = allocateFifo(30000, [loan("l1", 50000, "2026-06-01", 20000)]);
    expect(result).toEqual([{ gaveEntryId: "l1", amount: 30000 }]);
  });

  it("an overpayment beyond total outstanding leaves the excess unallocated", () => {
    const result = allocateFifo(100000, [loan("l1", 50000, "2026-06-01")]);
    expect(result).toEqual([{ gaveEntryId: "l1", amount: 50000 }]);
    const total = result.reduce((s, a) => s + a.amount, 0);
    expect(total).toBeLessThan(100000);
  });

  it("fully-settled loans (remaining zero) are skipped entirely", () => {
    const result = allocateFifo(10000, [loan("l1", 50000, "2026-06-01", 50000), loan("l2", 30000, "2026-06-10")]);
    expect(result).toEqual([{ gaveEntryId: "l2", amount: 10000 }]);
  });

  it("no open loans at all produces no allocations", () => {
    expect(allocateFifo(10000, [])).toEqual([]);
  });

  it("a zero-amount repayment produces no allocations", () => {
    expect(allocateFifo(0, [loan("l1", 50000, "2026-06-01")])).toEqual([]);
  });
});

describe("validateManualAllocation", () => {
  const openLoansById = new Map([
    ["l1", { amount: 50000, settledAmount: 0 }],
    ["l2", { amount: 30000, settledAmount: 10000 }],
  ]);

  it("accepts a valid single-loan allocation within its remaining balance", () => {
    expect(validateManualAllocation(20000, [{ gaveEntryId: "l1", amount: 20000 }], openLoansById)).toBeNull();
  });

  it("accepts a valid multi-loan split that sums to less than the repayment", () => {
    expect(
      validateManualAllocation(30000, [{ gaveEntryId: "l1", amount: 10000 }, { gaveEntryId: "l2", amount: 10000 }], openLoansById)
    ).toBeNull();
  });

  it("rejects an empty allocation list", () => {
    expect(validateManualAllocation(10000, [], openLoansById)).not.toBeNull();
  });

  it("rejects a non-positive amount", () => {
    expect(validateManualAllocation(10000, [{ gaveEntryId: "l1", amount: 0 }], openLoansById)).not.toBeNull();
    expect(validateManualAllocation(10000, [{ gaveEntryId: "l1", amount: -500 }], openLoansById)).not.toBeNull();
  });

  it("rejects an allocation against an unknown loan id", () => {
    expect(validateManualAllocation(10000, [{ gaveEntryId: "nope", amount: 5000 }], openLoansById)).not.toBeNull();
  });

  it("rejects an allocation exceeding that loan's own remaining balance", () => {
    // l2 has amount 30000, settled 10000 ⇒ remaining 20000
    expect(validateManualAllocation(50000, [{ gaveEntryId: "l2", amount: 25000 }], openLoansById)).not.toBeNull();
  });

  it("rejects a total allocation exceeding the repayment amount", () => {
    expect(
      validateManualAllocation(15000, [{ gaveEntryId: "l1", amount: 10000 }, { gaveEntryId: "l2", amount: 10000 }], openLoansById)
    ).not.toBeNull();
  });

  it("accepts an allocation using the loan's exact full remaining balance", () => {
    expect(validateManualAllocation(50000, [{ gaveEntryId: "l1", amount: 50000 }], openLoansById)).toBeNull();
  });
});

describe("computeLoanStatus", () => {
  const now = new Date("2026-07-18T00:00:00Z");

  it("a loan with nothing settled and no due date is Open", () => {
    expect(computeLoanStatus(50000, 0, null, now)).toMatchObject({ status: "OPEN", remainingAmount: 50000 });
  });

  it("a loan with nothing settled and a future due date is still Open", () => {
    expect(computeLoanStatus(50000, 0, new Date("2026-08-01T00:00:00Z"), now)).toMatchObject({ status: "OPEN" });
  });

  it("a loan with some settled and a future due date is Partial", () => {
    expect(computeLoanStatus(50000, 20000, new Date("2026-08-01T00:00:00Z"), now)).toMatchObject({
      status: "PARTIAL",
      remainingAmount: 30000,
    });
  });

  it("a fully-settled loan is Settled regardless of due date", () => {
    expect(computeLoanStatus(50000, 50000, new Date("2026-08-01T00:00:00Z"), now)).toMatchObject({ status: "SETTLED", remainingAmount: 0 });
  });

  it("a fully-settled loan past its due date is still Settled, never Overdue", () => {
    expect(computeLoanStatus(50000, 50000, new Date("2026-06-01T00:00:00Z"), now)).toMatchObject({ status: "SETTLED" });
  });

  it("an unsettled loan past its due date is Overdue", () => {
    expect(computeLoanStatus(50000, 0, new Date("2026-06-01T00:00:00Z"), now)).toMatchObject({ status: "OVERDUE" });
  });

  it("a partially-settled loan past its due date is Overdue, not Partial — the remainder is what's late", () => {
    expect(computeLoanStatus(50000, 30000, new Date("2026-06-01T00:00:00Z"), now)).toMatchObject({
      status: "OVERDUE",
      remainingAmount: 20000,
    });
  });

  it("a loan due exactly today (not yet past) is not Overdue", () => {
    expect(computeLoanStatus(50000, 0, new Date("2026-07-18T00:00:00Z"), now)).not.toMatchObject({ status: "OVERDUE" });
  });

  it("settledAmount is clamped so remainingAmount never goes negative", () => {
    expect(computeLoanStatus(50000, 60000, null, now).remainingAmount).toBe(0);
  });
});
