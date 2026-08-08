// Issue #207 — People. One row per person, one balance, both sources shown.
//
// Replaces the mental arithmetic the app used to demand: Shared said Karan
// would pay ₹12,638.33 and Lending said he owed ₹3,000, and nowhere did it say
// ₹15,638.33. Lending and Shared both still exist and are unchanged — they own
// the specialist views (loan reports, groups, settlement history). This screen
// owns the question "what does this person owe me, in total?".

import Link from "next/link";
import { ModuleHero } from "@/components/shell/module-hero";
import { EmptyState } from "@/components/shell/empty-state";
import { OpenModalButton } from "@/components/shell/buttons";
import { formatPaise } from "@/lib/money";
import { peopleSummary } from "@/server/services/people";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function PeoplePage() {
  const user = await requireUser();
  const { rows, totals } = await peopleSummary(user.id);

  const active = rows.filter((r) => !r.settled);
  const settled = rows.filter((r) => r.settled);

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      <ModuleHero
        eyebrow={totals.net >= 0 ? "Owed to you" : "You owe"}
        value={formatPaise(Math.abs(totals.net))}
        valueColor={totals.net >= 0 ? "var(--green)" : "var(--red)"}
        sub={
          totals.toSettle === 0
            ? rows.length
              ? "Everyone's square"
              : "Add a friend to start tracking"
            : `${totals.toSettle} ${totals.toSettle === 1 ? "person" : "people"} to settle${totals.overdueCount ? ` · ${totals.overdueCount} overdue` : ""}`
        }
        tone={totals.overdueCount > 0 ? "bad" : totals.toSettle > 0 ? "warn" : "good"}
        secondary={[
          { label: "You'll get", value: formatPaise(totals.owedToYou), color: totals.owedToYou > 0 ? "var(--green)" : undefined },
          { label: "You'll pay", value: formatPaise(totals.youOwe), color: totals.youOwe > 0 ? "var(--red)" : undefined },
        ]}
      />

      {rows.length === 0 ? (
        <div className="card px-4 py-1.5">
          <EmptyState
            icon="👥"
            title="Everyone you share money with, in one place"
            detail="Money you've lent and bills you've split both land here, added up per person — so you always know where you stand."
            action={
              <OpenModalButton type="friend" className="btn-primary">
                ＋ Add a friend
              </OpenModalButton>
            }
          />
        </div>
      ) : (
        <ul className="flex flex-col gap-2 list-none p-0 m-0">
          {active.map((r) => (
            <PersonRow key={r.id} r={r} />
          ))}
        </ul>
      )}

      {settled.length > 0 && (
        // #208: settled people used to sit in the main list showing "—", adding
        // length without information. Folded away, still reachable.
        <details className="group">
          <summary className="list-none cursor-pointer select-none min-h-[44px] flex items-center gap-1.5 text-[12.5px] font-semibold text-mut hover:text-ink">
            <span aria-hidden className="transition-transform group-open:rotate-90 text-[15px] leading-none">›</span>
            Settled up ({settled.length})
          </summary>
          <ul className="flex flex-col gap-2 list-none p-0 m-0 pt-2">
            {settled.map((r) => (
              <PersonRow key={r.id} r={r} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function PersonRow({ r }: { r: Awaited<ReturnType<typeof peopleSummary>>["rows"][number] }) {
  const owed = r.net > 0;
  // The whole point of this screen: when both ledgers carry a balance, say so
  // on the row, so the combined figure is explained rather than mysterious.
  const breakdown = r.hasBothSources
    ? `${formatPaise(Math.abs(r.sharedNet))} split · ${formatPaise(Math.abs(r.lendingNet))} lent`
    : Math.abs(r.lendingNet) > Math.abs(r.sharedNet)
      ? "lent"
      : "split";

  return (
    <li>
      <Link
        href={`/people/${r.id}`}
        className="flex items-center gap-3 p-3.5 rounded-[14px] bg-card border border-line no-underline text-ink min-h-[44px] hover:border-acc focus-visible:outline-2 focus-visible:outline-acc"
      >
        <span
          className="w-10 h-10 rounded-full grid place-items-center text-[14px] font-bold text-white flex-none"
          style={{ background: r.color }}
          aria-hidden
        >
          {r.initial}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[14px] font-bold truncate">{r.name}</span>
          <span className="block text-[11.5px] text-mut truncate">
            {r.settled ? "all settled" : breakdown}
            {r.overdueCount > 0 && <span className="text-red font-semibold"> · {r.overdueCount} overdue</span>}
          </span>
        </span>
        <span className="text-right flex-none">
          <span
            className="block text-[15px] font-extrabold tabular-nums"
            style={{ color: r.settled ? "var(--mut2)" : owed ? "var(--green)" : "var(--red)" }}
          >
            {r.settled ? "—" : formatPaise(Math.abs(r.net))}
          </span>
          {!r.settled && <span className="block text-[10.5px] text-mut2">{owed ? "owes you" : "you owe"}</span>}
        </span>
        <span aria-hidden className="text-mut2 text-[13px] flex-none">›</span>
      </Link>
    </li>
  );
}
