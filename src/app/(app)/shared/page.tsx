import { OpenModalButton } from "@/components/shell/buttons";
import { GroupsPanel } from "@/components/shared/groups-panel";
import { InviteButton } from "@/components/shared/invite-button";
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
  const sharedTx = rows
    .filter((r) => r.split)
    .map((r) => {
      const d = txDisplay(r);
      const payer = r.split!.paidByMe ? "you paid" : `paid by ${r.split!.payerName}`;
      return { ...d, meta: `${friendlyDay(r.ymd)} · ${payer} · split ${r.split!.partCount} ways`, shareF: formatPaise(r.split!.myShare) };
    });

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div className="flex items-center gap-2 text-[12.5px] font-semibold text-mut flex-wrap">
          <GroupsPanel groups={groups} />
          <OpenModalButton type="friend" className="text-[11.5px] font-semibold text-acc cursor-pointer px-[9px] py-1 rounded-[7px] bg-transparent border border-line2 hover:bg-accsoft">
            ＋ Add friend
          </OpenModalButton>
        </div>
        <OpenModalButton type="exp" prefill={{ split: true }} className="btn-primary">👥 Add split expense</OpenModalButton>
      </div>

      <div className="flex flex-wrap gap-3.5">
        <div className="card flex-[1_1_160px] p-[var(--pad)]">
          <div className="text-[11px] text-mut font-semibold tracking-[.06em]">YOU OWE</div>
          <div className="text-[23px] font-extrabold mt-[5px] text-red">{formatPaise(summary.youOwe)}</div>
        </div>
        <div className="card flex-[1_1_160px] p-[var(--pad)]">
          <div className="text-[11px] text-mut font-semibold tracking-[.06em]">OWED TO YOU</div>
          <div className="text-[23px] font-extrabold mt-[5px] text-green">{formatPaise(summary.owedToYou)}</div>
        </div>
        <div className="card flex-[1_1_160px] p-[var(--pad)]">
          <div className="text-[11px] text-mut font-semibold tracking-[.06em]">NET BALANCE</div>
          <div className="text-[23px] font-extrabold mt-[5px]" style={{ color: summary.net < 0 ? "var(--red)" : "var(--green)" }}>
            {summary.net < 0 ? "−" : "+"}{formatPaise(summary.net)}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-3.5 items-start">
        <section className="card flex-[1_1_300px] p-[var(--pad)] flex flex-col gap-[13px]">
          <h2 className="text-[13.5px] font-bold m-0">Balances</h2>
          {summary.members.length === 0 && (
            <div className="text-[12.5px] text-mut2">No friends yet — add one to start splitting.</div>
          )}
          {summary.members.map((m) => {
            const owed = Math.abs(m.net) > 100;
            return (
              <div key={m.id} className="flex items-center gap-[11px]">
                <div className="w-9 h-9 rounded-full grid place-items-center text-[13px] font-bold text-white" style={{ background: m.color }}>{m.initial}</div>
                <div className="flex-1">
                  <div className="text-[13px] font-bold">{m.name}</div>
                  <div className="text-[11.5px] text-mut2">{m.net > 100 ? "owes you" : m.net < -100 ? "you owe" : "settled up"}</div>
                </div>
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
            {history.length === 0 && <div className="text-xs text-mut2 py-1">No settlements yet.</div>}
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
          {sharedTx.length === 0 && <div className="text-[12.5px] text-mut2 py-4">No shared expenses yet — add one and split it.</div>}
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
    </div>
  );
}
