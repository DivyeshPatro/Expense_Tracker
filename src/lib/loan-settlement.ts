// Settlement engine (Lending Phase 2) — pure functions over the flat
// GAVE/GOT ledger plus the additive LoanAllocation join table. Kept separate
// from the DB-orchestrating service (src/server/services/lending.ts), same
// split as settlement.ts/shared.ts, so the allocation math and status
// computation are unit-testable without a database.

export interface OpenLoan {
  id: string;
  amount: number; // paise, original GAVE amount
  settledAmount: number; // paise, already allocated against this loan
  occurredAt: string; // "YYYY-MM-DD" — lexicographically sortable, oldest-first for FIFO
}

export interface AllocationResult {
  gaveEntryId: string;
  amount: number; // paise
}

/**
 * Default allocation: oldest outstanding loan first. Caps each allocation at
 * that loan's own remaining balance. Any leftover once every loan is fully
 * covered is simply unallocated (an overpayment/credit) — the aggregate net
 * balance (Σ GAVE − Σ GOT) already reflects the full repayment amount
 * regardless of how much of it ended up allocated to a specific loan.
 */
export function allocateFifo(repaymentAmount: number, openLoans: OpenLoan[]): AllocationResult[] {
  const sorted = [...openLoans]
    .filter((l) => l.amount - l.settledAmount > 0)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const result: AllocationResult[] = [];
  let remaining = repaymentAmount;
  for (const loan of sorted) {
    if (remaining <= 0) break;
    const loanRemaining = loan.amount - loan.settledAmount;
    const applied = Math.min(loanRemaining, remaining);
    if (applied > 0) {
      result.push({ gaveEntryId: loan.id, amount: applied });
      remaining -= applied;
    }
  }
  return result;
}

/**
 * Validates a manual allocation before it's persisted: every targeted loan
 * must exist and have enough remaining balance, amounts must be positive,
 * and the total can't exceed the repayment itself. Returns an error message,
 * or null when the allocation is valid.
 */
export function validateManualAllocation(
  repaymentAmount: number,
  allocations: AllocationResult[],
  openLoansById: Map<string, Pick<OpenLoan, "amount" | "settledAmount">>
): string | null {
  if (allocations.length === 0) return "Pick at least one loan to allocate this repayment against";
  let total = 0;
  for (const a of allocations) {
    if (!Number.isFinite(a.amount) || a.amount <= 0) return "Allocation amounts must be positive";
    const loan = openLoansById.get(a.gaveEntryId);
    if (!loan) return "One of the selected loans was not found";
    const loanRemaining = loan.amount - loan.settledAmount;
    if (a.amount > loanRemaining) return "Allocation exceeds a loan's remaining balance";
    total += a.amount;
  }
  if (total > repaymentAmount) return "Allocations exceed the repayment amount";
  return null;
}

export type LoanStatus = "OPEN" | "PARTIAL" | "SETTLED" | "OVERDUE";

export interface LoanStatusResult {
  originalAmount: number;
  settledAmount: number;
  remainingAmount: number;
  status: LoanStatus;
}

/**
 * Per-loan status, always derived — never stored. Priority order (most
 * specific wins): a fully-settled loan is never "overdue" even past its due
 * date; an unsettled loan past its due date is "overdue" even if partially
 * paid (the outstanding remainder is what's actually late, not the sliver
 * already recovered).
 */
export function computeLoanStatus(
  originalAmount: number,
  settledAmount: number,
  dueDate: Date | null,
  now: Date = new Date()
): LoanStatusResult {
  const remainingAmount = Math.max(0, originalAmount - settledAmount);
  let status: LoanStatus;
  if (remainingAmount <= 0) status = "SETTLED";
  else if (dueDate && dueDate < now) status = "OVERDUE";
  else if (settledAmount > 0) status = "PARTIAL";
  else status = "OPEN";
  return { originalAmount, settledAmount, remainingAmount, status };
}
