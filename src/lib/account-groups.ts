// Pure grouping/labelling logic behind every account & funding-source picker.
// Kept separate from the rendering component so it's unit-testable in the
// existing pure-logic test suite (no DOM, no React renderer needed).

export interface AccountForPicker {
  id: string;
  name: string;
  icon: string;
  type?: string;
  cardNetwork?: string | null;
  cardLast4?: string | null;
}

// Cash first, then the accounts money is usually spent from, then investments —
// mirrors how the funding-source kinds are phrased to users and puts the common
// picks on top.
export const ACCOUNT_TYPE_GROUPS: { type: string; label: string }[] = [
  { type: "CASH", label: "Cash" },
  { type: "BANK", label: "Bank" },
  { type: "WALLET", label: "Wallet" },
  { type: "CREDIT_CARD", label: "Credit card" },
  { type: "INVESTMENT", label: "Investment" },
];

/** "Visa •••• 4242" from the Card Vault, when present. Credit cards only. */
export function cardSuffix(a: AccountForPicker): string {
  if (a.type !== "CREDIT_CARD") return "";
  const bits = [a.cardNetwork || null, a.cardLast4 ? `•••• ${a.cardLast4}` : null].filter(Boolean);
  return bits.length ? ` · ${bits.join(" ")}` : "";
}

export function accountOptionLabel(a: AccountForPicker): string {
  return `${a.icon} ${a.name}${cardSuffix(a)}`;
}

export interface AccountGroup {
  label: string;
  items: AccountForPicker[];
}

/**
 * Partitions accounts into funding-type groups, preserving input order within
 * each group and dropping empty groups.
 *
 * Accounts with a missing or unrecognised type land in "Other" rather than being
 * dropped — `type` is optional on the client's ref data, and silently omitting an
 * account from a funding-source picker would be worse than an imperfect grouping.
 *
 * Returns `null` when grouping would add nothing (zero or one group), so callers
 * can render a plain list instead of a single pointless header.
 */
export function groupAccountsByType(accounts: AccountForPicker[]): AccountGroup[] | null {
  const known = new Set(ACCOUNT_TYPE_GROUPS.map((t) => t.type));
  const groups: AccountGroup[] = ACCOUNT_TYPE_GROUPS.map((t) => ({
    label: t.label,
    items: accounts.filter((a) => a.type === t.type),
  })).filter((g) => g.items.length > 0);

  const other = accounts.filter((a) => !a.type || !known.has(a.type));
  if (other.length > 0) groups.push({ label: "Other", items: other });

  return groups.length > 1 ? groups : null;
}
