"use client";

// Offline-sync Phase 1 (spec §9): the hero balance includes pending intents
// — the user's mental model is "I spent it, it's gone" — with the footnote
// as the entire explanation. Display-only paise addition over the outbox;
// disputed (needs-attention) money is never counted. `live` is false when
// the header period picker shows a past period, where "now"-pending deltas
// don't belong.

import { formatPaise } from "@/lib/money";
import { pendingTotalDelta } from "@/lib/offline/db";
import { useOffline } from "@/components/shell/offline-context";

export function LiveBalance({ basePaise, live }: { basePaise: number; live: boolean }) {
  const { pending } = useOffline();
  const delta = live ? pendingTotalDelta(pending) : 0;
  const value = basePaise + delta;
  const count = live ? pending.length : 0;
  return (
    <>
      <div className="text-[28px] font-extrabold tracking-tight mt-[5px]">
        {value < 0 ? "−" : ""}
        {formatPaise(value)}
      </div>
      {count > 0 && (
        <div className="text-[10.5px] mt-1 opacity-75">
          ⏳ includes {count} unsynced change{count === 1 ? "" : "s"}
        </div>
      )}
    </>
  );
}
