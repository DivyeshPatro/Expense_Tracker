// Notification Center (Phase 2.5) — data only, per spec: one urgency-sorted
// feed merging lending reminders, bill reminders, pending settlements, and
// offline sync issues. Pure normalization over already-fetched module data —
// no queries, no delivery mechanism (push belongs to a later phase; a future
// notification system consumes exactly this shape).

import type { ReminderCandidate } from "./lending-reminders";
import { formatPaise } from "./money";

/** 0 = most urgent. Ties broken by daysUntilDue (most overdue / soonest first). */
export type FeedUrgency = 0 | 1 | 2 | 3;

export type FeedLink =
  | { type: "route"; href: string }
  | { type: "loanDetail"; loanEntryId: string }
  | { type: "syncIssue"; intentId: string };

export interface FeedItem {
  id: string; // stable dedupe key
  icon: string;
  urgency: FeedUrgency;
  title: string;
  detail?: string;
  daysUntilDue: number; // negative ⇒ past due; large positive ⇒ informational
  link: FeedLink;
}

export interface BillForFeed {
  id: string;
  name: string;
  amount: number; // paise
  days: number; // negative = overdue
  dueLabel: string;
  urgency: "overdue" | "urgent" | "soon" | "later";
}

export interface SettlementForFeed {
  participantId: string;
  name: string;
  net: number; // paise: positive ⇒ they owe you
}

export interface SyncIssueForFeed {
  intentId: string;
  label: string; // intentLabel() output — "₹500 · You Gave · Rohan" etc.
}

const LENDING_URGENCY: Record<ReminderCandidate["category"], FeedUrgency> = {
  overdue: 0,
  due_today: 1,
  card_due_tomorrow: 1,
  due_tomorrow: 1,
  due_this_week: 2,
  card_due_this_week: 2,
  recover_before_card_due: 3,
};

const LENDING_TITLES: Record<ReminderCandidate["category"], (name: string) => string> = {
  overdue: (n) => `${n}'s loan is overdue`,
  due_today: (n) => `${n}'s loan is due today`,
  due_tomorrow: (n) => `${n}'s loan is due tomorrow`,
  due_this_week: (n) => `${n}'s loan is due this week`,
  recover_before_card_due: (n) => `Recover from ${n} before the card bill`,
  card_due_tomorrow: (n) => `Card bill tomorrow — recover from ${n}`,
  card_due_this_week: (n) => `Card bill this week — recover from ${n}`,
};

/**
 * Merge the four sources into one urgency-sorted feed. Sync issues always
 * lead (a stuck local change is a data-integrity problem, not a calendar
 * item), then everything else by urgency, then by how soon/overdue it is.
 */
export function buildFeed(sources: {
  reminders: ReminderCandidate[];
  bills: BillForFeed[];
  settlements: SettlementForFeed[];
  syncIssues?: SyncIssueForFeed[];
}): FeedItem[] {
  const items: FeedItem[] = [];

  for (const s of sources.syncIssues ?? []) {
    items.push({
      id: `sync:${s.intentId}`,
      icon: "⚠️",
      urgency: 0,
      title: "A change needs your attention",
      detail: s.label,
      daysUntilDue: -9999, // always ahead of everything else at urgency 0
      link: { type: "syncIssue", intentId: s.intentId },
    });
  }

  for (const r of sources.reminders) {
    items.push({
      id: r.id,
      icon: "🤝",
      urgency: LENDING_URGENCY[r.category],
      title: LENDING_TITLES[r.category](r.participantName),
      detail: formatPaise(r.amount) + " outstanding",
      daysUntilDue: r.daysUntilDue,
      link: { type: "loanDetail", loanEntryId: r.loanEntryId },
    });
  }

  for (const b of sources.bills) {
    if (b.urgency === "later") continue; // informational bills stay on /bills, not in the feed
    items.push({
      id: `bill:${b.id}`,
      icon: "🧾",
      urgency: b.urgency === "overdue" ? 0 : b.urgency === "urgent" ? 1 : 2,
      title: `${b.name} — ${b.dueLabel.toLowerCase()}`,
      detail: formatPaise(b.amount),
      daysUntilDue: b.days,
      link: { type: "route", href: "/bills" },
    });
  }

  for (const s of sources.settlements) {
    if (Math.abs(s.net) <= 100) continue; // dust — same threshold the Shared page uses
    items.push({
      id: `settle:${s.participantId}`,
      icon: "👥",
      urgency: 3,
      title: s.net > 0 ? `${s.name} owes you ${formatPaise(s.net)}` : `You owe ${s.name} ${formatPaise(-s.net)}`,
      detail: "Pending settlement",
      daysUntilDue: 9999, // no deadline — informational, sorts after dated items
      link: { type: "route", href: "/shared" },
    });
  }

  return items.sort((a, b) => (a.urgency !== b.urgency ? a.urgency - b.urgency : a.daysUntilDue - b.daysUntilDue));
}
