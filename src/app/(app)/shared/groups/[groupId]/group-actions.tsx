"use client";

// Group Dashboard quick actions (v2.0). Every action reuses an existing flow:
// Add Expense opens the split-expense modal pre-targeted at this group; Settle
// Up opens the settle modal pre-filled for a chosen member; Add Member reuses
// addGroupMemberAction; Export hits the group-statement XLSX route. No new
// mutation logic lives here.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { addGroupMemberAction } from "@/app/actions";
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
}: {
  groupId: string;
  memberIds: string[];
  settleTargets: SettleTarget[];
}) {
  const { openModal } = useUI();
  const [sheet, setSheet] = useState<null | "settle" | "member">(null);

  return (
    <>
      <div className="grid grid-cols-4 gap-2.5">
        <ActionButton label="Add expense" tint="acc" onClick={() => openModal("exp", { split: true, dupGroupId: groupId })} d="M12 5v14M5 12h14" />
        <ActionButton label="Settle up" tint="green" onClick={() => setSheet("settle")} d="M7 17 17 7M8 7h9v9" />
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
                {owesYou ? "owes you " : "you owe "}
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
  const { refData, openModal, showToast } = useUI();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const inGroup = new Set(memberIds);
  // Shared friends not already in the group (Lending-only contacts stay out — #69).
  const addable = refData.participants.filter((p) => !p.lendingOnly && !inGroup.has(p.id));

  async function add(participantId: string) {
    setBusy(participantId);
    const res = await addGroupMemberAction({ groupId, participantId });
    setBusy(null);
    if (!res.ok) {
      showToast(res.error ?? "Couldn't add member");
      return;
    }
    showToast("Member added");
    router.refresh();
    onClose();
  }

  return (
    <BottomSheet onClose={onClose} label="Add member" maxWidth={420} className="gap-1">
      <h2 className="text-[13px] font-bold text-mut2 uppercase tracking-wide px-1 pb-1">Add a friend to this group</h2>
      {addable.length === 0 ? (
        <div className="text-[12.5px] text-mut2 px-1 py-3 text-center">Everyone you split with is already here.</div>
      ) : (
        addable.map((p) => (
          <button
            key={p.id}
            disabled={busy === p.id}
            onClick={() => add(p.id)}
            className="flex items-center gap-3 min-h-[52px] px-2 py-2 rounded-[11px] cursor-pointer bg-transparent border-none hover:bg-accsoft text-left disabled:opacity-50"
          >
            <span className="w-8 h-8 rounded-full grid place-items-center text-[11px] font-bold text-white flex-none" style={{ background: p.color }}>
              {p.initial}
            </span>
            <span className="text-[13.5px] font-semibold text-ink flex-1">{p.name}</span>
            <span className="text-[11.5px] font-bold text-acc">{busy === p.id ? "…" : "Add"}</span>
          </button>
        ))
      )}
      <button
        onClick={() => {
          onClose();
          openModal("friend");
        }}
        className="mt-2 h-11 rounded-[12px] text-[13px] font-bold text-acc bg-accsoft border-none cursor-pointer"
      >
        ＋ New friend
      </button>
    </BottomSheet>
  );
}
