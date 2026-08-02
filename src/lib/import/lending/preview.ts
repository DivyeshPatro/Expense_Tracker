// The lending import plan — assembled once, read by both the preview UI and the
// commit (same shared-plan discipline as the backup-restore engine, so the two
// can never disagree about what will be imported).
//
// Pure: it takes the mapped rows plus a snapshot of the existing ledger
// (contacts and their entry keys, fetched by the service) and returns the plan.
// No database, no allocation persistence — the FIFO allocation against open
// loans happens at commit time in the service, using this plan's ordered
// entries and the existing `allocateFifo` engine.

import type { LendingImportRow, LendingKind } from "./types";

export type MergeDecision = "merge" | "create" | "skip";

/** A contact that already exists in the user's ledger, matched by normalized key. */
export interface ExistingContact {
  id: string;
  key: string;
  displayName: string;
  /** Current net (Σ GAVE − Σ GOT) in paise, so a merge's running balance continues from here. */
  netPaise: number;
}

export interface LendingImportOptions {
  /** Per-contactKey choice when the key matches an existing contact. Default: merge. */
  decisions?: Record<string, MergeDecision>;
  /** Skip rows that duplicate another (within the file or already in the ledger). Default: true. */
  skipDuplicates?: boolean;
}

export interface PlannedEntry {
  rowIndex: number;
  ymd: string;
  kind: LendingKind;
  amountPaise: number;
  note: string | null;
  /** Contact's cumulative net after this entry (skipped duplicates don't advance it). */
  runningBalancePaise: number;
  duplicate: boolean;
  /** True when this row will actually be written (valid, and not a skipped duplicate). */
  willImport: boolean;
}

export interface PlannedContact {
  key: string;
  displayName: string;
  resolution: MergeDecision;
  existingId: string | null;
  /** Chronologically ordered valid rows for this contact (duplicates flagged). */
  entries: PlannedEntry[];
  totalGavePaise: number;
  totalGotPaise: number;
  /** Net that will exist after import: existing net (if merging) + imported net. */
  outstandingPaise: number;
}

export interface LendingImportCounts {
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  invalidRows: number;
  skippedRows: number;
}

export interface LendingImportPreview {
  contacts: PlannedContact[];
  /** Up to ten contacts, largest absolute outstanding first. */
  top: PlannedContact[];
  invalid: { rowIndex: number; reason: string }[];
  counts: LendingImportCounts;
  contactsToCreate: number;
  contactsExisting: number;
  contactsToMerge: number;
  contactsToSkip: number;
  totals: { gavePaise: number; gotPaise: number; netPaise: number };
  dateRange: { min: string; max: string } | null;
}

/** Stable dedupe key: contact + date + amount + kind (the documented rule). */
export function dedupeKey(contactKey: string, ymd: string, kind: LendingKind, amountPaise: number): string {
  return `${contactKey}|${ymd}|${kind}|${amountPaise}`;
}

export function assembleLendingPreview(
  rows: LendingImportRow[],
  existing: ExistingContact[],
  /** dedupeKey() of every live LoanEntry already in the ledger, so re-importing the same file is caught. */
  existingEntryKeys: Set<string>,
  options: LendingImportOptions = {}
): LendingImportPreview {
  const skipDuplicates = options.skipDuplicates ?? true;
  const decisions = options.decisions ?? {};
  const existingByKey = new Map(existing.map((c) => [c.key, c]));

  const invalid = rows.filter((r) => r.status === "invalid").map((r) => ({ rowIndex: r.rowIndex, reason: r.reason ?? "Invalid row" }));
  const valid = rows.filter((r) => r.status === "valid" && r.contactKey && r.ymd && r.kind && r.amountPaise != null);

  // Group valid rows by contact key, preserving first-seen display name.
  const groups = new Map<string, { displayName: string; rows: LendingImportRow[] }>();
  for (const r of valid) {
    const g = groups.get(r.contactKey!);
    if (g) g.rows.push(r);
    else groups.set(r.contactKey!, { displayName: r.contact!, rows: [r] });
  }

  // Duplicate detection: seeded with the existing ledger's keys, then extended
  // as we walk the file, so both a re-import and a within-file repeat are caught.
  const seen = new Set<string>(existingEntryKeys);

  let duplicateRows = 0;
  let skippedRows = 0;
  const contacts: PlannedContact[] = [];

  for (const [key, group] of groups) {
    const existingContact = existingByKey.get(key) ?? null;
    const decision: MergeDecision = existingContact ? (decisions[key] ?? "merge") : "create";

    // Chronological order — the order entries would have been added by hand,
    // which is also the order FIFO settlement depends on.
    const ordered = [...group.rows].sort((a, b) => (a.ymd! < b.ymd! ? -1 : a.ymd! > b.ymd! ? 1 : a.rowIndex - b.rowIndex));

    let running = decision === "merge" && existingContact ? existingContact.netPaise : 0;
    let totalGave = 0;
    let totalGot = 0;
    const entries: PlannedEntry[] = [];

    for (const r of ordered) {
      const k = dedupeKey(key, r.ymd!, r.kind!, r.amountPaise!);
      const isDup = seen.has(k);
      if (!isDup) seen.add(k);
      if (isDup) duplicateRows++;

      const willImport = decision !== "skip" && !(isDup && skipDuplicates);
      if (!willImport) skippedRows++;

      if (willImport) {
        if (r.kind === "GAVE") {
          running += r.amountPaise!;
          totalGave += r.amountPaise!;
        } else {
          running -= r.amountPaise!;
          totalGot += r.amountPaise!;
        }
      }

      entries.push({
        rowIndex: r.rowIndex,
        ymd: r.ymd!,
        kind: r.kind!,
        amountPaise: r.amountPaise!,
        note: r.note,
        runningBalancePaise: running,
        duplicate: isDup,
        willImport,
      });
    }

    const base = decision === "merge" && existingContact ? existingContact.netPaise : 0;
    contacts.push({
      key,
      displayName: existingContact?.displayName ?? group.displayName,
      resolution: decision,
      existingId: existingContact?.id ?? null,
      entries,
      totalGavePaise: totalGave,
      totalGotPaise: totalGot,
      outstandingPaise: base + totalGave - totalGot,
    });
  }

  const importedEntries = contacts.flatMap((c) => c.entries.filter((e) => e.willImport));
  const gavePaise = contacts.reduce((s, c) => s + c.totalGavePaise, 0);
  const gotPaise = contacts.reduce((s, c) => s + c.totalGotPaise, 0);

  const dates = importedEntries.map((e) => e.ymd).sort();
  const dateRange = dates.length ? { min: dates[0], max: dates[dates.length - 1] } : null;

  const top = [...contacts]
    .filter((c) => c.resolution !== "skip")
    .sort((a, b) => Math.abs(b.outstandingPaise) - Math.abs(a.outstandingPaise))
    .slice(0, 10);

  return {
    contacts,
    top,
    invalid,
    counts: {
      totalRows: rows.length,
      validRows: valid.length,
      duplicateRows,
      invalidRows: invalid.length,
      skippedRows,
    },
    contactsToCreate: contacts.filter((c) => c.resolution === "create").length,
    contactsExisting: contacts.filter((c) => c.existingId).length,
    contactsToMerge: contacts.filter((c) => c.resolution === "merge").length,
    contactsToSkip: contacts.filter((c) => c.resolution === "skip").length,
    totals: { gavePaise, gotPaise, netPaise: gavePaise - gotPaise },
    dateRange,
  };
}
