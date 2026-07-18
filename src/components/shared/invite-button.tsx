"use client";

import { useState } from "react";
import { createInvitationAction } from "@/app/actions";
import { useUI } from "@/components/shell/ui-context";

export function InviteButton({ participantId }: { participantId: string }) {
  const { showToast } = useUI();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    const trimmed = email.trim();
    if (!trimmed) {
      showToast("Enter the email you're inviting");
      return;
    }
    setBusy(true);
    const res = await createInvitationAction(participantId, trimmed);
    setBusy(false);
    if (!res.ok) {
      showToast(res.error);
      return;
    }
    const url = `${window.location.origin}/invite/${res.token}`;
    await navigator.clipboard.writeText(url);
    showToast(`Invite link copied — share it with ${trimmed}`);
    setOpen(false);
    setEmail("");
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-[11px] py-1.5 rounded-lg border border-line2 text-[11.5px] font-semibold text-acc cursor-pointer bg-transparent hover:bg-accsoft"
      >
        Invite
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 flex items-center gap-1.5 rounded-lg border border-line2 bg-card p-1.5 shadow-lg">
          <input
            autoFocus
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
              if (e.key === "Escape") setOpen(false);
            }}
            placeholder="their email"
            className="w-[160px] px-2 py-1 rounded-md border border-line2 bg-transparent text-[12px] outline-none"
          />
          <button
            disabled={busy}
            onClick={send}
            className="px-2 py-1 rounded-md bg-acc text-white text-[11.5px] font-semibold cursor-pointer disabled:opacity-60"
          >
            {busy ? "…" : "Send"}
          </button>
          <button onClick={() => setOpen(false)} className="px-1.5 py-1 text-[11.5px] text-mut2 cursor-pointer bg-transparent">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
