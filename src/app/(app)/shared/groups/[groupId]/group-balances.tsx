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
import { SETTLED_THRESHOLD, viewerPosition, viewerPositionTotals } from "@/lib/group-dashboard";
import { formatPaise, toRupeeInput } from "@/lib/money";
import { namedPlan, planTotal, settlementHeadline, shareSettlementText, OWNER_ID, type PlanRow } from "@/lib/settlement-plan";
import type { GroupMemberView, GroupSuggestion } from "@/server/services/group-dashboard";


interface Row extends PlanRow {
  /** Present when you are one side, so it can be recorded. */
  settle?: { participantId: string; participantName: string; direction: "TO_OWNER" | "FROM_OWNER"; amountRupees: string; netPaise: number };
  /** #240: present on a row between two members, which the owner can now record
   *  too. Both ends are carried explicitly — the direction is the pair, not
   *  something derived from who is reading the page. */
  settleMembers?: { fromParticipantId: string; fromName: string; toParticipantId: string; toName: string; amountRupees: string };
}

export function GroupBalances({
  members,
  obligations,
  suggestions,
  groupId,
  groupName,
  ownerName,
  canRecordSettlements,
  viewerParticipantId,
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
  /** Who "you" is: null ⇒ the owner, a participant id ⇒ that member. Never
   *  derived from canRecordSettlements — that answers "may I act?", not
   *  "who am I?", and using it as identity is what made these labels lie. */
  viewerParticipantId: string | null;
}) {
  const { openModal, showToast } = useUI();
  // In obligation space the owner is OWNER_ID; members are themselves.
  const meId = viewerParticipantId ?? OWNER_ID;
  // One settlement list, two readings of it. Simplify ON is the minimised plan
  // (what Splitwise calls "simplify debts"); OFF is the raw obligations the
  // expenses created. They were separate tabs, which made two views of the same
  // question look like two different questions.
  const [simplify, setSimplify] = useState(true);

  const others = members.filter((m) => m.participantId !== null);

  // THE PLAN — exactly what minimizeSettlements returned, with the owner's
  // placeholder resolved to a real name.
  const plan: Row[] = namedPlan(suggestions, ownerName).map((r, i) => ({
    ...r,
    settle: suggestions[i].settle,
    settleMembers: suggestions[i].settleMembers,
  }));

  // DETAILED — the obligations the expenses actually created, straight from the
  // server. Rows can run between any two people; an obligation to a member who
  // fronted a bill stays addressed to THEM.
  const netOf = new Map(others.map((m) => [m.participantId!, m.net]));
  /** One obligation as a settleable row. Shared by the detailed list and by
   *  the viewer's own two lists, so a row carries the same actions wherever it
   *  appears and there is one place that decides what is recordable. */
  const toRow = (prefix: string) =>
    ((o: (typeof obligations)[number], i: number): Row => {
      // Owner-involved rows record through the owner↔member path, using the
      // member's overall net so the modal's live preview stays meaningful.
      // Rows between two members record through the member↔member path (#240) —
      // they used to say "settle outside the app", which left the un-minimised
      // list with obligations the app could not act on either.
      const otherId = o.fromId === OWNER_ID ? o.toId : o.fromId;
      const involvesOwner = o.fromId === OWNER_ID || o.toId === OWNER_ID;
      const net = netOf.get(otherId) ?? 0;
      const settleMembers =
        canRecordSettlements && !involvesOwner
          ? {
              fromParticipantId: o.fromId,
              fromName: o.fromName,
              toParticipantId: o.toId,
              toName: o.toName,
              amountRupees: toRupeeInput(o.amount),
            }
          : undefined;
      const settle =
        canRecordSettlements && involvesOwner && Math.abs(net) > SETTLED_THRESHOLD
          ? {
              participantId: otherId,
              participantName: o.fromId === OWNER_ID ? o.toName : o.fromName,
              direction: (net > 0 ? "TO_OWNER" : "FROM_OWNER") as "TO_OWNER" | "FROM_OWNER",
              amountRupees: toRupeeInput(net),
              netPaise: net,
            }
          : undefined;
      return { key: `${prefix}-${o.fromId}-${o.toId}-${i}`, ...o, settle, settleMembers };
    });

  const detailed: Row[] = obligations.filter((o) => o.amount > SETTLED_THRESHOLD).map(toRow("d"));

  // THE VIEWER'S OWN POSITION — filtered from the same group-wide obligations,
  // never recomputed. "I'll receive" is what is owed TO me, "I'll pay" is what
  // I owe. Both used to be one list hardcoded to flow to the owner
  // (`toId: OWNER_ID`), so every member read the owner's receivables under a
  // first-person label.
  //
  // Because these two are complements of the same ledger, their difference is
  // the viewer's net by construction — the identity is asserted in
  // group-viewer-perspective.integration.test.ts rather than assumed.
  //
  // Filtered by viewerPosition(), the one selector the group CARD also uses, so
  // the two figures on the card and the two here cannot drift apart.
  const position = viewerPosition(obligations, viewerParticipantId ?? null);
  const receive: Row[] = position.receive.map(toRow("recv"));
  const willPay: Row[] = position.pay.map(toRow("pay"));
  // Totals count every obligation, including dust the rows above omit — the
  // same selector the group card uses, so the two surfaces state one figure.
  // Summing the visible rows instead is what made Srisailam unreadable: money
  // inside the threshold vanished from the pair but stayed in the net.
  const { receive: receiveTotal, pay: payTotal } = viewerPositionTotals(obligations, viewerParticipantId ?? null);

  // The plan, in whichever reading is selected. The viewer's own two lists are
  // no longer one of these: they live in their own section above.
  const shown = simplify ? plan : detailed;
  const total = planTotal(shown);
  const fewer = detailed.length - plan.length;
  // Settled means there is nothing to show in EITHER reading - not just that
  // the minimised plan came back empty. The two can disagree: settling through
  // the owner squares everyone's net without discharging the member-to-member
  // obligations it settled, so a group can have no plan and still carry real
  // obligations. Gating the whole section on the plan alone hid the Simplify
  // control exactly when it was the only way to see them, under a card that
  // claimed everyone was square.
  const settled = plan.length === 0 && detailed.length === 0;
  // The plan is empty but obligations remain: a zero-sum cycle. Say so, and
  // point at the control that reveals it, rather than repeating "all settled".
  const cycleOnly = plan.length === 0 && detailed.length > 0;
  // settlementHeadline(0) says "All settled up", which is not true of a
  // group whose obligations merely cancel out. Say what is actually left.
  const headline = cycleOnly
    ? `${detailed.length} to settle directly`
    : settlementHeadline(plan.length);

  function settle(r: Row) {
    // A row between two members opens its own form: the owner↔member one asks
    // for a direction and an account, neither of which exists here.
    if (r.settleMembers) {
      openModal("settleMembers", {
        fromParticipantId: r.settleMembers.fromParticipantId,
        fromParticipantName: r.settleMembers.fromName,
        toParticipantId: r.settleMembers.toParticipantId,
        toParticipantName: r.settleMembers.toName,
        amountRupees: r.settleMembers.amountRupees,
        settleGroupId: groupId,
      });
      return;
    }
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
      headline: !simplify ? `${shown.length} outstanding ${shown.length === 1 ? "obligation" : "obligations"}` : headline,
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

  /** One row of an arrow: who pays whom, how much, and the way to record it. */
  const Row = ({ r, actionable = true }: { r: Row; actionable?: boolean }) => (
    <div className="flex items-center gap-2 p-2.5 rounded-[11px] border border-line2 bg-side min-h-[44px]">
      <div className="flex-1 min-w-0 text-[12.5px] font-semibold">
        <Party name={r.fromName} isYou={r.fromId === meId} />
        <span className="text-mut2 font-bold" aria-label="pays"> &rarr; </span>
        <Party name={r.toName} isYou={r.toId === meId} />
      </div>
      <span className="text-[13px] font-extrabold tabular-nums flex-none">{formatPaise(r.amount)}</span>
      {actionable && (r.settle || r.settleMembers) ? (
        <button
          onClick={() => settle(r)}
          aria-label={r.settleMembers ? `Settle ${r.fromName} pays ${r.toName}` : undefined}
          className="px-2.5 min-h-[36px] rounded-lg text-[11.5px] font-bold text-white cursor-pointer border-none flex-none hover:brightness-108"
          style={{ background: "var(--green)" }}
        >
          Settle
        </button>
      ) : null}
    </div>
  );

  const mine = [...receive, ...willPay];

  return (
    <>
      {/* ---------- 1. Where do I stand? ----------
          Its own block, first, because it is the only part of the page that is
          purely about the reader. It used to be a tab inside the settlement
          card, more than half a page down, beside a NET stat card that stated
          the same net from a different derivation - two "you'll get" figures
          that could disagree. This is now the only place either is said. */}
      <section className="card p-[var(--pad)] flex flex-col gap-2.5">
        <h2 className="text-[13.5px] font-bold m-0">Your position</h2>
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12.5px] font-semibold text-mut">You&rsquo;ll receive</span>
            <span className="text-[14px] font-extrabold tabular-nums" style={{ color: receiveTotal > 0 ? "var(--green)" : "var(--mut2)" }}>
              {formatPaise(receiveTotal)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12.5px] font-semibold text-mut">You&rsquo;ll pay</span>
            <span className="text-[14px] font-extrabold tabular-nums" style={{ color: payTotal > 0 ? "var(--red)" : "var(--mut2)" }}>
              {formatPaise(payTotal)}
            </span>
          </div>
          {/* Stated, not implied: net is the figure most often mistaken for the
              group's total, so the two lines it comes from sit directly above. */}
          <div className="flex items-center justify-between gap-2 pt-1.5 mt-0.5 border-t border-line">
            <span className="text-[13px] font-bold text-ink">Your net</span>
            <span
              className="text-[16px] font-extrabold tabular-nums"
              style={{ color: receiveTotal - payTotal < 0 ? "var(--red)" : receiveTotal - payTotal > 0 ? "var(--green)" : "var(--mut2)" }}
            >
              {receiveTotal === payTotal ? "—" : `${receiveTotal - payTotal < 0 ? "−" : "+"}${formatPaise(receiveTotal - payTotal)}`}
            </span>
          </div>
        </div>

        {mine.length > 0 && (
          /* Who with - one tap, because it answers a different question from
             "where do I stand", and keeping it open would push the plan off
             the first screen. A native <details> so it is keyboard- and
             screen-reader-operable without any wiring. */
          <details className="group border-t border-line pt-2">
            <summary className="list-none cursor-pointer select-none min-h-[44px] flex items-center gap-1.5 text-[12.5px] font-semibold text-mut hover:text-ink">
              <span aria-hidden className="transition-transform group-open:rotate-90 text-[15px] leading-none">&rsaquo;</span>
              Who with?
            </summary>
            <div className="flex flex-col gap-2 pt-2">
              {/* No Settle here on purpose. This section says where you stand;
                  Settle up below is the one actionable surface, and every row
                  in this list also appears there (Simplify off shows every
                  obligation). Two buttons for one payment would be two places
                  to look for the same thing. */}
              {mine.map((r) => (
                <Row key={r.key} r={r} actionable={false} />
              ))}
            </div>
          </details>
        )}
      </section>

      {/* ---------- 2. What should I do? ----------
          Directly beneath, and no longer sharing a card with the summary above.
          This section is recommendations; nothing in it has happened yet. */}
      <section className="card p-[var(--pad)] flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <h2 className="text-[13.5px] font-bold m-0">Settle up</h2>
          <span className="text-[11.5px] font-semibold text-mut2">{headline}</span>
        </div>

        {settled ? (
          <div className="text-center py-5">
            <div className="text-[24px]" aria-hidden>
              &#127881;
            </div>
            <div className="text-[13px] font-bold text-ink mt-1">All settled up &#10003;</div>
            <div className="text-[12px] text-mut2 mt-0.5">Everyone in this group is square.</div>
          </div>
        ) : (
          <>
            <button
              onClick={() => setSimplify((v) => !v)}
              role="switch"
              aria-checked={simplify}
              className="flex items-center justify-between gap-2 min-h-[44px] w-full bg-transparent border-none cursor-pointer p-0 text-left"
            >
              <span className="text-[12.5px] font-semibold text-ink">Simplify payments</span>
              <span
                aria-hidden
                className="w-[38px] h-[22px] rounded-full relative flex-none transition-colors"
                style={{ background: simplify ? "var(--acc)" : "var(--line2)" }}
              >
                <span className="absolute top-[3px] w-4 h-4 rounded-full bg-white transition-all" style={{ left: simplify ? "19px" : "3px" }} />
              </span>
            </button>

            <p className="text-[11.5px] text-mut2 m-0 -mt-1">
              {simplify
                ? fewer > 0
                  ? `The shortest way to settle the whole group — ${fewer} fewer ${fewer === 1 ? "payment" : "payments"} than paying each obligation separately.`
                  : "These are already the fewest payments."
                : "Every obligation separately, including debts between two members. This is the why behind the plan."}
            </p>

            {shown.length === 0 ? (
              <div className="text-center py-5">
                <div className="text-[24px]" aria-hidden>
                  {cycleOnly ? "&#8635;" : "&#128164;"}
                </div>
                <div className="text-[13px] font-bold text-ink mt-1">
                  {cycleOnly ? "No payments needed &mdash; everyone&rsquo;s net is zero." : "Everyone in this group is settled up."}
                </div>
                {cycleOnly && (
                  // Never claim they are square: the money below is real, it
                  // just cancels out around a loop.
                  //
                  // Careful with the promise. A row between two members can be
                  // recorded; an owner-directed one here cannot, because its
                  // Settle affordance keys off that member's net and every net
                  // in this group is zero. A cycle settled entirely through the
                  // owner has NO actionable rows, so this offers to show them
                  // and only mentions settling where it is actually possible.
                  <div className="text-[12px] text-mut2 mt-1 px-2">
                    {detailed.length} {detailed.length === 1 ? "obligation" : "obligations"} still cancel each other out. Turn off Simplify
                    payments to see {detailed.length === 1 ? "it" : "them"}
                    {detailed.some((r) => r.settleMembers) ? " — the ones between two members can be settled directly." : "."}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {shown.map((r) => (
                  <Row key={r.key} r={r} />
                ))}

                <div className="flex items-center justify-between gap-2 pt-2 mt-1 border-t border-line">
                  <span className="text-[12.5px] font-semibold text-mut">
                    {/* "to settle" belongs to the plan: it is the money that
                        actually has to move. The detailed list is the gross of
                        every obligation, which is a different quantity. */}
                    {simplify ? "Total to settle" : "Total obligations"}
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

                <button onClick={share} className="btn-primary w-full min-h-[44px] mt-1 text-[12.5px] font-bold cursor-pointer">
                  Share settlement
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </>
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
