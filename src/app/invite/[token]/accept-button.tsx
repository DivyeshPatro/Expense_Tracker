"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { acceptInvitationAction } from "@/app/actions";

export function AcceptInviteButton({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-2">
      {error && <div className="text-[12.5px] font-semibold text-red bg-redsoft rounded-lg px-3 py-2">{error}</div>}
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const res = await acceptInvitationAction(token);
          setBusy(false);
          if (!res.ok) {
            setError(res.error);
            return;
          }
          router.push("/shared");
          router.refresh();
        }}
        className="btn-primary disabled:opacity-60"
      >
        {busy ? "…" : "Accept invite"}
      </button>
    </div>
  );
}
