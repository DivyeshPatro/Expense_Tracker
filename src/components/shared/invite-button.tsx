"use client";

import { useState } from "react";
import { createInvitationAction } from "@/app/actions";
import { useUI } from "@/components/shell/ui-context";

export function InviteButton({ participantId }: { participantId: string }) {
  const { showToast } = useUI();
  const [busy, setBusy] = useState(false);

  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const res = await createInvitationAction(participantId);
        setBusy(false);
        if (!res.ok) {
          showToast(res.error);
          return;
        }
        const url = `${window.location.origin}/invite/${res.token}`;
        await navigator.clipboard.writeText(url);
        showToast("Invite link copied");
      }}
      className="px-[11px] py-1.5 rounded-lg border border-line2 text-[11.5px] font-semibold text-acc cursor-pointer bg-transparent hover:bg-accsoft disabled:opacity-60"
    >
      {busy ? "…" : "Invite"}
    </button>
  );
}
