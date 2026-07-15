"use client";

// Group CRUD for the Shared page — replaces the old read-only firstGroup() chip.

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  addGroupMemberAction,
  deleteGroupAction,
  removeGroupMemberAction,
  renameGroupAction,
} from "@/app/actions";
import type { GroupView } from "@/server/services/groups";
import { OpenModalButton } from "@/components/shell/buttons";
import { useUI } from "@/components/shell/ui-context";

export function GroupsPanel({ groups }: { groups: GroupView[] }) {
  const { refData } = useUI();

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {groups.map((g) => (
        <GroupChip key={g.id} group={g} allParticipants={refData.participants} />
      ))}
      <OpenModalButton
        type="group"
        className="text-[11.5px] font-semibold text-acc cursor-pointer px-[9px] py-1 rounded-[7px] bg-transparent border border-line2 hover:bg-accsoft"
      >
        ＋ New group
      </OpenModalButton>
    </div>
  );
}

function GroupChip({
  group,
  allParticipants,
}: {
  group: GroupView;
  allParticipants: { id: string; name: string; initial: string; color: string }[];
}) {
  const { showToast } = useUI();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(group.name);

  const memberIds = new Set(group.members.map((m) => m.participantId));
  const addable = allParticipants.filter((p) => !memberIds.has(p.id));

  async function act(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (!res.ok) showToast(res.error ?? "Failed");
    router.refresh();
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-[11px] py-[5px] rounded-full bg-accsoft text-acc text-[12.5px] font-semibold cursor-pointer border-none"
      >
        🏠 {group.name}
      </button>
      {open && (
        <div
          className="absolute left-0 top-[36px] w-[260px] bg-card border border-line rounded-[12px] p-3 flex flex-col gap-2.5 z-[75]"
          style={{ boxShadow: "var(--shLg)" }}
        >
          <div className="flex gap-1.5">
            <input
              className="field !py-1.5 !text-[12.5px] flex-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                if (name.trim() && name.trim() !== group.name) act(() => renameGroupAction(group.id, name.trim()));
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            {group.members.map((m) => (
              <div key={m.participantId} className="flex items-center gap-2">
                <span className="w-5 h-5 rounded-full grid place-items-center text-[9.5px] font-bold text-white" style={{ background: m.color }}>
                  {m.initial}
                </span>
                <span className="flex-1 text-[12px] font-semibold">{m.name}</span>
                <button
                  disabled={busy}
                  onClick={() => act(() => removeGroupMemberAction({ groupId: group.id, participantId: m.participantId }))}
                  className="text-mut2 bg-transparent border-none cursor-pointer text-xs disabled:opacity-40"
                  aria-label={`Remove ${m.name}`}
                >
                  ✕
                </button>
              </div>
            ))}
            {group.members.length === 0 && <div className="text-[11.5px] text-mut2">No members</div>}
          </div>
          {addable.length > 0 && (
            <select
              disabled={busy}
              value=""
              onChange={(e) => {
                if (e.target.value) act(() => addGroupMemberAction({ groupId: group.id, participantId: e.target.value }));
              }}
              className="field !py-1.5 !text-[12px]"
            >
              <option value="">＋ Add member…</option>
              {addable.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}
          <button
            disabled={busy}
            onClick={() => act(() => deleteGroupAction(group.id))}
            className="text-[11.5px] font-semibold text-red bg-transparent border-none cursor-pointer text-left disabled:opacity-40"
          >
            Delete group
          </button>
        </div>
      )}
    </div>
  );
}
