// Maps a ledger row to the display shape used across dashboard / transactions /
// shared lists (mirrors the prototype's dispTx): icon bubble, meta line with
// split / recurring / receipt badges, signed amount + color.

import { formatPaise } from "./money";

export interface TxRowInput {
  id: string;
  type: "EXPENSE" | "INCOME" | "TRANSFER";
  amount: number;
  accountName: string | null;
  toAccountName: string | null;
  category: string | null;
  icon: string;
  color: string;
  merchant: string;
  ymd: string;
  notes: string | null;
  isRecurring: boolean;
  hasReceipt: boolean;
  split: { paidByMe: boolean; payerName: string | null; partCount: number; myShare: number } | null;
}

export interface TxDisplay {
  id: string;
  icon: string;
  iconBg: string;
  name: string;
  meta: string;
  amtF: string;
  amtColor: string; // CSS value
  ymd: string;
}

export function soft(hex: string): string {
  return hex + "22";
}

export function txDisplay(t: TxRowInput): TxDisplay {
  const parts: string[] = [];
  if (t.type === "TRANSFER") {
    parts.push(`${t.accountName ?? "—"} → ${t.toAccountName ?? "—"}`);
  } else {
    parts.push(t.category ?? "Misc");
    if (t.split && !t.split.paidByMe) parts.push(`paid by ${t.split.payerName}`);
    else if (t.accountName) parts.push(t.accountName);
    if (t.split) parts.push(`👥 split · your share ${formatPaise(t.split.myShare)}`);
    if (t.isRecurring) parts.push("🔁");
    if (t.hasReceipt) parts.push("📎");
    if (t.notes) parts.push(t.notes);
  }
  let amtF: string;
  let amtColor: string;
  if (t.type === "INCOME") {
    amtF = "+" + formatPaise(t.amount);
    amtColor = "var(--green)";
  } else if (t.type === "TRANSFER") {
    amtF = formatPaise(t.amount);
    amtColor = "var(--mut)";
  } else {
    amtF = "−" + formatPaise(t.amount);
    amtColor = "var(--ink)";
  }
  return { id: t.id, icon: t.icon, iconBg: soft(t.color), name: t.merchant, meta: parts.join(" · "), amtF, amtColor, ymd: t.ymd };
}
