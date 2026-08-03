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

export interface RelatedLink {
  label: string;
  href: string;
}

export interface TimelineEvent {
  activityId: string; // "ACT_<auditRowId>" / "ACT_N<notificationId>" — derived, stable, never stored
  ts: string; // ISO-8601, audit row `at`
  verb: string;
  entityType: "transaction" | "transfer" | "account" | "category" | "budget" | "bill" | "import" | "settlement" | "loan" | "card";
  entityId: string;
  entityLabel: string; // from snapshot — deleted entities keep their historical name
  icon: string;
  summary: string; // verb-first title, e.g. "Edited expense"
  detail?: string; // optional second line under the label
  diff: DiffRow[];
  effects: EffectRow[];
  /** deterministic navigation, rendered only in expanded views (RFC §7) */
  related: RelatedLink[];
  /** present when a 10-minute edit chain was collapsed (RFC §3): this event
   * carries the NET diff; members are the individual steps, newest first */
  collapsed?: { count: number; members: TimelineEvent[] };
  /** collaboration-architecture-rfc §5: who actually performed the action,
   * only ever set when that differs from whose ledger it's filed under (a
   * group co-member editing someone else's transaction) — resolved
   * server-side into a display name, same reasoning as every other
   * cross-namespace label in this codebase (never left for the client to
   * look up against its own, possibly unrelated, id space). */
  actorName?: string;
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
  actorUserId?: string | null;
}

/** Lookup maps built once per page by the caller — id → display label. */
export interface LabelMaps {
  categories: Map<string, { name: string; icon: string }>;
  accounts: Map<string, string>;
  participants: Map<string, string>;
  /** collaboration-architecture-rfc §5 — userId → display name, populated
   * only for the (usually empty) set of distinct actorUserIds actually
   * present in the current page/history slice. */
  actorNames: Map<string, string>;
}

// ─────────── allowlist + chip filters (pushed into SQL by the service) ───────────

export const ACTIVITY_ALLOWLIST: { entity: string; actions: string[] }[] = [
  { entity: "Transaction", actions: ["create", "update", "soft-delete", "restore"] },
  { entity: "Settlement", actions: ["create", "delete"] },
  { entity: "Category", actions: ["create", "rename", "kind-change", "delete"] },
  { entity: "Account", actions: ["create"] },
  { entity: "Budget", actions: ["create", "update"] },
  { entity: "Bill", actions: ["create", "bill-paid"] },
  { entity: "ImportBatch", actions: ["import", "undo-import"] },
  { entity: "LoanEntry", actions: ["create", "update", "soft-delete", "restore"] },
  // Cards (v2.0 completion): lifecycle + access. Access rows (reveal/checkout/
  // copy-*) are the security trail — when card details were seen or copied —
  // and store metadata only, never a secret.
  { entity: "CreditCard", actions: ["create", "update", "archive", "restore", "delete", "reveal", "checkout", "copy-number", "copy-expiry", "copy-cvv", "copy-details"] },
];

export const ACTIVITY_CHIPS = ["all", "money", "accounts", "cards", "budgets", "shared", "lending", "imports"] as const;
export type ActivityChip = (typeof ACTIVITY_CHIPS)[number];

export const CHIP_LABELS: Record<ActivityChip, string> = {
  all: "All",
  money: "Money",
  accounts: "Accounts",
  cards: "Cards",
  budgets: "Budgets & Bills",
  shared: "Shared",
  lending: "Lending",
  imports: "Imports",
};

export const CHIP_ENTITIES: Record<Exclude<ActivityChip, "all">, string[]> = {
  money: ["Transaction"],
  accounts: ["Account"],
  cards: ["CreditCard"],
  budgets: ["Budget", "Bill"],
  shared: ["Settlement"],
  lending: ["LoanEntry"],
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

const LOAN_FIELDS: FieldSpec[] = [
  { field: "amount", fieldLabel: "Amount", format: (v) => (num(v) === undefined ? undefined : formatPaise(num(v)!)), amount: true },
  { field: "kind", fieldLabel: "Type", format: (v) => (str(v) === "GOT" ? "You Got" : "You Gave") },
  { field: "accountId", fieldLabel: "Funding source", format: (v, m) => accountLabel(v, m) },
  { field: "occurredAt", fieldLabel: "Date", format: (v) => isoToDateLabel(str(v)) },
  { field: "dueDate", fieldLabel: "Due date", format: (v) => isoToDateLabel(str(v)) },
  { field: "reason", fieldLabel: "Reason", format: (v) => (str(v) ? truncate(str(v)!) : "—") },
  { field: "notes", fieldLabel: "Note", format: (v) => (str(v) ? `“${truncate(str(v)!)}”` : "—") },
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

// registry entries emit everything except `related`, which is attached
// centrally by presentAuditRow via relatedFor() — one builder, one place
type PresentedCore = Omit<TimelineEvent, "related">;
type Present = (row: AuditRowInput, maps: LabelMaps) => PresentedCore | null;

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

/** Deterministic related links (RFC §7) — built from data already inside the
 * event's snapshots; never a query. Rendered only in expanded views. */
function relatedFor(row: AuditRowInput, maps: LabelMaps): RelatedLink[] {
  if (row.entity === "Transaction") {
    const p = asSnap(row.after ?? row.before);
    const links: RelatedLink[] = [];
    const catId = str(p.categoryId);
    const type = str(p.type);
    if (catId && maps.categories.has(catId) && (type === "EXPENSE" || type === "INCOME")) {
      links.push({ label: categoryLabel(catId, maps), href: `/transactions?category=${catId}&tab=${type}` });
    }
    for (const id of [str(p.accountId), str(p.toAccountId)]) {
      if (id && maps.accounts.has(id)) links.push({ label: `🏦 ${maps.accounts.get(id)}`, href: "/accounts" });
    }
    return links;
  }
  if (row.entity === "ImportBatch" && row.action === "import") {
    const after = asSnap(row.after);
    // A lending import points at Import History (its rows are in Lending, not
    // the transactions ledger); a transaction import links to those rows.
    if (num(after.lendingEntries) != null) {
      return [{ label: "View import history", href: "/settings" }];
    }
    const imported = num(after.imported) ?? 0;
    return [{ label: `View ${imported} transaction${imported === 1 ? "" : "s"}`, href: `/transactions?batch=${row.entityId}&p=all` }];
  }
  if (row.entity === "LoanEntry") {
    const p = asSnap(row.after ?? row.before);
    const participantId = str(p.participantId);
    if (participantId && maps.participants.has(participantId)) {
      return [{ label: `👥 ${maps.participants.get(participantId)}`, href: `/lending?contact=${participantId}` }];
    }
  }
  return [];
}

// ─────────── card helpers (Cards Activity, v2.0) ───────────

const cardMask = (p: Snap): string | undefined => {
  const last4 = str(p.last4);
  return last4 ? `•••• ${last4}` : undefined;
};

const cardLabel = (p: Snap): string => {
  const nick = str(p.nickname);
  const mask = cardMask(p);
  if (nick && mask) return `${nick} ${mask}`;
  return nick ?? mask ?? "(card)";
};

const CARD_FIELDS: FieldSpec[] = [
  { field: "nickname", fieldLabel: "Nickname", format: (v) => str(v) },
  { field: "bank", fieldLabel: "Bank", format: (v) => str(v) },
  { field: "network", fieldLabel: "Network", format: (v) => str(v) },
  { field: "last4", fieldLabel: "Last 4", format: (v) => (str(v) ? `•••• ${str(v)}` : undefined) },
];

/** Shared core for every card event: the "card" entityType, a label from the
 * snapshot, and no balance effects — the card vault never touches an account
 * balance. Presenters spread this and override verb / icon / summary / diff. */
function cardBase(row: AuditRowInput, p: Snap): PresentedCore {
  return {
    ...base(row),
    entityType: "card",
    entityLabel: cardLabel(p),
    verb: "",
    icon: "💳",
    summary: "",
    diff: [],
    effects: [],
  };
}

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
  "Settlement:delete": (row, maps) => {
    const p = asSnap(row.before);
    const name = participantLabel(p.participantId, maps);
    const amount = num(p.amount);
    const toOwner = str(p.direction) === "TO_OWNER";
    return {
      ...base(row),
      verb: "unsettled",
      entityType: "settlement",
      entityLabel: toOwner ? `${name} paid you` : `You paid ${name}`,
      icon: "🗑",
      summary: "Removed a settlement",
      detail: amount === undefined ? undefined : formatPaise(amount),
      diff: [],
      effects: [],
    };
  },
  "LoanEntry:create": (row, maps) => {
    const p = asSnap(row.after);
    const name = participantLabel(p.participantId, maps);
    const amount = num(p.amount);
    const gave = str(p.kind) !== "GOT";
    return {
      ...base(row),
      verb: gave ? "lent" : "repaid",
      entityType: "loan",
      entityLabel: name,
      icon: gave ? "💸" : "💰",
      summary: gave ? `You lent ${name}` : `${name} repaid you`,
      detail: amount === undefined ? undefined : formatPaise(amount),
      diff: [],
      effects: [], // lending entries don't touch account balances (Phase 1 scope)
    };
  },
  "LoanEntry:update": (row, maps) => {
    const before = asSnap(row.before);
    const after = asSnap(row.after);
    const name = participantLabel(after.participantId, maps);
    const diff = diffFields(LOAN_FIELDS, before, after, maps);
    if (diff.length === 0) return null;
    const gave = str(after.kind) !== "GOT";
    return {
      ...base(row),
      verb: "edited",
      entityType: "loan",
      entityLabel: name,
      icon: "✏️",
      summary: gave ? `Edited a loan to ${name}` : `Edited a repayment from ${name}`,
      diff,
      effects: [],
    };
  },
  "LoanEntry:soft-delete": (row, maps) => {
    const p = asSnap(row.before);
    const name = participantLabel(p.participantId, maps);
    const amount = num(p.amount);
    const gave = str(p.kind) !== "GOT";
    return {
      ...base(row),
      verb: "deleted",
      entityType: "loan",
      entityLabel: name,
      icon: "🗑",
      summary: gave ? `Deleted a loan to ${name}` : `Deleted a repayment from ${name}`,
      detail: amount === undefined ? undefined : formatPaise(amount),
      diff: [],
      effects: [],
    };
  },
  "LoanEntry:restore": (row, maps) => {
    const p = asSnap(row.after);
    const name = participantLabel(p.participantId, maps);
    const amount = num(p.amount);
    const gave = str(p.kind) !== "GOT";
    return {
      ...base(row),
      verb: "restored",
      entityType: "loan",
      entityLabel: name,
      icon: "↩️",
      summary: gave ? `Restored a loan to ${name}` : `Restored a repayment from ${name}`,
      detail: amount === undefined ? undefined : formatPaise(amount),
      diff: [],
      effects: [],
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
    // Khatabook → Lending imports record lendingEntries (never transactions);
    // present them in lending language rather than "Imported 0 transactions".
    const lendingEntries = num(p.lendingEntries);
    if (lendingEntries != null) {
      const contacts = num(p.contacts) ?? 0;
      const src = str(p.source);
      const from = src ? ` from ${src.charAt(0).toUpperCase()}${src.slice(1)}` : "";
      return {
        ...base(row),
        verb: "imported",
        entityType: "import",
        entityLabel: `${lendingEntries} lending entr${lendingEntries === 1 ? "y" : "ies"}`,
        icon: "📒",
        summary: `Imported ${lendingEntries} lending entr${lendingEntries === 1 ? "y" : "ies"}${from}`,
        detail: contacts > 0 ? `${contacts} new contact${contacts === 1 ? "" : "s"}` : undefined,
        diff: [],
        effects: [],
      };
    }
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
  "CreditCard:create": (row) => {
    const p = asSnap(row.after);
    return {
      ...cardBase(row, p),
      verb: "created",
      icon: "💳",
      summary: "Added card",
      detail: [str(p.bank), str(p.network), cardMask(p)].filter(Boolean).join(" · ") || undefined,
    };
  },
  "CreditCard:update": (row, maps) => {
    const before = asSnap(row.before);
    const after = asSnap(row.after);
    // Only metadata (nickname/bank/network/last4) is in the audit payload, so a
    // change limited to the encrypted fields (expiry/CVV/number) shows no diff
    // rows — still a real edit, so unlike a transaction it isn't dropped.
    return {
      ...cardBase(row, after),
      verb: "edited",
      icon: "✏️",
      summary: "Edited card",
      diff: diffFields(CARD_FIELDS, before, after, maps),
    };
  },
  "CreditCard:archive": (row) => ({
    ...cardBase(row, asSnap(row.after)),
    verb: "archived",
    icon: "🗃",
    summary: "Archived card",
  }),
  "CreditCard:restore": (row) => ({
    ...cardBase(row, asSnap(row.after)),
    verb: "restored",
    icon: "↩️",
    summary: "Restored card",
  }),
  "CreditCard:delete": (row) => ({
    ...cardBase(row, asSnap(row.before)),
    verb: "deleted",
    icon: "🗑",
    summary: "Deleted card",
  }),
  "CreditCard:reveal": (row) => ({
    ...cardBase(row, asSnap(row.after)),
    verb: "revealed",
    icon: "👁",
    summary: "Revealed card details",
  }),
  "CreditCard:checkout": (row) => ({
    ...cardBase(row, asSnap(row.after)),
    verb: "checked_out",
    icon: "🛒",
    summary: "Used checkout helper",
  }),
  "CreditCard:copy-number": (row) => ({
    ...cardBase(row, asSnap(row.after)),
    verb: "copied",
    icon: "📋",
    summary: "Copied card number",
  }),
  "CreditCard:copy-expiry": (row) => ({
    ...cardBase(row, asSnap(row.after)),
    verb: "copied",
    icon: "📋",
    summary: "Copied expiry",
  }),
  "CreditCard:copy-cvv": (row) => ({
    ...cardBase(row, asSnap(row.after)),
    verb: "copied",
    icon: "📋",
    summary: "Copied CVV",
  }),
  "CreditCard:copy-details": (row) => ({
    ...cardBase(row, asSnap(row.after)),
    verb: "copied",
    icon: "📋",
    summary: "Copied full card details",
  }),
};

// ─────────── presenter entry point ───────────

/** Map one audit row to a timeline event. Returns null for no-op edits and
 * unknown kinds (defensive rule: skip, never crash — the caller counts skips). */
export function presentAuditRow(row: AuditRowInput, maps: LabelMaps): TimelineEvent | null {
  const present = REGISTRY[`${row.entity}:${row.action}`];
  if (!present) return null;
  try {
    const core = present(row, maps);
    if (!core) return null;
    const actorName = row.actorUserId ? maps.actorNames.get(row.actorUserId) : undefined;
    return { ...core, related: relatedFor(row, maps), ...(actorName ? { actorName } : {}) };
  } catch {
    return null; // historical payload shapes must never take the page down
  }
}

/** Budget-exceeded events come from the Notification table, not the audit log
 * (the only notification-sourced kind in the catalog). Same defensive rules. */
export function presentNotificationRow(n: { id: string; kind: string; payload: unknown; createdAt: string }): TimelineEvent | null {
  if (n.kind !== "BUDGET_EXCEEDED") return null;
  // asSnap's own fallback ({} for any non-object) is the right default
  // everywhere else in this file — a legitimately-absent before/after
  // shouldn't crash a whole audit row. But a truly malformed payload here
  // (e.g. a bare string, not even an object) shouldn't get asSnap'd into an
  // empty object and silently produce a "Budget budget exceeded" event with
  // placeholder text — that's worse than showing nothing.
  if (!n.payload || typeof n.payload !== "object") return null;
  try {
    const p = asSnap(n.payload);
    const category = str(p.category) ?? "Budget";
    const spent = num(p.spent);
    const limit = num(p.limit);
    return {
      activityId: `ACT_N${n.id}`,
      ts: n.createdAt,
      verb: "exceeded",
      entityType: "budget",
      entityId: str(p.budgetId) ?? n.id,
      entityLabel: category,
      icon: "⚠",
      summary: `${category} budget exceeded`,
      detail: spent !== undefined && limit !== undefined && spent > limit ? `over by ${formatPaise(spent - limit)}` : undefined,
      diff: [],
      effects: [],
      related: [],
    };
  } catch {
    return null;
  }
}

// ─────────── 10-minute edit-chain collapse (RFC §3) ───────────

/**
 * Group consecutive Transaction:update rows on the same entity where each
 * edit is within `windowMs` of the previous (chain rule) AND was performed
 * by the same actor. Any same-entity event of another action, or a change
 * of actor, breaks that entity's chain; other entities' events interleaving
 * do not. Input and output are newest-first; a chain occupies its newest
 * member's position. Per-page only by design — a chain split across a page
 * boundary renders as two groups (accepted in the RFC).
 *
 * collaboration-architecture-rfc §5: the actor check is load-bearing, not
 * cosmetic — collapsing two different people's edits into one "net diff"
 * event would silently blend their changes under a single (misleading)
 * attribution. A 10-minute quiet-typing-pause heuristic was only ever
 * correct as a proxy for "one person editing" in a single-writer world.
 */
export function groupUpdateChains(rows: AuditRowInput[], windowMs = 10 * 60_000): (AuditRowInput | AuditRowInput[])[] {
  const out: (AuditRowInput | { chain: AuditRowInput[] })[] = [];
  const open = new Map<string, { chain: AuditRowInput[] }>(); // entity key → growing chain
  for (const row of rows) {
    const key = `${row.entity}:${row.entityId}`;
    if (row.entity === "Transaction" && row.action === "update") {
      const cur = open.get(key);
      if (cur) {
        const prevOldest = cur.chain[cur.chain.length - 1];
        const sameActor = (prevOldest.actorUserId ?? null) === (row.actorUserId ?? null);
        if (sameActor && new Date(prevOldest.at).getTime() - new Date(row.at).getTime() <= windowMs) {
          cur.chain.push(row); // absorbed into the chain at its existing position
          continue;
        }
      }
      const fresh = { chain: [row] };
      open.set(key, fresh);
      out.push(fresh);
    } else {
      open.delete(key); // same-entity non-update breaks the chain
      out.push(row);
    }
  }
  return out.map((item) => ("chain" in item ? (item.chain.length === 1 ? item.chain[0] : item.chain) : item));
}

/**
 * Present a collapsed chain as one event carrying the NET diff (oldest
 * `before` → newest `after`) plus the individual steps for expansion.
 * Returns null when the chain nets out to no change (A→B→A) — consistent
 * with the no-op-edit rule: no net change, no event.
 */
export function presentChain(chain: AuditRowInput[], maps: LabelMaps): TimelineEvent | null {
  const newest = chain[0];
  const oldest = chain[chain.length - 1];
  const net = presentAuditRow({ ...newest, before: oldest.before, after: newest.after }, maps);
  if (!net) return null;
  const members: TimelineEvent[] = [];
  for (const row of chain) {
    const ev = presentAuditRow(row, maps);
    if (ev) members.push(ev);
  }
  return { ...net, collapsed: { count: chain.length, members } };
}

/** Render helper shared by UI + tests: "₹420 → ₹520 (+₹100)". */
export function formatDiffRow(d: DiffRow): string {
  const deltaNote = d.delta !== undefined && d.delta !== 0 ? ` (${signedPaise(d.delta)})` : "";
  return `${d.formattedBefore} → ${d.formattedAfter}${deltaNote}`;
}
