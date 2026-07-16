// Activity Timeline event registry + presenter (RFC: activity-timeline-spec.md,
// Phase 1). Pure functions over audit-row snapshots: no database access, no
// joins — labels come from the payloads themselves plus small lookup maps the
// caller provides once per page. The registry is the extension contract:
// adding an event kind means adding an entry here and nothing else.

import { MONTH_NAMES } from "./dates";
import { formatPaise } from "./money";

// ─────────── public model (RFC §2, Phase-1 fields only) ───────────

export interface DiffRow {
  field: string;
  fieldLabel: string;
  formattedBefore: string;
  formattedAfter: string;
  /** signed paise, only for amount-like fields */
  delta?: number;
}

export interface EffectRow {
  accountId: string;
  accountLabel: string;
  deltaPaise: number;
}

export interface TimelineEvent {
  activityId: string; // "ACT_<auditRowId>" — derived, stable, never stored
  ts: string; // ISO-8601, audit row `at`
  verb: string;
  entityType: "transaction" | "transfer" | "account" | "category" | "budget" | "bill" | "import" | "settlement";
  entityId: string;
  entityLabel: string; // from snapshot — deleted entities keep their historical name
  icon: string;
  summary: string; // verb-first title, e.g. "Edited expense"
  detail?: string; // optional second line under the label
  diff: DiffRow[];
  effects: EffectRow[];
}

/** The audit-row shape the presenter consumes (payloads already JSON-parsed). */
export interface AuditRowInput {
  id: string;
  action: string;
  entity: string;
  entityId: string;
  before: unknown;
  after: unknown;
  at: string; // ISO
}

/** Lookup maps built once per page by the caller — id → display label. */
export interface LabelMaps {
  categories: Map<string, { name: string; icon: string }>;
  accounts: Map<string, string>;
  participants: Map<string, string>;
}

// ─────────── allowlist + chip filters (pushed into SQL by the service) ───────────

export const ACTIVITY_ALLOWLIST: { entity: string; actions: string[] }[] = [
  { entity: "Transaction", actions: ["create", "update", "soft-delete", "restore"] },
  { entity: "Settlement", actions: ["create"] },
  { entity: "Category", actions: ["create", "rename", "kind-change", "delete"] },
  { entity: "Account", actions: ["create"] },
  { entity: "Budget", actions: ["create", "update"] },
  { entity: "Bill", actions: ["create", "bill-paid"] },
  { entity: "ImportBatch", actions: ["import", "undo-import"] },
];

export const ACTIVITY_CHIPS = ["all", "money", "accounts", "budgets", "shared", "imports"] as const;
export type ActivityChip = (typeof ACTIVITY_CHIPS)[number];

export const CHIP_LABELS: Record<ActivityChip, string> = {
  all: "All",
  money: "Money",
  accounts: "Accounts",
  budgets: "Budgets & Bills",
  shared: "Shared",
  imports: "Imports",
};

export const CHIP_ENTITIES: Record<Exclude<ActivityChip, "all">, string[]> = {
  money: ["Transaction"],
  accounts: ["Account"],
  budgets: ["Budget", "Bill"],
  shared: ["Settlement"],
  imports: ["ImportBatch"],
};

// ─────────── snapshot field helpers (defensive: missing fields → omitted output) ───────────

type Snap = Record<string, unknown>;

const asSnap = (v: unknown): Snap => (v && typeof v === "object" ? (v as Snap) : {});
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length ? v : undefined);

/** app-wide convention: magnitude via formatPaise, sign as U+2212 for negatives */
const signedPaise = (v: number) => `${v < 0 ? "−" : "+"}${formatPaise(Math.abs(v))}`;

const isoToDateLabel = (iso: string | undefined): string | undefined => {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
};

const truncate = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const categoryLabel = (id: unknown, maps: LabelMaps): string => {
  const key = str(id);
  if (!key) return "Uncategorized";
  const c = maps.categories.get(key);
  return c ? `${c.icon} ${c.name}` : "(deleted category)";
};

const accountLabel = (id: unknown, maps: LabelMaps): string => {
  const key = str(id);
  if (!key) return "—";
  return maps.accounts.get(key) ?? "(deleted account)";
};

const participantLabel = (id: unknown, maps: LabelMaps): string => {
  const key = str(id);
  if (!key) return "You";
  return maps.participants.get(key) ?? "(removed friend)";
};

// ─────────── transaction balance effects (RFC §8: bounded paise addition only) ───────────

function txDeltas(p: Snap): Map<string, number> {
  const out = new Map<string, number>();
  const amount = num(p.amount) ?? 0;
  const type = str(p.type);
  const acc = str(p.accountId);
  const to = str(p.toAccountId);
  const add = (id: string | undefined, d: number) => {
    if (!id || d === 0) return;
    out.set(id, (out.get(id) ?? 0) + d);
  };
  if (type === "EXPENSE") add(acc, -amount);
  else if (type === "INCOME") add(acc, amount);
  else if (type === "TRANSFER") {
    add(acc, -amount);
    add(to, amount);
  }
  return out;
}

function mergeDeltas(reverse: Snap | null, apply: Snap | null, maps: LabelMaps): EffectRow[] {
  const total = new Map<string, number>();
  if (reverse) for (const [id, d] of txDeltas(reverse)) total.set(id, (total.get(id) ?? 0) - d);
  if (apply) for (const [id, d] of txDeltas(apply)) total.set(id, (total.get(id) ?? 0) + d);
  const rows: EffectRow[] = [];
  for (const [accountId, deltaPaise] of total) {
    if (deltaPaise === 0) continue;
    rows.push({ accountId, accountLabel: accountLabel(accountId, maps), deltaPaise });
  }
  return rows;
}

// ─────────── diff manifests ───────────

interface FieldSpec {
  field: string;
  fieldLabel: string;
  format: (v: unknown, maps: LabelMaps) => string | undefined;
  amount?: boolean;
}

const TX_FIELDS: FieldSpec[] = [
  { field: "amount", fieldLabel: "Amount", format: (v) => (num(v) === undefined ? undefined : formatPaise(num(v)!)), amount: true },
  { field: "merchant", fieldLabel: "Merchant", format: (v) => str(v) },
  { field: "categoryId", fieldLabel: "Category", format: (v, m) => categoryLabel(v, m) },
  { field: "accountId", fieldLabel: "Account", format: (v, m) => accountLabel(v, m) },
  { field: "toAccountId", fieldLabel: "To account", format: (v, m) => accountLabel(v, m) },
  { field: "occurredAt", fieldLabel: "Date", format: (v) => isoToDateLabel(str(v)) },
  { field: "notes", fieldLabel: "Note", format: (v) => (str(v) ? `“${truncate(str(v)!)}”` : "—") },
  { field: "paidByParticipantId", fieldLabel: "Paid by", format: (v, m) => participantLabel(v, m) },
];

function diffFields(specs: FieldSpec[], before: Snap, after: Snap, maps: LabelMaps): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const s of specs) {
    const b = before[s.field];
    const a = after[s.field];
    // normalize null/undefined so "null → undefined" never counts as a change
    if ((b ?? null) === (a ?? null)) continue;
    const fb = s.format(b, maps);
    const fa = s.format(a, maps);
    if (fb === undefined && fa === undefined) continue;
    const row: DiffRow = { field: s.field, fieldLabel: s.fieldLabel, formattedBefore: fb ?? "—", formattedAfter: fa ?? "—" };
    if (s.amount) {
      const nb = num(b);
      const na = num(a);
      if (nb !== undefined && na !== undefined) row.delta = na - nb;
    }
    if (row.formattedBefore === row.formattedAfter) continue; // e.g. both ids resolve to same label after formatting
    rows.push(row);
  }
  return rows;
}

// ─────────── per-kind presenters (the registry) ───────────

type Present = (row: AuditRowInput, maps: LabelMaps) => TimelineEvent | null;

const txWord = (p: Snap): { word: string; entityType: TimelineEvent["entityType"] } => {
  const t = str(p.type);
  if (t === "INCOME") return { word: "income", entityType: "transaction" };
  if (t === "TRANSFER") return { word: "transfer", entityType: "transfer" };
  return { word: "expense", entityType: "transaction" };
};

const txDetail = (p: Snap, maps: LabelMaps): string => {
  const parts: string[] = [];
  const amount = num(p.amount);
  if (amount !== undefined) parts.push(formatPaise(amount));
  if (str(p.type) !== "TRANSFER" && str(p.categoryId)) parts.push(categoryLabel(p.categoryId, maps));
  const splits = Array.isArray(p.splits) ? p.splits.length : 0;
  if (splits > 0) parts.push(`split · ${splits} friend${splits === 1 ? "" : "s"}`);
  return parts.join(" · ");
};

const base = (row: AuditRowInput): Pick<TimelineEvent, "activityId" | "ts" | "entityId"> => ({
  activityId: `ACT_${row.id}`,
  ts: row.at,
  entityId: row.entityId,
});

const REGISTRY: Record<string, Present> = {
  "Transaction:create": (row, maps) => {
    const p = asSnap(row.after);
    const { word, entityType } = txWord(p);
    return {
      ...base(row),
      verb: "created",
      entityType,
      entityLabel: str(p.merchant) ?? "(untitled)",
      icon: word === "transfer" ? "⇄" : "➕",
      summary: word === "transfer" ? "Transferred money" : `Added ${word}`,
      detail: txDetail(p, maps),
      diff: [],
      effects: mergeDeltas(null, p, maps),
    };
  },
  "Transaction:update": (row, maps) => {
    const before = asSnap(row.before);
    const after = asSnap(row.after);
    const { word, entityType } = txWord(after);
    const diff = diffFields(TX_FIELDS, before, after, maps);
    if (diff.length === 0) return null; // no-op edits produce no event (RFC §7)
    return {
      ...base(row),
      verb: "edited",
      entityType,
      entityLabel: str(after.merchant) ?? "(untitled)",
      icon: "✏️",
      summary: `Edited ${word}`,
      diff,
      effects: mergeDeltas(before, after, maps),
    };
  },
  "Transaction:soft-delete": (row, maps) => {
    const p = asSnap(row.before);
    const { word, entityType } = txWord(p);
    return {
      ...base(row),
      verb: "deleted",
      entityType,
      entityLabel: str(p.merchant) ?? "(untitled)",
      icon: "🗑",
      summary: `Deleted ${word}`,
      detail: txDetail(p, maps),
      diff: [],
      effects: mergeDeltas(p, null, maps),
    };
  },
  "Transaction:restore": (row, maps) => {
    const p = asSnap(row.after);
    const { word, entityType } = txWord(p);
    return {
      ...base(row),
      verb: "restored",
      entityType,
      entityLabel: str(p.merchant) ?? "(untitled)",
      icon: "↩️",
      summary: `Restored ${word}`,
      detail: txDetail(p, maps),
      diff: [],
      effects: mergeDeltas(null, p, maps),
    };
  },
  "Settlement:create": (row, maps) => {
    const p = asSnap(row.after);
    const name = participantLabel(p.participantId, maps);
    const amount = num(p.amount);
    const toOwner = str(p.direction) === "TO_OWNER";
    return {
      ...base(row),
      verb: "settled",
      entityType: "settlement",
      entityLabel: toOwner ? `${name} paid you` : `You paid ${name}`,
      icon: "🤝",
      summary: "Settled up",
      detail: amount === undefined ? undefined : formatPaise(amount),
      diff: [],
      effects: [], // settlements adjust friend balances, not account balances
    };
  },
  "Category:create": (row) => {
    const p = asSnap(row.after);
    return {
      ...base(row),
      verb: "created",
      entityType: "category",
      entityLabel: str(p.name) ?? "(unnamed)",
      icon: "🏷",
      summary: "Added category",
      detail: str(p.kind) === "INCOME" ? "Income" : "Expense",
      diff: [],
      effects: [],
    };
  },
  "Category:rename": (row, maps) => {
    const before = asSnap(row.before);
    const after = asSnap(row.after);
    const diff = diffFields([{ field: "name", fieldLabel: "Name", format: (v) => str(v) }], before, after, maps);
    if (diff.length === 0) return null;
    return {
      ...base(row),
      verb: "renamed",
      entityType: "category",
      entityLabel: str(after.name) ?? "(unnamed)",
      icon: "✏️",
      summary: "Renamed category",
      diff,
      effects: [],
    };
  },
  "Category:kind-change": (row, maps) => {
    const before = asSnap(row.before);
    const after = asSnap(row.after);
    const kindWord = (v: unknown) => (str(v) === "INCOME" ? "Income" : "Expense");
    const diff = diffFields([{ field: "kind", fieldLabel: "Type", format: kindWord }], before, after, maps);
    if (diff.length === 0) return null;
    return {
      ...base(row),
      verb: "edited",
      entityType: "category",
      entityLabel: str(after.name) ?? "(unnamed)",
      icon: "✏️",
      summary: "Changed category type",
      diff,
      effects: [],
    };
  },
  "Category:delete": (row) => {
    const p = asSnap(row.before);
    return {
      ...base(row),
      verb: "deleted",
      entityType: "category",
      entityLabel: str(p.name) ?? "(unnamed)",
      icon: "🗑",
      summary: "Deleted category",
      diff: [],
      effects: [],
    };
  },
  "Account:create": (row) => {
    const p = asSnap(row.after);
    const opening = num(p.openingBalance);
    return {
      ...base(row),
      verb: "created",
      entityType: "account",
      entityLabel: str(p.name) ?? "(unnamed)",
      icon: "🏦",
      summary: "Added account",
      detail: opening ? `opening balance ${opening < 0 ? "−" : ""}${formatPaise(Math.abs(opening))}` : undefined,
      diff: [],
      effects: [],
    };
  },
  "Budget:create": (row, maps) => {
    const p = asSnap(row.after);
    const limit = num(p.limit);
    return {
      ...base(row),
      verb: "created",
      entityType: "budget",
      entityLabel: str(p.categoryId) ? categoryLabel(p.categoryId, maps) : "Overall",
      icon: "◔",
      summary: "Set budget",
      detail: limit === undefined ? undefined : `${formatPaise(limit)} per month`,
      diff: [],
      effects: [],
    };
  },
  "Budget:update": (row, maps) => {
    const before = asSnap(row.before);
    const after = asSnap(row.after);
    const diff = diffFields(
      [{ field: "limit", fieldLabel: "Monthly limit", format: (v) => (num(v) === undefined ? undefined : formatPaise(num(v)!)), amount: true }],
      before,
      after,
      maps
    );
    if (diff.length === 0) return null;
    return {
      ...base(row),
      verb: "edited",
      entityType: "budget",
      entityLabel: str(after.categoryId) ? categoryLabel(after.categoryId, maps) : "Overall",
      icon: "◔",
      summary: "Changed budget",
      diff,
      effects: [],
    };
  },
  "Bill:create": (row) => {
    const p = asSnap(row.after);
    const amount = num(p.amount);
    const cadence = str(p.cadence);
    return {
      ...base(row),
      verb: "created",
      entityType: "bill",
      entityLabel: str(p.name) ?? "(unnamed)",
      icon: "▦",
      summary: "Added bill",
      detail: [amount === undefined ? undefined : formatPaise(amount), cadence ? cadence.charAt(0) + cadence.slice(1).toLowerCase() : "One-off"]
        .filter(Boolean)
        .join(" · "),
      diff: [],
      effects: [],
    };
  },
  "Bill:bill-paid": (row, maps) => {
    const bill = asSnap(row.before);
    const paid = asSnap(row.after);
    const amount = num(paid.amount) ?? num(bill.amount);
    const accountId = str(paid.accountId);
    return {
      ...base(row),
      verb: "paid",
      entityType: "bill",
      entityLabel: str(bill.name) ?? str(paid.name) ?? "(unnamed)",
      icon: "✓",
      summary: "Paid bill",
      detail: amount === undefined ? undefined : formatPaise(amount),
      diff: [],
      effects:
        accountId && amount !== undefined
          ? [{ accountId, accountLabel: str(paid.accountName) ?? accountLabel(accountId, maps), deltaPaise: -amount }]
          : [], // rows older than this instrumentation lack account info — omit rather than guess
    };
  },
  "ImportBatch:import": (row) => {
    const p = asSnap(row.after);
    const imported = num(p.imported) ?? 0;
    const skipped = num(p.skipped) ?? 0;
    return {
      ...base(row),
      verb: "imported",
      entityType: "import",
      entityLabel: `${imported} transaction${imported === 1 ? "" : "s"}`,
      icon: "📥",
      summary: `Imported ${imported} transaction${imported === 1 ? "" : "s"}`,
      detail: skipped > 0 ? `${skipped} duplicate${skipped === 1 ? "" : "s"} skipped` : undefined,
      diff: [],
      effects: [],
    };
  },
  "ImportBatch:undo-import": (row) => {
    const p = asSnap(row.after);
    const reversed = num(p.reversed) ?? 0;
    return {
      ...base(row),
      verb: "import_undone",
      entityType: "import",
      entityLabel: `${reversed} transaction${reversed === 1 ? "" : "s"} removed`,
      icon: "↩️",
      summary: "Undid import",
      diff: [],
      effects: [],
    };
  },
};

// ─────────── presenter entry point ───────────

/** Map one audit row to a timeline event. Returns null for no-op edits and
 * unknown kinds (defensive rule: skip, never crash — the caller counts skips). */
export function presentAuditRow(row: AuditRowInput, maps: LabelMaps): TimelineEvent | null {
  const present = REGISTRY[`${row.entity}:${row.action}`];
  if (!present) return null;
  try {
    return present(row, maps);
  } catch {
    return null; // historical payload shapes must never take the page down
  }
}

/** Render helper shared by UI + tests: "₹420 → ₹520 (+₹100)". */
export function formatDiffRow(d: DiffRow): string {
  const deltaNote = d.delta !== undefined && d.delta !== 0 ? ` (${signedPaise(d.delta)})` : "";
  return `${d.formattedBefore} → ${d.formattedAfter}${deltaNote}`;
}
