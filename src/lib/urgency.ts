// Shared color mapping for BillView["urgency"] (src/server/services/bills.ts)
// — dashboard's attention strip and the Bills page both render the exact
// same urgency domain and previously reimplemented this mapping separately.
// Not a general "urgency" utility: notification-center's numeric FeedUrgency,
// the lending Reminders panel's category set, and Card Recovery's ad hoc
// days-until-due threshold are genuinely different domains/thresholds (the
// reminders panel deliberately uses --acc, not amber, for one of its
// categories) — those are left alone rather than force-fit into this.

export type BillUrgency = "overdue" | "urgent" | "soon" | "later";

export function billUrgencyColor(urgency: BillUrgency): string {
  if (urgency === "overdue" || urgency === "urgent") return "var(--red)";
  if (urgency === "soon") return "var(--amber)";
  return "var(--mut)";
}

export function billUrgencyBackground(urgency: BillUrgency): string {
  if (urgency === "overdue" || urgency === "urgent") return "var(--redSoft)";
  if (urgency === "soon") return "var(--amberSoft)";
  return "var(--accSoft)";
}
