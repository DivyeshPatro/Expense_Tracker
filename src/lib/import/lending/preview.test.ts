import { describe, expect, it } from "vitest";
import { assembleLendingPreview, dedupeKey, type ExistingContact } from "./preview";
import type { LendingImportRow } from "./types";

let idc = 0;
function r(over: Partial<LendingImportRow>): LendingImportRow {
  idc++;
  const contact = over.contact ?? "Ramesh";
  return {
    rowIndex: over.rowIndex ?? idc,
    contact,
    contactKey: over.contactKey ?? contact.toLowerCase(),
    ymd: over.ymd ?? "2026-07-10",
    kind: over.kind ?? "GAVE",
    amountPaise: over.amountPaise ?? 100000,
    note: over.note ?? null,
    status: over.status ?? "valid",
    reason: over.reason ?? null,
  };
}
const NO_EXISTING: ExistingContact[] = [];
const NO_KEYS = new Set<string>();

describe("assembleLendingPreview", () => {
  it("groups rows into contacts, computes running balance and net", () => {
    const p = assembleLendingPreview(
      [
        r({ contact: "Ramesh", ymd: "2026-07-10", kind: "GAVE", amountPaise: 150000 }),
        r({ contact: "Ramesh", ymd: "2026-07-12", kind: "GOT", amountPaise: 50000 }),
        r({ contact: "Suresh", ymd: "2026-07-11", kind: "GAVE", amountPaise: 30000 }),
      ],
      NO_EXISTING,
      NO_KEYS
    );
    expect(p.contactsToCreate).toBe(2);
    expect(p.totals).toEqual({ gavePaise: 180000, gotPaise: 50000, netPaise: 130000 });
    const ramesh = p.contacts.find((c) => c.key === "ramesh")!;
    expect(ramesh.outstandingPaise).toBe(100000);
    expect(ramesh.entries.map((e) => e.runningBalancePaise)).toEqual([150000, 100000]); // GAVE then GOT
    expect(p.dateRange).toEqual({ min: "2026-07-10", max: "2026-07-12" });
  });

  it("orders each contact's entries chronologically regardless of file order", () => {
    const p = assembleLendingPreview(
      [
        r({ contact: "A", ymd: "2026-07-20", kind: "GOT", amountPaise: 40000, rowIndex: 1 }),
        r({ contact: "A", ymd: "2026-07-05", kind: "GAVE", amountPaise: 100000, rowIndex: 2 }),
      ],
      NO_EXISTING,
      NO_KEYS
    );
    const a = p.contacts[0];
    expect(a.entries.map((e) => e.ymd)).toEqual(["2026-07-05", "2026-07-20"]);
    expect(a.entries.map((e) => e.runningBalancePaise)).toEqual([100000, 60000]);
  });

  it("flags within-file duplicates and skips them by default", () => {
    const dup = { contact: "X", ymd: "2026-07-10", kind: "GAVE" as const, amountPaise: 100000 };
    const p = assembleLendingPreview([r({ ...dup }), r({ ...dup })], NO_EXISTING, NO_KEYS);
    expect(p.counts.duplicateRows).toBe(1);
    expect(p.counts.skippedRows).toBe(1);
    // only one entry imports → outstanding reflects a single GAVE
    expect(p.contacts[0].outstandingPaise).toBe(100000);
  });

  it("treats a row already in the ledger as a duplicate", () => {
    const existingKey = dedupeKey("ramesh", "2026-07-10", "GAVE", 100000);
    const p = assembleLendingPreview(
      [r({ contact: "Ramesh", ymd: "2026-07-10", kind: "GAVE", amountPaise: 100000 })],
      [{ id: "p1", key: "ramesh", displayName: "Ramesh", netPaise: 100000 }],
      new Set([existingKey]),
      { decisions: { ramesh: "merge" } }
    );
    expect(p.counts.duplicateRows).toBe(1);
    expect(p.counts.skippedRows).toBe(1);
  });

  it("merges into an existing contact, continuing its running balance from the existing net", () => {
    const existing: ExistingContact[] = [{ id: "p1", key: "ramesh", displayName: "Ramesh", netPaise: 200000 }];
    const p = assembleLendingPreview(
      [r({ contact: "ramesh", ymd: "2026-07-15", kind: "GOT", amountPaise: 50000 })],
      existing,
      NO_KEYS,
      { decisions: { ramesh: "merge" } }
    );
    const c = p.contacts[0];
    expect(c.resolution).toBe("merge");
    expect(c.existingId).toBe("p1");
    expect(c.entries[0].runningBalancePaise).toBe(150000); // 200000 existing − 50000
    expect(c.outstandingPaise).toBe(150000);
    expect(p.contactsToMerge).toBe(1);
    expect(p.contactsToCreate).toBe(0);
  });

  it("honours a skip decision — nothing from that contact imports", () => {
    const existing: ExistingContact[] = [{ id: "p1", key: "ramesh", displayName: "Ramesh", netPaise: 0 }];
    const p = assembleLendingPreview(
      [r({ contact: "ramesh", kind: "GAVE", amountPaise: 100000 })],
      existing,
      NO_KEYS,
      { decisions: { ramesh: "skip" } }
    );
    expect(p.contactsToSkip).toBe(1);
    expect(p.counts.skippedRows).toBe(1);
    expect(p.totals.netPaise).toBe(0);
  });

  it("separates invalid rows from the valid flow", () => {
    const p = assembleLendingPreview(
      [r({ kind: "GAVE", amountPaise: 100000 }), r({ status: "invalid", reason: "Missing contact", rowIndex: 9 })],
      NO_EXISTING,
      NO_KEYS
    );
    expect(p.counts.invalidRows).toBe(1);
    expect(p.invalid[0]).toEqual({ rowIndex: 9, reason: "Missing contact" });
    expect(p.counts.validRows).toBe(1);
  });

  it("ranks the top contacts by absolute outstanding", () => {
    const rows: LendingImportRow[] = [];
    for (let i = 0; i < 12; i++) rows.push(r({ contact: `C${i}`, contactKey: `c${i}`, kind: "GAVE", amountPaise: (i + 1) * 1000 }));
    const p = assembleLendingPreview(rows, NO_EXISTING, NO_KEYS);
    expect(p.top).toHaveLength(10);
    expect(p.top[0].key).toBe("c11"); // largest
    expect(p.top[0].outstandingPaise).toBe(12000);
  });

  it("allows an over-repayment to drive the balance negative (net creditor)", () => {
    const p = assembleLendingPreview(
      [
        r({ contact: "Z", ymd: "2026-07-01", kind: "GAVE", amountPaise: 30000 }),
        r({ contact: "Z", ymd: "2026-07-02", kind: "GOT", amountPaise: 50000 }),
      ],
      NO_EXISTING,
      NO_KEYS
    );
    expect(p.contacts[0].outstandingPaise).toBe(-20000);
  });
});
