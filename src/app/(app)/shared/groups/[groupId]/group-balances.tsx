"use client";

// Group Settlement — the screen answers one question first:
// "after everything is accounted for, who pays whom, and how much?"
//
// Every number here comes from the existing engine; nothing is recalculated:
//   • Fewest payments     → `suggestions`, i.e. minimizeSettlements() run
//     server-side over the corrected `paid − share` balances. This plan is
//     GROUP-WIDE: it works purely from (id, net) pairs, so a payment between
//     two other members stays between them and is never re-routed through
//     whoever happens to be logged in.
//   • Detailed obligations → computeDetailedObligations(): the obligations the
//     expenses actually created — everyone who shared a bill owes the person
//     who PAID it. Also group-wide: when a member fronts a bill, the others owe
//     THEM, and it is never re-addressed to the owner. Un-minimised on purpose;
//     this is the "why", and minimizeSettlements is what collapses it.
//   • What I'll receive    → each member's `net`, positives only. Personal
//     accounting; deliberately not shareable.
//
// The owner is rendered by their real name, not "You": this plan is meant to
// be pasted into a group chat, where "You" identifies nobody. Your own row is
// marked with a chip so you can still find yourself at a glance.

import { useState } from "react";
import { useUI } from "@/components/shell/ui-context";
import { copyText } from "@/lib/clipboard";
import { SETTLED_THRESHOLD } from "@/lib/group-dashboard";
import { formatPaise } from "@/lib/money";
import { namedPlan, planTotal, settlementHeadline, shareSettlementText, OWNER_ID, type PlanRow } from "@/lib/settlement-plan";
import type { GroupMemberView, GroupSuggestion } from "@/server/services/group-dashboard";

type View = "plan" | "detailed" | "receive";

interface Row extends PlanRow {
  /** Present when you are one side, so it can be recorded. */
  settle?: { participantId: string; participantName: string; direction: "TO_OWNER" | "FROM_OWNER"; amountRupees: string; netPaise: number };
}

export function GroupBalances({
  members,
  obligations,
  suggestions,
  groupId,
  groupName,
  ownerName,
  canRecordSettlements,
  isViewerOwner,
}: {
  members: GroupMemberView[];
  /** The individual obligations behind the plan, already named and group-wide:
   *  any person can owe any other, not just the owner. */
  obligations: { fromId: string; fromName: string; toId: string; toName: string; amount: number }[];
  suggestions: GroupSuggestion[];
  groupId: string;
  groupName: string;
  ownerName: string;
  /** Precomputed server-side. Only the group's owner can record a settlement,
   *  so for everyone else the plan is read-only — showing a Settle button that
   *  is guaranteed to error would be worse than showing none. */
  canRecordSettlements: boolean;
  /** Whether the reader is the owner. The "you" chip marks the OWNER's side of
   *  an arrow, which is only the reader when those are the same person —
   *  otherwise the plan reads entirely in the third person, as it should. */
  isViewerOwner: boolean;
}) {
  const { openModal, showToast } = useUI();
  const [view, setView] = useState<View>("plan");

  const others = members.filter((m) => m.participantId !== null);

  // THE PLAN — exactly what minimizeSettlements returned, with the owner's
  // placeholder resolved to a real name.
  const plan: Row[] = namedPlan(suggestions, ownerName).map((r, i) => ({ ...r, settle: suggestions[i].settle }));
  const headline = settlementHeadline(plan.length);

  // DETAILED — the obligations the expenses actually created, straight from the
  // server. Rows can run between any two people; an obligation to a member who
  // fronted a bill stays addressed to THEM.
  const netOf = new Map(others.map((m) => [m.participantId!, m.net]));
  const detailed: Row[] = obligations
    .filter((o) => o.amount > SETTLED_THRESHOLD)
    .map((o, i) => {
      // Settleable only where the owner is one side — that is the only shape
      // the settlement ledger records. The prefill still uses the member's
      // overall net, so the modal's live preview stays meaningful.
      const otherId = o.fromId === OWNER_ID ? o.toId : o.fromId;
      const involvesOwner = o.fromId === OWNER_ID || o.toId === OWNER_ID;
      const net = netOf.get(otherId) ?? 0;
      const settle =
        canRecordSettlements && involvesOwner && Math.abs(net) > SETTLED_THRESHOLD
          ? {
              participantId: otherId,
              participantName: o.fromId === OWNER_ID ? o.toName : o.fromName,
              direction: (net > 0 ? "TO_OWNER" : "FROM_OWNER") as "TO_OWNER" | "FROM_OWNER",
              amountRupees: String(Math.round(Math.abs(net) / 100)),
              netPaise: net,
            }
          : undefined;
      return { key: `d-${o.fromId}-${o.toId}-${i}`, ...o, settle };
    });

  // Personal standing, positives only — what you would actually collect.
  const receive: Row[] = others
    .filter((m) => m.net > SETTLED_THRESHOLD)
    .sort((a, b) => b.net - a.net)
    .map((m) => ({
      key: `recv-${m.participantId}`,
      fromId: m.participantId!,
      fromName: m.name,
      toId: OWNER_ID,
      toName: ownerName,
      amount: m.net,
      settle: canRecordSettlements
        ? {
            participantId: m.participantId!,
            participantName: m.name,
            direction: "TO_OWNER" as const,
            amountRupees: String(Math.round(m.net / 100)),
            netPaise: m.net,
          }
        : undefined,
    }));

  const shown = view === "receive" ? receive : view === "detailed" ? detailed : plan;
  const total = planTotal(shown);
  const fewer = detailed.length - plan.length;
  const settled = plan.length === 0;

  function settle(r: Row) {
    if (!r.settle) return;
    openModal("settle", {
      participantId: r.settle.participantId,
      participantName: r.settle.participantName,
      direction: r.settle.direction,
      amountRupees: r.settle.amountRupees,
      settleNetPaise: r.settle.netPaise,
      settleGroupId: groupId,
    });
  }

  async function share() {
    // Built from `shown`, so the message is literally the rows on screen.
    const text = shareSettlementText({
      groupName,
      headline: view === "detailed" ? `${shown.length} outstanding ${shown.length === 1 ? "obligation" : "obligations"}` : headline,
      rows: shown,
      total,
    });
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: `${groupName} — Settlement`, text });
        return;
      } catch {
        // Cancelled, or the browser refused — fall through to the clipboard so
        // there is always a way to get the text out.
      }
    }
    showToast((await copyText(text)) ? "Settlement copied — paste it into WhatsApp" : "Couldn't copy the settlement");
  }

  return (
    <section className="card p-[var(--pad)] flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="text-[13.5px] font-bold m-0">Group Settlement</h2>
        <span className="text-[11.5px] font-semibold text-mut2">{headline}</span>
      </div>

      {settled ? (
        <div className="text-center py-5">
          <div className="text-[24px]" aria-hidden>
            🎉
          </div>
          <div className="text-[13px] font-bold text-ink mt-1">All settled up ✓</div>
          <div className="text-[12px] text-mut2 mt-0.5">Everyone in this group is square.</div>
        </div>
      ) : (
        <>
          <div className="flex gap-1.5 p-1 bg-accsoft rounded-[12px]" role="tablist" aria-label="Settlement view">
            {([
              ["plan", "Fewest payments"],
              ["detailed", "Detailed"],
              ["receive", "I'll receive"],
            ] as const).map(([v, label]) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={`flex-1 min-h-[44px] px-1 rounded-[9px] text-[12px] font-bold border-none cursor-pointer transition-colors ${
                  view === v ? "bg-card text-ink shadow-sm" : "bg-transparent text-mut"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <p className="text-[11.5px] text-mut2 m-0 -mt-1">
            {view === "plan"
              ? fewer > 0
                ? `The shortest way to settle the whole group — ${fewer} fewer ${fewer === 1 ? "payment" : "payments"} than paying each obligation separately.`
                : "These are already the fewest payments."
              : view === "detailed"
                ? "Every obligation separately, including what you owe people who paid. This is the why behind the plan."
                : "Your own standing with each person — what you would collect."}
          </p>

          {shown.length === 0 ? (
            <div className="text-center py-5">
              <div className="text-[24px]" aria-hidden>
                💤
              </div>
              <div className="text-[13px] font-bold text-ink mt-1">You don&apos;t have anything to receive.</div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {shown.map((r) => (
                <div key={r.key} className="flex items-center gap-2 p-2.5 rounded-[11px] border border-line2 bg-side min-h-[44px]">
                  <div className="flex-1 min-w-0 text-[12.5px] font-semibold">
                    <Party name={r.fromName} isYou={isViewerOwner && r.fromId === OWNER_ID} />
                    <span className="text-mut2 font-bold" aria-label="pays"> → </span>
                    <Party name={r.toName} isYou={isViewerOwner && r.toId === OWNER_ID} />
                  </div>
                  <span className="text-[13px] font-extrabold tabular-nums flex-none">{formatPaise(r.amount)}</span>
                  {r.settle ? (
                    <button
                      onClick={() => settle(r)}
                      className="px-2.5 min-h-[36px] rounded-lg text-[11.5px] font-bold text-white cursor-pointer border-none flex-none hover:brightness-108"
                      style={{ background: "var(--green)" }}
                    >
                      Settle
                    </button>
                  ) : canRecordSettlements ? (
                    // Only meaningful to the owner: it marks the rows THEY
                    // can't record. To a member every row would say it, which
                    // would be plainly wrong on a row they are part of.
                    <span className="text-[10.5px] font-semibold text-mut2 flex-none" title="Between two members — settle outside the app">
                      between them
                    </span>
                  ) : null}
                </div>
              ))}

              <div className="flex items-center justify-between gap-2 pt-2 mt-1 border-t border-line">
                <span className="text-[12.5px] font-semibold text-mut">
                  {/* "to settle" belongs to the plan: it is the money that
                      actually has to move. The detailed list is the gross of
                      every obligation, which is a different quantity. */}
                  {view === "receive" ? "Total you'll receive" : view === "detailed" ? "Total obligations" : "Total to settle"}
                </span>
                <span className="text-[14px] font-extrabold tabular-nums" style={{ color: "var(--green)" }}>
                  {formatPaise(total)}
                </span>
              </div>

              {/* Say why there is nothing to press, rather than leaving a
                  member wondering whether the app is broken. */}
              {!canRecordSettlements && (
                <p className="text-[11px] text-mut2 m-0 mt-0.5">
                  Only {ownerName} can record payments in this group. Everyone sees the same plan.
                </p>
              )}

              {view !== "receive" && (
                <button
                  onClick={share}
                  className="btn-primary w-full min-h-[44px] mt-1 text-[12.5px] font-bold cursor-pointer"
                >
                  Share settlement
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** One side of an arrow. Your own name is accented and chipped so you can find
 *  yourself without the plan having to address you personally. */
function Party({ name, isYou }: { name: string; isYou: boolean }) {
  return (
    <span className={isYou ? "text-acc" : ""}>
      {name}
      {isYou && (
        <span className="ml-1 px-1 py-px rounded text-[9.5px] font-bold align-middle bg-accsoft text-acc" aria-label="that's you">
          you
        </span>
      )}
    </span>
  );
}
