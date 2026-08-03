"use client";

// Smart Settlement Suggestions (v2.0 P3). Surfaces the optimal payment plan the
// backend already computed with minimizeSettlements — no second calculation.
// You-involved rows are recordable via the existing settle modal; member-to-
// member rows are the plan's remaining hops (Splitwise-style), shown for
// information since Ledgerly records settlements against the owner's ledger.
//
// As you settle, the server refreshes and this list shrinks — the header
// re-animates on the new count ("2 payments" → "1 payment" → "All settled 🎉"),
// giving immediate feedback without any client-side balance math.

import { useUI } from "@/components/shell/ui-context";
import { formatPaise } from "@/lib/money";
import type { GroupSuggestion } from "@/server/services/group-dashboard";

export function SettlementSuggestions({ suggestions, groupId }: { suggestions: GroupSuggestion[]; groupId: string }) {
  const { openModal } = useUI();
  const n = suggestions.length;

  return (
    <section className="card p-[var(--pad)] flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[13.5px] font-bold m-0">Settle up smartly</h2>
        {n > 0 && (
          <span
            key={n}
            className="text-[11px] font-bold px-2 py-[3px] rounded-full"
            style={{ background: "var(--accSoft)", color: "var(--acc)", animation: "rise .3s ease" }}
          >
            {n} payment{n === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {n === 0 ? (
        <div key="done" className="text-center py-4" style={{ animation: "rise .35s ease" }}>
          <div className="text-[26px]" aria-hidden>🎉</div>
          <div className="text-[13.5px] font-bold text-ink mt-1">All settled up</div>
          <div className="text-[12px] text-mut2 mt-0.5">No payments needed — everyone in this group is square.</div>
        </div>
      ) : (
        <>
          <p className="text-[12px] text-mut2 m-0">
            You only need <b className="text-ink">{n} payment{n === 1 ? "" : "s"}</b> to clear the whole group.
          </p>
          <div className="flex flex-col gap-2">
            {suggestions.map((s, i) => (
              <div
                key={`${s.fromId}-${s.toId}-${s.amount}`}
                className="flex items-center gap-2.5 p-2.5 rounded-[11px] border border-line2 bg-side"
                style={{ animation: "rise .25s ease" }}
              >
                <span className="w-6 h-6 rounded-full grid place-items-center text-[11px] font-bold text-white flex-none" style={{ background: "var(--acc)" }}>
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0 text-[12.5px] font-semibold truncate">
                  <span className={s.fromId === "me" ? "text-acc" : ""}>{s.fromName}</span>
                  <span className="text-mut2" aria-label="pays"> → </span>
                  <span className={s.toId === "me" ? "text-acc" : ""}>{s.toName}</span>
                </div>
                <span className="text-[13px] font-extrabold tabular-nums flex-none">{formatPaise(s.amount)}</span>
                {s.settle ? (
                  <button
                    onClick={() =>
                      openModal("settle", {
                        participantId: s.settle!.participantId,
                        participantName: s.settle!.participantName,
                        direction: s.settle!.direction,
                        amountRupees: s.settle!.amountRupees,
                        settleNetPaise: s.settle!.netPaise,
                        settleGroupId: groupId,
                      })
                    }
                    className="px-2.5 py-1.5 rounded-lg text-[11.5px] font-bold text-white cursor-pointer border-none bg-green flex-none hover:brightness-108"
                    style={{ background: "var(--green)" }}
                  >
                    Settle
                  </button>
                ) : (
                  <span className="text-[10.5px] font-semibold text-mut2 flex-none" title="Between members — settle outside the app">
                    between them
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
