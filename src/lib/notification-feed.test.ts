import { describe, expect, it } from "vitest";
import { buildFeed, type BillForFeed, type SettlementForFeed } from "./notification-feed";
import type { ReminderCandidate } from "./lending-reminders";

const reminder = (over: Partial<ReminderCandidate> = {}): ReminderCandidate => ({
  id: "loan-due_today:l1",
  category: "due_today",
  loanEntryId: "l1",
  participantId: "p1",
  participantName: "Rohan",
  amount: 50000,
  dueDate: "2026-08-11",
  daysUntilDue: 0,
  ...over,
});

const bill = (over: Partial<BillForFeed> = {}): BillForFeed => ({
  id: "b1",
  name: "Rent",
  amount: 1500000,
  days: 2,
  dueLabel: "Due in 2d",
  urgency: "urgent",
  ...over,
});

const settlement = (over: Partial<SettlementForFeed> = {}): SettlementForFeed => ({
  participantId: "p1",
  name: "Karan",
  net: 45000,
  ...over,
});

describe("buildFeed", () => {
  it("returns an empty feed for empty sources", () => {
    expect(buildFeed({ reminders: [], bills: [], settlements: [] })).toEqual([]);
  });

  it("sorts by urgency: overdue loan before urgent bill before this-week before settlement", () => {
    const feed = buildFeed({
      reminders: [
        reminder({ id: "a", category: "overdue", daysUntilDue: -5 }),
        reminder({ id: "b", category: "due_this_week", daysUntilDue: 4 }),
      ],
      bills: [bill()],
      settlements: [settlement()],
    });
    expect(feed.map((f) => f.urgency)).toEqual([0, 1, 2, 3]);
    expect(feed[0].id).toBe("a");
    expect(feed[feed.length - 1].id).toBe("settle:p1");
  });

  it("sync issues always lead the feed, even ahead of overdue items", () => {
    const feed = buildFeed({
      reminders: [reminder({ category: "overdue", daysUntilDue: -30 })],
      bills: [bill({ urgency: "overdue", days: -10, dueLabel: "Overdue" })],
      settlements: [],
      syncIssues: [{ intentId: "i1", label: "₹500 · You Gave · Rohan" }],
    });
    expect(feed[0].link).toEqual({ type: "syncIssue", intentId: "i1" });
  });

  it("within the same urgency, more-overdue items come first", () => {
    const feed = buildFeed({
      reminders: [
        reminder({ id: "less", category: "overdue", daysUntilDue: -2 }),
        reminder({ id: "more", category: "overdue", daysUntilDue: -20 }),
      ],
      bills: [],
      settlements: [],
    });
    expect(feed.map((f) => f.id)).toEqual(["more", "less"]);
  });

  it("bills marked 'later' never enter the feed", () => {
    expect(buildFeed({ reminders: [], bills: [bill({ urgency: "later", days: 20 })], settlements: [] })).toEqual([]);
  });

  it("dust-level settlement balances (≤ ₹1) are excluded, matching the Shared page threshold", () => {
    expect(buildFeed({ reminders: [], bills: [], settlements: [settlement({ net: 100 })] })).toEqual([]);
    expect(buildFeed({ reminders: [], bills: [], settlements: [settlement({ net: -100 })] })).toEqual([]);
  });

  it("settlement direction phrasing matches the sign of the net", () => {
    const feed = buildFeed({
      reminders: [],
      bills: [],
      settlements: [settlement({ net: 45000 }), settlement({ participantId: "p2", name: "Priya", net: -20000 })],
    });
    expect(feed[0].title).toBe("Karan owes you ₹450");
    expect(feed[1].title).toBe("You owe Priya ₹200");
  });

  it("loan reminders link to their loan's detail modal", () => {
    const [item] = buildFeed({ reminders: [reminder()], bills: [], settlements: [] });
    expect(item.link).toEqual({ type: "loanDetail", loanEntryId: "l1" });
  });

  it("feed ids are stable across rebuilds (dedupe keys for a future delivery system)", () => {
    const sources = { reminders: [reminder()], bills: [bill()], settlements: [settlement()] };
    const a = buildFeed(sources).map((f) => f.id);
    const b = buildFeed(sources).map((f) => f.id);
    expect(a).toEqual(b);
  });
});
