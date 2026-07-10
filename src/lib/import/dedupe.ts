// Duplicate detection: hash of date + amount + normalized merchant, matched
// within ±1 day (Architecture doc §5 / PRD §6). Pure — takes an in-memory
// index of existing transactions so it stays unit-testable without a DB.

export interface ExistingTx {
  ymd: string;
  amountPaise: number;
  merchant: string;
}

export function normalizeMerchant(m: string): string {
  return m.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function dayIndex(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

export class DuplicateIndex {
  private byKey = new Map<string, ExistingTx[]>();

  constructor(existing: ExistingTx[]) {
    for (const tx of existing) {
      const key = this.keyOf(tx.merchant, tx.amountPaise);
      const list = this.byKey.get(key) ?? [];
      list.push(tx);
      this.byKey.set(key, list);
    }
  }

  private keyOf(merchant: string, amountPaise: number): string {
    return `${normalizeMerchant(merchant)}|${amountPaise}`;
  }

  isDuplicate(candidate: { merchant: string; amountPaise: number; ymd: string }): boolean {
    const list = this.byKey.get(this.keyOf(candidate.merchant, candidate.amountPaise));
    if (!list) return false;
    const day = dayIndex(candidate.ymd);
    return list.some((tx) => Math.abs(dayIndex(tx.ymd) - day) <= 1);
  }

  /** Register a row as seen, so duplicates *within the same import batch* are also caught. */
  add(candidate: { merchant: string; amountPaise: number; ymd: string }): void {
    const key = this.keyOf(candidate.merchant, candidate.amountPaise);
    const list = this.byKey.get(key) ?? [];
    list.push({ merchant: candidate.merchant, amountPaise: candidate.amountPaise, ymd: candidate.ymd });
    this.byKey.set(key, list);
  }
}
