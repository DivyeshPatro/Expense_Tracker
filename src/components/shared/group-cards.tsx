// v2.1 — the Shared home's primary content.
//
// Shared used to lead with a flat list of every shared expense. Nobody thinks
// about a split that way: an expense belongs to a trip, a flat, a lunch. These
// cards make the group the object you scan, and each one answers the questions
// you'd otherwise have to open it to learn — how many people, what you'll get,
// what you'll pay, where you net out, and whether anything is still open.

import Link from "next/link";
import { friendlyDay } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import type { GroupSummary } from "@/server/services/group-dashboard";

export function GroupCards({ groups }: { groups: GroupSummary[] }) {
  return (
    // Single column on a phone; the cards pack side by side once there is room,
    // so a wide screen isn't one tall ribbon of whitespace.
    <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))" }}>
      {groups.map((g) => (
        <GroupCard key={g.id} g={g} />
      ))}
    </div>
  );
}

function GroupCard({ g }: { g: GroupSummary }) {
  const netColor = g.settled ? "var(--mut2)" : g.youNet < 0 ? "var(--red)" : "var(--green)";
  const roster = g.memberNames.slice(0, 3).join(", ");
  const more = g.memberNames.length > 3 ? ` +${g.memberNames.length - 3}` : "";

  return (
    <Link
      href={`/shared/groups/${g.id}`}
      className="card no-underline text-ink flex flex-col gap-2.5 p-[var(--pad)] min-h-[44px] hover:bg-accsoft transition-colors"
    >
      <div className="flex items-start gap-2.5">
        <span className="w-9 h-9 rounded-[11px] grid place-items-center text-[16px] flex-none" style={{ background: "var(--accSoft)" }} aria-hidden>
          🏠
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-extrabold truncate">{g.name}</div>
          <div className="text-[11.5px] text-mut2 truncate">
            {g.memberCount} {g.memberCount === 1 ? "person" : "people"}
            {roster && ` · ${roster}${more}`}
          </div>
        </div>
        {g.settled ? (
          <span
            className="text-[9.5px] font-bold uppercase tracking-wide rounded-full px-2 py-[3px] flex-none"
            style={{ background: "var(--greenSoft, var(--accSoft))", color: "var(--green)" }}
          >
            Settled
          </span>
        ) : (
          <span aria-hidden className="text-mut2 text-[13px] flex-none">›</span>
        )}
      </div>

      {/* The three figures the card exists to answer, in one row. */}
      <div className="flex items-stretch gap-2">
        <Figure label="You'll get" value={formatPaise(g.youAreOwed)} color={g.youAreOwed > 0 ? "var(--green)" : undefined} />
        <Figure label="You'll pay" value={formatPaise(g.youOwe)} color={g.youOwe > 0 ? "var(--red)" : undefined} />
        <Figure
          label="Net"
          value={g.settled ? "—" : `${g.youNet < 0 ? "−" : "+"}${formatPaise(Math.abs(g.youNet))}`}
          color={netColor}
          strong
        />
      </div>

      <div className="flex items-center justify-between text-[11px] text-mut2 border-t border-line pt-2">
        <span className="tabular-nums">
          {g.expenseCount === 0 ? "No expenses yet" : `${g.expenseCount} expense${g.expenseCount === 1 ? "" : "s"} · ${formatPaise(g.totalSpent)}`}
        </span>
        {g.lastActivity && <span>{friendlyDay(g.lastActivity)}</span>}
      </div>
    </Link>
  );
}

function Figure({ label, value, color, strong }: { label: string; value: string; color?: string; strong?: boolean }) {
  return (
    <div className="flex-1 min-w-0 rounded-[10px] px-2.5 py-1.5" style={{ background: "var(--side)" }}>
      <div className="text-[9.5px] font-bold uppercase tracking-wide text-mut2 truncate">{label}</div>
      <div className={`${strong ? "text-[14px]" : "text-[13px]"} font-extrabold tabular-nums truncate`} style={{ color }}>
        {value}
      </div>
    </div>
  );
}
