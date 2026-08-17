"use client";

// Group Dashboard quick actions (v2.0). Every action reuses an existing flow:
// Add Expense opens the split-expense modal pre-targeted at this group; Settle
// Up opens the settle modal pre-filled for a chosen member; Add Member reuses
// addGroupMemberAction; Export hits the group-statement XLSX route. No new
// mutation logic lives here.

import { useState } from "react";
import { MemberPicker } from "@/components/shared/member-picker";
import { BottomSheet } from "@/components/shell/bottom-sheet";
import { useUI } from "@/components/shell/ui-context";
import { formatPaise } from "@/lib/money";
import { balanceState } from "@/lib/group-dashboard";

export interface SettleTarget {
  participantId: string;
  name: string;
  net: number; // >0 they owe you, <0 you owe them
}

export function GroupQuickActions({
  groupId,
  memberIds,
  settleTargets,
  canRecordSettlements,
}: {
  groupId: string;
  memberIds: string[];
  settleTargets: SettleTarget[];
  /** Only the group's owner can record a settlement, so for anyone else this
   *  action is hidden rather than shown and then rejected on submit. */
  canRecordSettlements: boolean;
}) {
  const { openModal } = useUI();
  const [sheet, setSheet] = useState<null | "settle" | "member">(null);

  return (
    <>
      <div className={`grid gap-2.5 ${canRecordSettlements ? "grid-cols-4" : "grid-cols-3"}`}>
        <ActionButton label="Add expense" tint="acc" onClick={() => openModal("exp", { split: true, dupGroupId: groupId })} d="M12 5v14M5 12h14" />
        {canRecordSettlements && (
          <ActionButton label="Settle up" tint="green" onClick={() => setSheet("settle")} d="M7 17 17 7M8 7h9v9" />
        )}
        <ActionButton label="Add member" tint="amber" onClick={() => setSheet("member")} d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M19 8v6M22 11h-6" />
        <ActionLink label="Export" tint="acc" href={`/api/export/group-statement?group=${groupId}`} d="M12 3v12M8 11l4 4 4-4M4 21h16" />
      </div>

      {sheet === "settle" && (
        <SettleSheet
          targets={settleTargets}
          onPick={(t) => {
            setSheet(null);
            openModal("settle", {
              participantId: t.participantId,
              participantName: t.name,
              direction: t.net > 0 ? "TO_OWNER" : "FROM_OWNER",
              amountRupees: String(Math.round(Math.abs(t.net) / 100)),
              settleNetPaise: t.net,
              settleGroupId: groupId,
            });
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "member" && <AddMemberSheet groupId={groupId} memberIds={memberIds} onClose={() => setSheet(null)} />}
    </>
  );
}

function ActionButton({ label, tint, d, onClick }: { label: string; tint: string; d: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="border border-line bg-card rounded-2xl py-3 flex flex-col items-center gap-[7px] cursor-pointer active:scale-95 transition-transform min-h-[64px]"
    >
      <span className="w-[38px] h-[38px] rounded-xl grid place-items-center" style={{ background: `var(--${tint}Soft)`, color: `var(--${tint})` }}>
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
      </span>
      <span className="text-[11px] font-semibold text-mut">{label}</span>
    </button>
  );
}

function ActionLink({ label, tint, d, href }: { label: string; tint: string; d: string; href: string }) {
  return (
    <a
      href={href}
      className="border border-line bg-card rounded-2xl py-3 flex flex-col items-center gap-[7px] cursor-pointer active:scale-95 transition-transform min-h-[64px] no-underline"
    >
      <span className="w-[38px] h-[38px] rounded-xl grid place-items-center" style={{ background: `var(--${tint}Soft)`, color: `var(--${tint})` }}>
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
      </span>
      <span className="text-[11px] font-semibold text-mut">{label}</span>
    </a>
  );
}

function SettleSheet({ targets, onPick, onClose }: { targets: SettleTarget[]; onPick: (t: SettleTarget) => void; onClose: () => void }) {
  const outstanding = targets.filter((t) => balanceState(t.net) !== "settled");
  return (
    <BottomSheet onClose={onClose} label="Settle up" maxWidth={420} className="gap-1">
      <h2 className="text-[13px] font-bold text-mut2 uppercase tracking-wide px-1 pb-1">Settle up with…</h2>
      {outstanding.length === 0 ? (
        <div className="text-[12.5px] text-mut2 px-1 py-3 text-center">Everyone in this group is settled up. 🎉</div>
      ) : (
        outstanding.map((t) => {
          const owesYou = t.net > 0;
          return (
            <button
              key={t.participantId}
              onClick={() => onPick(t)}
              className="flex items-center justify-between gap-3 min-h-[52px] px-2 py-2 rounded-[11px] cursor-pointer bg-transparent border-none hover:bg-accsoft text-left"
            >
              <span className="text-[13.5px] font-semibold text-ink">{t.name}</span>
              <span className="text-[12.5px] font-bold" style={{ color: owesYou ? "var(--green)" : "var(--red)" }}>
                {owesYou ? "will pay you " : "you'll pay "}
                {formatPaise(Math.abs(t.net))}
              </span>
            </button>
          );
        })
      )}
    </BottomSheet>
  );
}

function AddMemberSheet({ groupId, memberIds, onClose }: { groupId: string; memberIds: string[]; onClose: () => void }) {
  // The picker itself now lives in components/shared/member-picker so the
  // Create Group modal renders the identical control instead of its own.
  return (
    <BottomSheet onClose={onClose} label="Add member" maxWidth={420} className="gap-2.5">
      <MemberPicker mode={{ kind: "add-to-group", groupId, memberIds, onDone: onClose }} />
    </BottomSheet>
  );
}
