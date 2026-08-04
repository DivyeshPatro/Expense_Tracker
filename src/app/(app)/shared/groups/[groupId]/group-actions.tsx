"use client";

// Group Dashboard quick actions (v2.0). Every action reuses an existing flow:
// Add Expense opens the split-expense modal pre-targeted at this group; Settle
// Up opens the settle modal pre-filled for a chosen member; Add Member reuses
// addGroupMemberAction; Export hits the group-statement XLSX route. No new
// mutation logic lives here.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { addGroupMemberAction, addParticipantAction, updateParticipantDetailsAction } from "@/app/actions";
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
  const { refData, showToast } = useUI();
  const router = useRouter();
  const [mode, setMode] = useState<"existing" | "new">("existing");

  return (
    <BottomSheet onClose={onClose} label="Add member" maxWidth={420} className="gap-2.5">
      <div className="flex gap-1.5 p-1 bg-accsoft rounded-[12px]">
        {(["existing", "new"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 h-9 rounded-[9px] text-[12.5px] font-bold border-none cursor-pointer transition-colors ${
              mode === m ? "bg-card text-ink shadow-sm" : "bg-transparent text-mut"
            }`}
          >
            {m === "existing" ? "Existing contact" : "New member"}
          </button>
        ))}
      </div>
      {mode === "existing" ? (
        <ExistingContactPicker groupId={groupId} memberIds={memberIds} refData={refData} showToast={showToast} router={router} onDone={onClose} />
      ) : (
        <NewMemberForm groupId={groupId} showToast={showToast} router={router} onDone={onClose} />
      )}
    </BottomSheet>
  );
}

type Router = ReturnType<typeof useRouter>;
type RefData = ReturnType<typeof useUI>["refData"];

function ExistingContactPicker({
  groupId,
  memberIds,
  refData,
  showToast,
  router,
  onDone,
}: {
  groupId: string;
  memberIds: string[];
  refData: RefData;
  showToast: (msg: string) => void;
  router: Router;
  onDone: () => void;
}) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [dupe, setDupe] = useState<string | null>(null);
  const inGroup = useMemo(() => new Set(memberIds), [memberIds]);

  // Search across ALL contacts — Shared and Lending alike. A Lending contact is
  // a real person you can intentionally add to a group; only the duplicate check
  // keeps them from being added twice.
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return refData.participants
      .filter((p) => !needle || p.name.toLowerCase().includes(needle) || (p.phone ?? "").includes(needle))
      .sort((a, b) => Number(inGroup.has(a.id)) - Number(inGroup.has(b.id)) || a.name.localeCompare(b.name));
  }, [q, refData.participants, inGroup]);

  async function add(participantId: string, name: string) {
    if (inGroup.has(participantId)) {
      setDupe(name);
      return;
    }
    setBusy(participantId);
    const res = await addGroupMemberAction({ groupId, participantId });
    setBusy(null);
    if (!res.ok) {
      showToast(res.error ?? "Couldn't add member");
      return;
    }
    showToast(`${name} added to the group`);
    router.refresh();
    onDone();
  }

  return (
    <>
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setDupe(null);
        }}
        autoFocus
        placeholder="Search contacts by name or phone"
        className="h-11 w-full rounded-[12px] border border-line bg-card px-3.5 text-[13.5px] text-ink outline-none focus:border-acc"
      />
      {dupe && (
        <div className="flex items-center justify-between gap-2 rounded-[12px] bg-ambersoft px-3 py-2.5">
          <span className="text-[12.5px] font-semibold text-amber">{dupe} is already a member.</span>
          <button onClick={() => setDupe(null)} className="text-[12px] font-bold text-mut bg-transparent border-none cursor-pointer">
            Dismiss
          </button>
        </div>
      )}
      <div className="flex flex-col max-h-[46vh] overflow-y-auto -mx-1 px-1">
        {results.length === 0 ? (
          <div className="text-[12.5px] text-mut2 px-1 py-6 text-center">No contacts match “{q}”. Try New member instead.</div>
        ) : (
          results.map((p) => {
            const already = inGroup.has(p.id);
            return (
              <button
                key={p.id}
                disabled={busy === p.id}
                onClick={() => add(p.id, p.name)}
                className="flex items-center gap-3 min-h-[54px] px-2 py-2 rounded-[11px] cursor-pointer bg-transparent border-none hover:bg-accsoft text-left disabled:opacity-50"
              >
                <span className="w-9 h-9 rounded-full grid place-items-center text-[12px] font-bold text-white flex-none" style={{ background: p.color }}>
                  {p.initial}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="text-[13.5px] font-semibold text-ink truncate">{p.name}</span>
                    {p.isLending && (
                      <span className="text-[9.5px] font-bold uppercase tracking-wide text-acc bg-accsoft rounded px-1.5 py-0.5 flex-none">Lending</span>
                    )}
                  </span>
                  {p.phone && <span className="block text-[11.5px] text-mut2 truncate">{p.phone}</span>}
                </span>
                {already ? (
                  <span className="text-[11px] font-semibold text-mut2 flex-none">In group</span>
                ) : (
                  <span className="text-[11.5px] font-bold text-acc flex-none">{busy === p.id ? "…" : "Add"}</span>
                )}
              </button>
            );
          })
        )}
      </div>
    </>
  );
}

function NewMemberForm({
  groupId,
  showToast,
  router,
  onDone,
}: {
  groupId: string;
  showToast: (msg: string) => void;
  router: Router;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const displayName = name.trim();
    if (!displayName || busy) return;
    setBusy(true);
    // Create the contact, attach optional phone/email, then add to the group as
    // a brand-new member (isNew flags the audit event as "New member created").
    const created = await addParticipantAction({ displayName });
    if (!created.ok) {
      setBusy(false);
      showToast(created.error ?? "Couldn't create member");
      return;
    }
    if (!created.participantId) {
      setBusy(false);
      showToast("Couldn't create member");
      return;
    }
    if (phone.trim() || email.trim()) {
      await updateParticipantDetailsAction({
        participantId: created.participantId,
        phone: phone.trim() || null,
        email: email.trim() || null,
      });
    }
    const added = await addGroupMemberAction({ groupId, participantId: created.participantId, isNew: true });
    setBusy(false);
    if (!added.ok) {
      showToast(added.error ?? "Couldn't add member");
      return;
    }
    showToast(`${displayName} added to the group`);
    router.refresh();
    onDone();
  }

  return (
    <div className="flex flex-col gap-2.5">
      <Field label="Name" value={name} onChange={setName} placeholder="e.g. Priya Sharma" autoFocus />
      <Field label="Phone" value={phone} onChange={setPhone} placeholder="Optional" type="tel" />
      <Field label="Email" value={email} onChange={setEmail} placeholder="Optional" type="email" />
      <button
        onClick={submit}
        disabled={!name.trim() || busy}
        className="mt-1 h-11 rounded-[12px] text-[13px] font-bold text-white bg-acc border-none cursor-pointer disabled:opacity-50"
      >
        {busy ? "Adding…" : "Add member"}
      </button>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  autoFocus?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-bold uppercase tracking-wide text-mut2 px-1">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        type={type}
        autoFocus={autoFocus}
        className="h-11 w-full rounded-[12px] border border-line bg-card px-3.5 text-[13.5px] text-ink outline-none focus:border-acc"
      />
    </label>
  );
}
