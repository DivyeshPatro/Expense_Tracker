// Canonical types for the lending import engine.
//
// The engine is source-agnostic: it only ever sees `LendingImportRow[]`, the
// normalized shape below. Everything Khatabook-specific lives in an *adapter*
// (header aliases + detection), so a future OkCredit / Vyapar / Google-Sheets
// importer is a new adapter and nothing in the core changes. This mirrors the
// generic transaction importer's own adapter note in `../types.ts`.

export type LendingKind = "GAVE" | "GOT";

export type LendingRowStatus = "valid" | "duplicate" | "invalid";

/**
 * The canonical fields an adapter's columns resolve to. `gave`/`got` are the
 * two-column Khatabook shape ("You Gave" / "You Got"); `amount`+`type` is the
 * single-signed-column alternative some ledgers export. An adapter provides
 * whichever pair its source uses; the mapper reads exactly one of them.
 */
export interface ResolvedColumns {
  contact: string;
  date: string;
  gave?: string;
  got?: string;
  amount?: string;
  type?: string;
  note?: string;
  /** Optional running-balance column — used only as a cross-check, never stored. */
  balance?: string;
}

/** Header synonyms per canonical field. Matched by `norm()` (lowercased, alphanumeric). */
export interface LendingHeaderAliases {
  contact: string[];
  date: string[];
  gave?: string[];
  got?: string[];
  amount?: string[];
  type?: string[];
  note?: string[];
  balance?: string[];
}

/**
 * A mapping profile for one ledger export format. Deliberately tiny: aliases
 * plus an optional detection override. Adding a source = adding one of these to
 * the registry; the engine, dedupe, allocation, commit and undo are untouched.
 */
export interface LendingSourceAdapter {
  id: string;
  /** Shown in the Import Center when this source is detected. */
  label: string;
  aliases: LendingHeaderAliases;
  /**
   * Confidence in [0,1] that these headers belong to this source. Optional —
   * `detectLendingSource` supplies a generic alias-coverage score when omitted,
   * which is enough for most sources.
   */
  detect?: (headers: string[]) => number;
}

/** One spreadsheet row after mapping + validation — what the whole engine speaks. */
export interface LendingImportRow {
  rowIndex: number;
  /** Display name: original casing, trimmed, internal whitespace collapsed. */
  contact: string | null;
  /** Merge key: lowercased, trimmed, single-spaced. Groups formatting variants. */
  contactKey: string | null;
  ymd: string | null;
  kind: LendingKind | null;
  amountPaise: number | null;
  note: string | null;
  status: LendingRowStatus;
  /** Why a row is invalid or a duplicate — surfaced in the preview. */
  reason: string | null;
}
