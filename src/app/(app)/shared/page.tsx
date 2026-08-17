import Link from "next/link";
import { OpenModalButton } from "@/components/shell/buttons";
import { GroupCards } from "@/components/shared/group-cards";
import { InviteButton } from "@/components/shared/invite-button";
import { ModuleTabs, SHARED_TABS } from "@/components/shell/module-tabs";
import { EmptyState } from "@/components/shell/empty-state";
import { friendlyDay, toYMD } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { listGroupSummaries } from "@/server/services/group-dashboard";
import { settlementHistory, sharedSummary } from "@/server/services/shared";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export const metadata = { title: "Shared" };

export default async function SharedPage() {
  const user = await requireUser();
  const [summary, history, groupSummaries] = await Promise.all([
    sharedSummary(user.id),
    settlementHistory(user.id),
    listGroupSummaries(user.id),
  ]);
  // #188: the screen's primary question is "who needs to settle?", so that
  // count — not a stat-card row — is the hero.
  const toSettle = summary.members.filter((m) => Math.abs(m.net) > 100).length;
  const settledMembers = summary.members.filter((m) => Math.abs(m.net) <= 100);
  const settleSub =
    toSettle === 0
      ? summary.members.length > 0
        ? "Everyone's square"
        : "Add a friend to start splitting"
      : summary.members
          .filter((m) => Math.abs(m.net) > 100)
          .slice(0, 3)
          .map((m) => m.name)
          .join(", ") + (toSettle > 3 ? ` +${toSettle - 3} more` : "");

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      <ModuleTabs tabs={SHARED_TABS} />
      {/* #188 made the "who needs to settle?" count this screen's hero — right
          at the time, when the screen was a flat expense list. Now that groups
          are the primary object, a 34px figure plus a three-stat rule pushed
          the first group card to y=767 on an 844px phone: the thing the screen
          is *for* started below the fold, and it restated what the cards and
          the per-person list already say.
          It is a compact strip instead. The totals still earn their place —
          they span every group AND one-off splits, so they are not derivable
          from the cards — but they no longer outrank them. */}
      <section className="card px-4 py-3 flex items-center gap-x-5 gap-y-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span
            aria-hidden
            className="w-2 h-2 rounded-full flex-none"
            style={{ background: toSettle > 0 ? "var(--amber)" : "var(--green)" }}
          />
          <span className="text-[12.5px] font-bold truncate">
            {toSettle > 0 ? `${toSettle} ${toSettle === 1 ? "person" : "people"} to settle up` : "All settled"}
          </span>
          <span className="text-[11.5px] text-mut2 truncate hidden sm:inline">· {settleSub}</span>
        </div>
        <div className="flex items-center gap-x-5 gap-y-1 flex-wrap ml-auto">
          <HeroFigure label="You'll get" value={formatPaise(summary.owedToYou)} color={summary.owedToYou > 0 ? "var(--green)" : undefined} />
          <HeroFigure label="You'll pay" value={formatPaise(summary.youOwe)} color={summary.youOwe > 0 ? "var(--red)" : undefined} />
          <HeroFigure
            label="Net"
            value={`${summary.net < 0 ? "−" : "+"}${formatPaise(Math.abs(summary.net))}`}
            color={summary.net < 0 ? "var(--red)" : "var(--green)"}
          />
        </div>
      </section>

      {/* v2.1: GROUPS ARE THE PRIMARY OBJECT.
          They used to be a row of chips above a flat list of every shared
          expense — which is backwards, because a split belongs to a trip or a
          flat, and that context is how people look for it. The flat list is
          gone from this screen entirely; each group now carries its own
          expenses, reachable one tap in. */}
      <section className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-[13.5px] font-bold m-0">Groups</h2>
          {/* Just the two create actions. The per-group chips that used to sit
              here listed every group a second time, directly above the cards —
              renaming/deleting a group now lives on that group's own page. */}
          <div className="flex items-center gap-2">
            <OpenModalButton
              type="group"
              className="text-[12px] font-semibold text-acc cursor-pointer px-3 min-h-[44px] rounded-[9px] bg-transparent border border-line2 hover:bg-accsoft"
            >
              ＋ New group
            </OpenModalButton>
            <OpenModalButton
              type="friend"
              className="text-[12px] font-semibold text-acc cursor-pointer px-3 min-h-[44px] rounded-[9px] bg-transparent border border-line2 hover:bg-accsoft"
            >
              ＋ Add friend
            </OpenModalButton>
          </div>
        </div>
        {groupSummaries.length === 0 ? (
          <EmptyState
            icon="🏠"
            title="Make a group for your next trip"
            detail="A group keeps a trip, a flat or a lunch together — its expenses, who owes whom, and what's left to settle."
            compact
            action={
              <OpenModalButton type="group" className="btn-primary">
                ＋ New group
              </OpenModalButton>
            }
          />
        ) : (
          <GroupCards groups={groupSummaries} />
        )}
      </section>

      <div className="flex flex-wrap gap-3.5 items-start">
        <section className="card flex-[1_1_300px] p-[var(--pad)] flex flex-col gap-[13px]">
          <h2 className="text-[13.5px] font-bold m-0">Balances by person</h2>
          <p className="text-[11.5px] text-mut2 m-0 -mt-2">Across every group and one-off split.</p>
          {summary.members.length === 0 && (
            <EmptyState
              icon="👥"
              title="Split your first bill"
              detail="Add the people you share costs with, then split an expense in a couple of taps — Ledgerly tracks who owes whom."
              compact
              action={
                <OpenModalButton type="friend" className="btn-primary">
                  ＋ Add a friend
                </OpenModalButton>
              }
            />
          )}
          {/* #208: this list carried a Settle AND an Invite button on every row
              — 21 sub-44px targets on one screen — and kept fully-settled people
              in it showing a "—". Rows are now a single tap through to the
              person, where the combined balance and one Settle live (#207).
              Settled people fold away. */}
          {summary.members
            .filter((m) => Math.abs(m.net) > 100)
            .map((m) => (
              <Link
                key={m.id}
                href={`/people/${m.id}`}
                className="flex items-center gap-[11px] min-h-[44px] no-underline text-ink -mx-1 px-1 rounded-lg hover:bg-accsoft"
              >
                <div className="w-9 h-9 rounded-full grid place-items-center text-[13px] font-bold text-white flex-none" style={{ background: m.color }}>{m.initial}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-bold truncate">{m.name}</div>
                  <div className="text-[11.5px] text-mut2">{m.net > 0 ? "will pay you" : "you'll pay"}</div>
                </div>
                <div className="text-[13px] font-extrabold tabular-nums" style={{ color: m.net > 0 ? "var(--green)" : "var(--red)" }}>
                  {formatPaise(m.net)}
                </div>
                <span aria-hidden className="text-mut2 text-[13px] flex-none">›</span>
              </Link>
            ))}
          {settledMembers.length > 0 && (
            <details className="group">
              <summary className="list-none cursor-pointer select-none min-h-[44px] flex items-center gap-1.5 text-[12px] font-semibold text-mut2 hover:text-ink">
                <span aria-hidden className="transition-transform group-open:rotate-90 text-[14px] leading-none">›</span>
                Settled up ({settledMembers.length})
              </summary>
              <div className="flex flex-col gap-2 pt-1.5">
                {settledMembers.map((m) => (
                  <Link key={m.id} href={`/people/${m.id}`} className="flex items-center gap-[11px] min-h-[44px] no-underline text-mut -mx-1 px-1 rounded-lg hover:bg-accsoft">
                    <div className="w-7 h-7 rounded-full grid place-items-center text-[11px] font-bold text-white flex-none" style={{ background: m.color }}>{m.initial}</div>
                    <span className="flex-1 text-[12.5px] truncate">{m.name}</span>
                    {!m.linkedUserId && <InviteButton participantId={m.id} />}
                  </Link>
                ))}
              </div>
            </details>
          )}
          <div className="border-t border-line pt-[11px]">
            <div className="text-[11px] font-bold text-mut2 tracking-[.06em] mb-2">SETTLEMENT HISTORY</div>
            {history.length === 0 && <div className="text-[12px] text-mut2 py-1">No settlements yet.</div>}
            {history.map((s) => (
              <div key={s.id} className="flex justify-between text-xs py-1">
                <span className="text-mut">
                  {s.direction === "TO_OWNER" ? `${s.participantName} paid you ` : `You paid ${s.participantName} `}
                  {formatPaise(s.amount)} · {s.method}
                </span>
                <span className="text-mut2">{friendlyDay(toYMD(s.settledAt))}</span>
              </div>
            ))}
          </div>
        </section>

      </div>
    </div>
  );
}

/** One figure in the compact Shared summary strip. */
function HeroFigure({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[9.5px] font-bold uppercase tracking-[.06em] text-mut2">{label}</div>
      <div className="text-[13.5px] font-extrabold tabular-nums" style={color ? { color } : undefined}>
        {value}
      </div>
    </div>
  );
}
