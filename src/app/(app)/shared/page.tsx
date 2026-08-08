import Link from "next/link";
import { OpenModalButton } from "@/components/shell/buttons";
import { GroupsPanel } from "@/components/shared/groups-panel";
import { InviteButton } from "@/components/shared/invite-button";
import { ModuleActivity } from "@/components/shell/module-activity";
import { EmptyState } from "@/components/shell/empty-state";
import { ModuleHero } from "@/components/shell/module-hero";
import { friendlyDay, toYMD } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { txDisplay } from "@/lib/tx-display";
import { loadLedger } from "@/server/services/ledger";
import { listGroups } from "@/server/services/groups";
import { settlementHistory, sharedSummary } from "@/server/services/shared";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function SharedPage() {
  const user = await requireUser();
  const [summary, history, groups, rows] = await Promise.all([
    sharedSummary(user.id),
    settlementHistory(user.id),
    listGroups(user.id),
    loadLedger(user.id, 6),
  ]);
  // #188: the screen's primary question is "who needs to settle?", so that
  // count — not a stat-card row — is the hero.
  const toSettle = summary.members.filter((m) => Math.abs(m.net) > 100).length;
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

  const sharedTx = rows
    .filter((r) => r.split)
    .map((r) => {
      const d = txDisplay(r);
      const payer = r.split!.paidByMe ? "you paid" : `paid by ${r.split!.payerName}`;
      return { ...d, meta: `${friendlyDay(r.ymd)} · ${payer} · split ${r.split!.partCount} ways`, shareF: formatPaise(r.split!.myShare) };
    });

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      {/* #188: the screen answers "who needs to settle?" first. The old header
          led with ＋ Add split expense (the largest element on the screen) above
          three equal-weight stat cards that gave the eye nothing to land on.
          Adding a split expense is the FAB's job. */}
      <ModuleHero
        eyebrow={toSettle > 0 ? "To settle up" : "All settled"}
        value={toSettle > 0 ? `${toSettle} ${toSettle === 1 ? "person" : "people"}` : "✓"}
        valueColor={toSettle > 0 ? undefined : "var(--green)"}
        sub={settleSub}
        tone={toSettle > 0 ? "warn" : "good"}
        secondary={[
          { label: "You'll get", value: formatPaise(summary.owedToYou), color: summary.owedToYou > 0 ? "var(--green)" : undefined },
          { label: "You'll pay", value: formatPaise(summary.youOwe), color: summary.youOwe > 0 ? "var(--red)" : undefined },
          {
            label: "Net",
            value: `${summary.net < 0 ? "−" : "+"}${formatPaise(Math.abs(summary.net))}`,
            color: summary.net < 0 ? "var(--red)" : "var(--green)",
          },
        ]}
      />

      <div className="flex items-center gap-2 text-[12.5px] font-semibold text-mut flex-wrap">
        <GroupsPanel groups={groups} />
        <OpenModalButton
          type="friend"
          className="text-[12px] font-semibold text-acc cursor-pointer px-3 min-h-[44px] rounded-[9px] bg-transparent border border-line2 hover:bg-accsoft"
        >
          ＋ Add friend
        </OpenModalButton>
      </div>

      <div className="flex flex-wrap gap-3.5 items-start">
        <section className="card flex-[1_1_300px] p-[var(--pad)] flex flex-col gap-[13px]">
          <h2 className="text-[13.5px] font-bold m-0">Balances</h2>
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
          {summary.members.map((m) => {
            const owed = Math.abs(m.net) > 100;
            return (
              <div key={m.id} className="flex items-center gap-[11px]">
                {/* Phase 2.5 cross-navigation: name+avatar open this friend's Lending contact */}
                <Link href={`/lending?contact=${m.id}`} className="flex items-center gap-[11px] flex-1 min-w-0 no-underline text-ink hover:opacity-80">
                  <div className="w-9 h-9 rounded-full grid place-items-center text-[13px] font-bold text-white flex-none" style={{ background: m.color }}>{m.initial}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-bold truncate">{m.name}</div>
                    <div className="text-[11.5px] text-mut2">{m.net > 100 ? "will pay you" : m.net < -100 ? "you'll pay" : "all settled"}</div>
                  </div>
                </Link>
                <div className="text-[13px] font-extrabold" style={{ color: m.net > 100 ? "var(--green)" : m.net < -100 ? "var(--red)" : "var(--mut2)" }}>
                  {owed ? formatPaise(m.net) : "—"}
                </div>
                {owed && (
                  <OpenModalButton
                    type="settle"
                    prefill={{
                      participantId: m.id,
                      participantName: m.name,
                      direction: m.net > 0 ? "TO_OWNER" : "FROM_OWNER",
                      amountRupees: String(Math.round(Math.abs(m.net) / 100)),
                      settleNetPaise: m.net,
                    }}
                    className="px-[11px] py-1.5 rounded-lg border border-line2 text-[11.5px] font-semibold text-acc cursor-pointer bg-transparent hover:bg-accsoft"
                  >
                    Settle
                  </OpenModalButton>
                )}
                {!m.linkedUserId && <InviteButton participantId={m.id} />}
              </div>
            );
          })}
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

        <section className="card flex-[1.3_1_320px] px-4 py-1.5">
          <h2 className="text-[13.5px] font-bold pt-3 pb-1.5 m-0">Shared expenses</h2>
          {sharedTx.length === 0 && <div className="text-[12px] text-mut2 py-4">No shared expenses yet — add one and split it.</div>}
          {sharedTx.map((t) => (
            <div key={t.id} className="flex items-center gap-3 py-[11px] border-b border-line last:border-b-0">
              <div className="w-9 h-9 rounded-[11px] grid place-items-center text-[15px] flex-none" style={{ background: t.iconBg }}>{t.icon}</div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold truncate">{t.name}</div>
                <div className="text-[11.5px] text-mut2 truncate">{t.meta}</div>
              </div>
              <div className="text-right">
                <div className="text-[13px] font-bold">{t.amtF.replace("−", "")}</div>
                <div className="text-[11px] text-mut2">your share {t.shareF}</div>
              </div>
            </div>
          ))}
        </section>
      </div>
      <ModuleActivity entities={["Settlement"]} />
    </div>
  );
}
