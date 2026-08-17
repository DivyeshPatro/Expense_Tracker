"use client";

// The one member picker, shared by "Add member" on a group's page and by the
// Create Group modal.
//
// This is a MOVE, not a new implementation. The group page already had exactly
// the right thing — an "Existing contact / New member" segmented control over a
// searchable list showing phone, a Lending badge and an "In group" state — but
// it was hard-wired to an existing group, so Create Group grew its own thinner
// version (a chip grid plus a barely-visible "＋ New member" button). Both now
// render this component; only what happens on pick differs:
//
//   add-to-group : calls addGroupMemberAction immediately (group already exists)
//   select       : toggles a local selection, submitted when the group is created
//
// Identity rules are unchanged. Picking an existing contact reuses that
// Participant; New member creates exactly one, via the same
// addParticipantAction + updateParticipantDetailsAction pair as before.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { addGroupMemberAction, addParticipantAction, updateParticipantDetailsAction } from "@/app/actions";
import { useUI } from "@/components/shell/ui-context";

export interface PickableContact {
  id: string;
  name: string;
  initial: string;
  color: string;
  phone?: string | null;
  isLending?: boolean;
}

export type MemberPickerMode =
  /** The group exists — picking adds straight away. */
  | { kind: "add-to-group"; groupId: string; memberIds: string[]; onDone: () => void }
  /** No group yet — picking builds a selection the caller submits later. */
  | {
      kind: "select";
      selectedIds: string[];
      onToggle: (contact: PickableContact) => void;
      onCreated: (contact: PickableContact) => void;
      /** Contacts created in this session, not yet in refData. */
      extraContacts?: PickableContact[];
    };

export function MemberPicker({ mode }: { mode: MemberPickerMode }) {
  const [tab, setTab] = useState<"existing" | "new">("existing");
  return (
    <div className="flex flex-col gap-2.5">
      {/* The two choices, given equal weight — this is the decision the user is
          making, so neither option is a secondary button. */}
      <div className="flex gap-1.5 p-1 bg-accsoft rounded-[12px]" role="tablist" aria-label="How to add a member">
        {(["existing", "new"] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={tab === m}
            onClick={() => setTab(m)}
            className={`flex-1 min-h-[44px] rounded-[9px] text-[12.5px] font-bold border-none cursor-pointer transition-colors ${
              tab === m ? "bg-card text-ink shadow-sm" : "bg-transparent text-mut"
            }`}
          >
            {m === "existing" ? "Existing member" : "New member"}
          </button>
        ))}
      </div>
      {tab === "existing" ? <ExistingContacts mode={mode} onEmptySwitch={() => setTab("new")} /> : <NewMember mode={mode} />}
    </div>
  );
}

function ExistingContacts({ mode, onEmptySwitch }: { mode: MemberPickerMode; onEmptySwitch: () => void }) {
  const { refData, showToast } = useUI();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [dupe, setDupe] = useState<string | null>(null);

  // Which ids are already "taken" — members of the group, or already selected.
  const taken = useMemo(
    () => new Set(mode.kind === "add-to-group" ? mode.memberIds : mode.selectedIds),
    [mode]
  );

  const pool: PickableContact[] = useMemo(() => {
    const base: PickableContact[] = refData.participants;
    if (mode.kind !== "select" || !mode.extraContacts?.length) return base;
    return [...base, ...mode.extraContacts.filter((e) => !base.some((b) => b.id === e.id))];
  }, [refData.participants, mode]);

  // Search across ALL contacts — Shared and Lending alike. A Lending contact is
  // a real person you can intentionally add to a group.
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return pool
      .filter((p) => !needle || p.name.toLowerCase().includes(needle) || (p.phone ?? "").includes(needle))
      .sort((a, b) => Number(taken.has(a.id)) - Number(taken.has(b.id)) || a.name.localeCompare(b.name));
  }, [q, pool, taken]);

  async function pick(c: PickableContact) {
    if (mode.kind === "select") {
      // Toggling off is allowed here; a duplicate simply can't happen because
      // the selection is a set.
      mode.onToggle(c);
      return;
    }
    if (taken.has(c.id)) {
      setDupe(c.name);
      return;
    }
    setBusy(c.id);
    const res = await addGroupMemberAction({ groupId: mode.groupId, participantId: c.id });
    setBusy(null);
    if (!res.ok) {
      showToast(res.error ?? "Couldn't add member");
      return;
    }
    showToast(`${c.name} added to the group`);
    router.refresh();
    mode.onDone();
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
        aria-label="Search contacts"
        className="h-11 w-full box-border rounded-[12px] border border-line bg-card px-3.5 text-[13.5px] text-ink outline-none focus:border-acc"
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
        {pool.length === 0 ? (
          <div className="text-[12.5px] text-mut2 px-1 py-6 text-center">
            You don&apos;t have any contacts yet.{" "}
            <button onClick={onEmptySwitch} className="text-acc font-bold bg-transparent border-none cursor-pointer p-0 underline">
              Add a new member
            </button>
            .
          </div>
        ) : results.length === 0 ? (
          <div className="text-[12.5px] text-mut2 px-1 py-6 text-center">
            No contacts match “{q}”.{" "}
            <button onClick={onEmptySwitch} className="text-acc font-bold bg-transparent border-none cursor-pointer p-0 underline">
              Add them as a new member
            </button>
            .
          </div>
        ) : (
          results.map((p) => {
            const already = taken.has(p.id);
            return (
              <button
                key={p.id}
                disabled={busy === p.id}
                onClick={() => pick(p)}
                aria-pressed={mode.kind === "select" ? already : undefined}
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
                {mode.kind === "select" ? (
                  <span
                    className="text-[11.5px] font-bold flex-none"
                    style={{ color: already ? "var(--acc)" : "var(--mut2)" }}
                  >
                    {already ? "✓ Added" : "Add"}
                  </span>
                ) : already ? (
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

function NewMember({ mode }: { mode: MemberPickerMode }) {
  const { showToast } = useUI();
  const router = useRouter();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const displayName = name.trim();
    if (!displayName || busy) return;
    setBusy(true);
    // Exactly one Participant, via the same actions the group page already used.
    const created = await addParticipantAction({ displayName });
    if (!created.ok || !created.participantId) {
      setBusy(false);
      showToast((!created.ok && created.error) || "Couldn't create member");
      return;
    }
    if (phone.trim() || email.trim()) {
      // The result used to be discarded, so a rejected phone/email silently
      // produced a contact missing the details the user had just typed.
      const details = await updateParticipantDetailsAction({
        participantId: created.participantId,
        displayName,
        phone: phone.trim() || null,
        email: email.trim() || null,
      });
      if (!details.ok) showToast(details.error ?? "Saved the member, but not their contact details");
    }
    const contact: PickableContact = {
      id: created.participantId,
      name: displayName,
      initial: displayName.charAt(0).toUpperCase(),
      color: "var(--acc)",
      phone: phone.trim() || null,
      isLending: false,
    };

    if (mode.kind === "select") {
      setBusy(false);
      setName("");
      setPhone("");
      setEmail("");
      mode.onCreated(contact);
      return;
    }

    // isNew flags the audit event as "New member created" rather than "linked".
    const added = await addGroupMemberAction({ groupId: mode.groupId, participantId: created.participantId, isNew: true });
    setBusy(false);
    if (!added.ok) {
      showToast(added.error ?? "Couldn't add member");
      return;
    }
    showToast(`${displayName} added to the group`);
    router.refresh();
    mode.onDone();
  }

  return (
    <div className="flex flex-col gap-2.5">
      <TextField label="Name" value={name} onChange={setName} placeholder="e.g. Priya Sharma" autoFocus />
      <TextField label="Phone" value={phone} onChange={setPhone} placeholder="Optional" type="tel" />
      <TextField label="Email" value={email} onChange={setEmail} placeholder="Optional" type="email" />
      <button
        onClick={submit}
        disabled={!name.trim() || busy}
        className="mt-1 min-h-[44px] rounded-[12px] text-[13px] font-bold text-white bg-acc border-none cursor-pointer disabled:opacity-50"
      >
        {busy ? "Adding…" : mode.kind === "select" ? "Add to group" : "Add member"}
      </button>
    </div>
  );
}

function TextField({
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
        className="h-11 w-full box-border rounded-[12px] border border-line bg-card px-3.5 text-[13.5px] text-ink outline-none focus:border-acc"
      />
    </label>
  );
}
