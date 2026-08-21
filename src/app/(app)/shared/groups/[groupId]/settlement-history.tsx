"use client";

// Settlement history for the Group Dashboard (v2.0 P3). Month-grouped cards with
// the full detail (who → whom, amount, method, date, note) and inline delete
// (audited via deleteSettlementAction). Pagination reuses the "show more" reveal
// used elsewhere; the empty state matches the app's shared EmptyState.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deleteSettlementAction } from "@/app/actions";
import { EmptyState } from "@/components/shell/empty-state";
import { useUI } from "@/components/shell/ui-context";
import { friendlyDay, MONTH_NAMES } from "@/lib/dates";
import { formatPaise } from "@/lib/money";

export interface SettlementRow {
  id: string;
  participantName: string;
  /** null on a member↔member row, where neither end is the owner. */
  direction: "TO_OWNER" | "FROM_OWNER" | null;
  /** null means the owner. */
  fromName: string | null;
  toName: string | null;
  amount: number;
  method: string;
  note: string | null;
  settledAt: string; // ISO
}

const PAGE = 8;

export function SettlementHistory({
  settlements,
  ownerName,
  canManage,
}: {
  settlements: SettlementRow[];
  /** Who the settlements are filed under, for readers who aren't them. */
  ownerName: string;
  /** deleteSettlement() scopes by userId, so only the owner can remove one —
   *  everyone else reads the history without a delete control. */
  canManage: boolean;
}) {
  const [visible, setVisible] = useState(PAGE);
  if (settlements.length === 0) {
    return (
      <section className="card p-[var(--pad)]">
        <h2 className="text-[13.5px] font-bold m-0 mb-1.5">Settlement history</h2>
        <EmptyState icon="🤝" title="No settlements yet" detail="When someone pays you back — or you pay them — record it and it shows here." compact />
      </section>
    );
  }

  const shown = settlements.slice(0, visible);
  // group consecutive rows by month (settlements arrive newest-first)
  const months: { key: string; label: string; rows: SettlementRow[] }[] = [];
  for (const s of shown) {
    const key = s.settledAt.slice(0, 7);
    const last = months[months.length - 1];
    if (last?.key === key) last.rows.push(s);
    else months.push({ key, label: `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`, rows: [s] });
  }

  return (
    <section className="card p-[var(--pad)] flex flex-col gap-2">
      <h2 className="text-[13.5px] font-bold m-0">Settlement history</h2>
      {months.map((m) => (
        <div key={m.key} className="flex flex-col gap-1.5">
          <div className="text-[11px] font-bold text-mut2 uppercase tracking-wide mt-1">{m.label}</div>
          {m.rows.map((s) => (
            <SettlementCard key={s.id} s={s} ownerName={ownerName} canManage={canManage} />
          ))}
        </div>
      ))}
      {visible < settlements.length && (
        <button
          onClick={() => setVisible((v) => v + PAGE)}
          className="mt-1 p-2 rounded-lg text-[12px] font-semibold text-acc text-center cursor-pointer border border-line2 bg-transparent hover:bg-accsoft"
        >
          Show more ({settlements.length - visible} older)
        </button>
      )}
    </section>
  );
}

function SettlementCard({ s, ownerName, canManage }: { s: SettlementRow; ownerName: string; canManage: boolean }) {
  const router = useRouter();
  const { showToast } = useUI();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // "Cara paid you" is only true for the owner. To another member it is
  // "Cara paid Olivia Owner" — the same money, correctly attributed. And a
  // payment between two members names both, since the owner is not in it.
  const who = (name: string | null) => (name === null ? (canManage ? "you" : ownerName) : name);
  // Money coming toward the owner reads green, money leaving reads red. A
  // payment between two members moves neither way for the viewer, so it takes
  // the neutral treatment rather than borrowing a direction it doesn't have.
  const toOwner = s.direction === "TO_OWNER";
  const ownerInvolved = s.direction !== null;
  const tone = !ownerInvolved ? "var(--mut2)" : toOwner ? "var(--green)" : "var(--red)";
  const toneSoft = !ownerInvolved ? "var(--accSoft)" : toOwner ? "var(--greenSoft)" : "var(--redSoft)";
  const glyph = !ownerInvolved ? "⇄" : toOwner ? "↘" : "↗";
  const line =
    s.direction === "TO_OWNER"
      ? `${s.participantName} paid ${canManage ? "you" : ownerName}`
      : s.direction === "FROM_OWNER"
        ? `${canManage ? "You" : ownerName} paid ${s.participantName}`
        : `${who(s.fromName)} paid ${who(s.toName)}`;

  async function del() {
    setBusy(true);
    const res = await deleteSettlementAction(s.id);
    setBusy(false);
    if (!res.ok) {
      showToast(res.error ?? "Couldn't delete");
      return;
    }
    showToast("Settlement removed");
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2.5 py-2 border-b border-line last:border-b-0">
      <span
        className="w-8 h-8 rounded-[10px] grid place-items-center text-[13px] flex-none"
        style={{ background: toneSoft }}
        aria-hidden
      >
        {glyph}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-semibold truncate">{line}</div>
        <div className="text-[11px] text-mut2 truncate">
          {friendlyDay(s.settledAt.slice(0, 10))} · {s.method}
          {s.note ? ` · ${s.note}` : ""}
        </div>
      </div>
      <span className="text-[13px] font-bold tabular-nums flex-none" style={{ color: tone }}>
        {formatPaise(s.amount)}
      </span>
      {!canManage ? null : confirming ? (
        <span className="flex items-center gap-1 flex-none">
          <button
            onClick={del}
            disabled={busy}
            className="px-2 py-1 rounded-md text-[11px] font-bold text-white bg-red border-none cursor-pointer disabled:opacity-60"
          >
            {busy ? "…" : "Delete"}
          </button>
          <button onClick={() => setConfirming(false)} className="px-2 py-1 rounded-md text-[11px] font-semibold text-mut2 bg-transparent border-none cursor-pointer">
            Keep
          </button>
        </span>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          aria-label={`Delete settlement: ${line} ${formatPaise(s.amount)}`}
          className="w-9 h-9 rounded-md grid place-items-center text-mut2 bg-transparent border-none cursor-pointer hover:text-red hover:bg-redsoft flex-none"
        >
          ✕
        </button>
      )}
    </div>
  );
}
