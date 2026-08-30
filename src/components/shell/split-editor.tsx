"use client";

// Split-with-friends editor: the toggle, Paid By, the Split Between
// checklist (add/remove, guarded against removing the last participant),
// EQUAL/EXACT/PERCENT/RATIO mode picker, per-person amount/weight inputs,
// and the computed summary line. Fully controlled so both the Add Expense
// form and the Edit Expense form drive identical split behavior from one
// place.

import { useState } from "react";
import { normalizeName } from "@/lib/duplicate-contact";
import { formatPaise } from "@/lib/money";
import { computeSplitPreview, type SplitPreview } from "@/lib/split-shares";
import { Toggle } from "./toggle";

export interface SplitEditorState {
  split: boolean;
  setSplit: (v: boolean) => void;
  mode: "EQUAL" | "EXACT" | "PERCENT" | "RATIO";
  setMode: (m: "EQUAL" | "EXACT" | "PERCENT" | "RATIO") => void;
  parts: Record<string, boolean>;
  setParts: (fn: (s: Record<string, boolean>) => Record<string, boolean>) => void;
  exact: Record<string, string>;
  setExact: (fn: (s: Record<string, string>) => Record<string, string>) => void;
  weights: Record<string, string>;
  setWeights: (fn: (s: Record<string, string>) => Record<string, string>) => void;
  /** group-expenses-sprint: who actually paid — null means "Me" (the owner).
   * Lives alongside the rest of the split state so both forms get Paid By
   * for free instead of each hand-rolling their own payer bookkeeping. */
  payerId: string | null;
  setPayerId: (id: string | null) => void;
}

/**
 * The split breakdown shown under the mode picker.
 *
 * This used to be computeSplitInfo, a second implementation of the same
 * arithmetic that returned a single sentence about the person filling the
 * form: "₹506 each", "Your share: ₹421.69". It could not show what anyone
 * else owed, and its EQUAL branch modelled no remainder, so the number it
 * printed was not always the number that got stored.
 *
 * It now calls computeSplitPreview, which calls computeShares — the same
 * function the writer uses to produce the ExpenseSplit rows. The payload is
 * built by buildSplitPayload, the same builder the form submits, so neither
 * the inputs nor the arithmetic can differ between what is shown and what is
 * saved.
 */
export function useSplitPreview(amtPaise: number, state: SplitEditorState, selectedIds: string[]) {
  const payload = buildSplitPayload(state, selectedIds);
  if (!payload || selectedIds.length === 0) return null;
  return computeSplitPreview(amtPaise, payload);
}

/** The effective payer: `state.payerId` only counts if that person is
 * actually still selected in the split — a removed participant can't stay
 * the payer of record. Shared by SplitEditor's own render and by
 * buildSplitPayload below, so the two can never disagree. */
function effectivePayer(payerId: string | null, selectedIds: string[]): string | null {
  return payerId && selectedIds.includes(payerId) ? payerId : null;
}

/**
 * The people the split picker should offer.
 *
 * A group expense can only be split between that group's members, so offering
 * the whole contact list there is both noise and a trap: with ~100 contacts the
 * real members are buried, and picking an outsider silently produces a split
 * the group can never settle. Narrowing to the group is the rule the data model
 * already implies.
 *
 * Anyone ALREADY on the split stays listed even if they are not (or are no
 * longer) a member. Hiding them would leave them charged but invisible, which
 * is worse than showing an outsider — this way the row is visible and can be
 * deselected deliberately.
 */
export function participantsForGroup<T extends { id: string }>(
  all: T[],
  groupId: string,
  groups: { id: string; memberIds: string[] }[],
  parts: Record<string, boolean>
): T[] {
  if (!groupId) return all;
  const group = groups.find((g) => g.id === groupId);
  if (!group) return all; // unknown group — better to offer everyone than nobody
  const allowed = new Set(group.memberIds);
  return all.filter((p) => allowed.has(p.id) || parts[p.id]);
}

export function SplitEditor({
  state,
  participants,
  amountPaise,
}: {
  state: SplitEditorState;
  /** The expense amount, so switching mode can carry the current distribution
   *  across instead of blanking the fields. Omitted by callers that have not
   *  opted in, which keeps their behaviour exactly as it was. */
  amountPaise?: number;
  /** v2.1: every contact, Lending ones included. `isLending` only drives a
   *  badge — it never filters. Hiding those contacts here is what produced two
   *  "Blake" records for one person. */
  participants: { id: string; name: string; initial: string; color: string; isLending?: boolean }[];
}) {
  const { split, setSplit, mode, setMode, parts, setParts, exact, setExact, weights, setWeights, payerId, setPayerId } = state;
  const selected = participants.filter((p) => parts[p.id]);
  const selectedIds = selected.map((p) => p.id);
  // v2.1: now that Lending contacts are listed too, a long-standing user can
  // have a hundred of them and an unfiltered checklist is unusable — which
  // would recreate the original problem by a different route (can't find
  // Blake → make another Blake). Search appears only when the list is long
  // enough to need it; anyone already selected always stays visible so they
  // can't be silently filtered out of view while still in the split.
  const [query, setQuery] = useState("");
  const needle = normalizeName(query);
  const visible = needle
    ? participants.filter((p) => parts[p.id] || normalizeName(p.name).includes(needle))
    : participants;
  const weighted = mode === "PERCENT" || mode === "RATIO";
  const payer = effectivePayer(payerId, selectedIds);

  // Which fields the reader has set themselves, so redistribution can leave
  // those alone and move only the ones nobody has claimed. Interaction state
  // and nothing more: it is never submitted, never stored, and dies with this
  // component — closing the sheet, or opening a different transaction, starts
  // a reader with a clean slate rather than one inherited from another split.
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const claim = (key: string) => setTouched((t) => new Set(t).add(key));
  // A mode change re-expresses every number in different units, so which of
  // them a reader had chosen no longer means anything.
  const resetTouched = () => setTouched(new Set());

  const problem = splitInputProblem(state, selectedIds);

  // group-expenses-sprint: removing the last remaining participant would
  // leave a "split" with nobody to split with (the server requires at least
  // one — splitSchema's participantIds.min(1)) — block it here instead of
  // letting the user hit a confusing server validation error on submit.
  function toggle(id: string) {
    const turningOff = !!parts[id];
    if (turningOff && selected.length <= 1) return;
    setParts((s) => ({ ...s, [id]: !turningOff }));
    if (turningOff && payerId === id) setPayerId(null); // the removed person can't stay the payer
    // Who is in the split changes what a share MEANS, so nobody's number is
    // spoken for any more — the seeding below rebalances everyone, and holding
    // stale claims against a distribution that just moved would leave a split
    // that cannot add up.
    resetTouched();
    if (turningOff) return;
    // Joining: give them a real share rather than a blank the server refuses.
    const seed = seedForNewMember(amountPaise, state, [...selectedIds, id], id);
    if (seed?.exact) setExact(() => seed.exact!);
    if (seed?.weights) setWeights(() => seed.weights!);
  }

  /** Who paid changes what the engine derives, so the distribution on screen is
   *  written down before the switch and read back after it.
   *
   *  EXACT is the mode that needs it. The owner's share is DERIVED when they
   *  paid and STATED when a friend did, so moving between the two without
   *  recording it first left the "me" key at nothing — and the engine duly gave
   *  the owner ₹0 and handed their share to whoever was now named as payer.
   *  Seeding from the current preview is the same call a mode switch makes, so
   *  no second version of the arithmetic exists. */
  function changePayer(next: string | null) {
    if (mode === "EXACT" && amountPaise !== undefined && amountPaise > 0) {
      const snapshot = seedForMode(amountPaise, state, selectedIds, "EXACT");
      if (snapshot?.exact) setExact(() => snapshot.exact!);
    }
    setPayerId(next);
  }

  return (
    <div className="border-t border-line pt-3">
      <button
        onClick={() => {
          if (split) resetTouched(); // turning it off discards the numbers with it
          setSplit(!split);
        }}
        role="switch"
        aria-checked={split}
        className="flex items-center justify-between cursor-pointer w-full bg-transparent border-none p-0"
      >
        <span className="text-[13px] font-bold text-ink">👥 Split with friends</span>
        <Toggle on={split} />
      </button>
      {split && (
        <div className="flex flex-col gap-3 mt-3">
          {selected.length > 0 && (
            <div>
              <div className="label-caps mb-1.5">Paid by</div>
              <select className="field" aria-label="Paid by" value={payer ?? ""} onChange={(e) => changePayer(e.target.value || null)}>
                <option value="">Me</option>
                {selected.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <div className="label-caps mb-1.5">Split between</div>
            {participants.length > 8 && (
              <input
                className="field mb-2"
                type="search"
                aria-label="Search contacts"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${participants.length} contacts…`}
              />
            )}
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2.5 py-1.5">
                <span className="w-[18px] h-[18px] rounded-[5px] grid place-items-center flex-none" style={{ background: "var(--acc)" }} aria-hidden="true">
                  <span className="text-white text-[11px] font-bold">✓</span>
                </span>
                <span className="w-[18px] h-[18px] rounded-full grid place-items-center text-[9.5px] font-bold text-white flex-none" style={{ background: "var(--acc)" }}>Y</span>
                <span className="text-[13px] font-semibold text-ink flex-1">Me</span>
                {payer === null && <span className="text-[11px] font-bold text-acc">· paid</span>}
              </div>
              {visible.map((p) => {
                const on = !!parts[p.id];
                const isPayer = on && payer === p.id;
                const isOnlyOne = on && selected.length === 1;
                return (
                  <div key={p.id} className="flex items-center gap-2.5 py-1">
                    <button
                      type="button"
                      onClick={() => toggle(p.id)}
                      aria-pressed={on}
                      className="flex items-center gap-2.5 flex-1 min-w-0 cursor-pointer bg-transparent border-none p-0 text-left"
                    >
                      <span
                        className="w-[18px] h-[18px] rounded-[5px] border-2 grid place-items-center flex-none"
                        style={{ borderColor: on ? "var(--acc)" : "var(--line2)", background: on ? "var(--acc)" : "transparent" }}
                        aria-hidden="true"
                      >
                        {on && <span className="text-white text-[11px] font-bold">✓</span>}
                      </span>
                      <span className="w-[18px] h-[18px] rounded-full grid place-items-center text-[9.5px] font-bold text-white flex-none" style={{ background: p.color }}>
                        {p.initial}
                      </span>
                      <span className={`text-[13px] font-semibold truncate ${on ? "text-ink" : "text-mut"}`}>{p.name}</span>
                      {p.isLending && (
                        <span
                          className="text-[8.5px] font-bold uppercase tracking-wide rounded px-1 py-0.5 flex-none"
                          style={{ color: "var(--acc)", background: "var(--accSoft)" }}
                        >
                          Lending
                        </span>
                      )}
                      {isPayer && <span className="text-[11px] font-bold text-acc flex-none">· paid</span>}
                    </button>
                    {on && (
                      <button
                        type="button"
                        onClick={() => toggle(p.id)}
                        disabled={isOnlyOne}
                        title={isOnlyOne ? "At least one person is needed for a split" : `Remove ${p.name}`}
                        aria-label={`Remove ${p.name} from the split`}
                        className="w-5 h-5 rounded-full grid place-items-center text-[11px] font-bold cursor-pointer border-none bg-transparent text-mut2 flex-none hover:text-red hover:bg-redsoft disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex gap-1.5 flex-wrap">
            {(["EQUAL", "EXACT", "PERCENT", "RATIO"] as const).map((m) => (
              <button
                key={m}
                onClick={() => {
                  // Carry the current distribution into the mode being opened.
                  const seed = amountPaise === undefined ? null : seedForMode(amountPaise, state, selectedIds, m);
                  if (seed?.exact) setExact(() => seed.exact!);
                  if (seed?.weights) setWeights(() => seed.weights!);
                  resetTouched();
                  setMode(m);
                }}
                className="px-[13px] py-1.5 rounded-lg text-xs font-semibold cursor-pointer border-none"
                style={{ background: mode === m ? "var(--acc)" : "var(--accSoft)", color: mode === m ? "#fff" : "var(--acc)" }}
              >
                {m === "EQUAL" ? "Equal split" : m === "EXACT" ? "Exact amounts" : m === "PERCENT" ? "Percent" : "Ratio"}
              </button>
            ))}
          </div>
          {mode === "EXACT" && (
            <div className="flex flex-col gap-2">
              {/* The owner's share is derived rather than stored — splitExact
                  hands whoever paid `total − stated`. It is still worth being
                  able to say "I put in ₹100": typing here scales the friends
                  into what is left, so the engine derives exactly that figure
                  from the ordinary friends-only payload.
                  Shown only when the owner is the payer, because when a friend
                  paid it is THEIR share that the engine derives, not yours. */}
              {/* When the owner paid, this share is DERIVED (total − stated) and
                  typing here scales the friends into what is left. When a
                  friend paid it is a stated share like anyone else's, read from
                  the "me" key — so it is editable either way, and the engine
                  sees the same payload shape. */}
              {amountPaise !== undefined && amountPaise > 0 && (
                <div className="flex items-center gap-2.5">
                  <div className="flex-1 text-[12.5px] font-semibold">You</div>
                  {payerId === null ? (
                    <input
                      type="number"
                      inputMode="decimal"
                      aria-label="Your share"
                      defaultValue={String(
                        Number(
                          ((amountPaise - selectedIds.reduce((t, id) => t + Math.round((Number(exact[id]) || 0) * 100), 0)) / 100).toFixed(2)
                        )
                      )}
                      key={`me-${amountPaise}-${selectedIds.map((id) => exact[id] ?? "").join(",")}`}
                      onBlur={(e) => {
                        const next = redistributeOnEdit(amountPaise, state, selectedIds, "me", e.target.value);
                        if (next?.exact) setExact(() => next.exact!);
                      }}
                      placeholder="0"
                      className="field !w-[110px] !px-2.5 !py-2"
                    />
                  ) : (
                    <input
                      type="number"
                      inputMode="decimal"
                      aria-label="Your share"
                      value={exact.me ?? ""}
                      onChange={(e) => setExact((st) => ({ ...st, me: e.target.value }))}
                      placeholder="0"
                      className="field !w-[110px] !px-2.5 !py-2"
                    />
                  )}
                </div>
              )}
              {selected.map((p) => (
                <div key={p.id} className="flex items-center gap-2.5">
                  <div className="flex-1 text-[12.5px] font-semibold">{p.name}</div>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={exact[p.id] ?? ""}
                    onChange={(e) => setExact((s) => ({ ...s, [p.id]: e.target.value }))}
                    // On commit, not per keystroke: rebalancing mid-typing moves
                    // the other fields under the user while "2" is on its way to
                    // "250", and typing a number should not be a moving target.
                    onBlur={(e) => {
                      claim(p.id);
                      if (amountPaise === undefined) return;
                      const next = redistributeOnEdit(amountPaise, state, selectedIds, p.id, e.target.value, touched);
                      if (next?.exact) setExact(() => next.exact!);
                    }}
                    placeholder="0"
                    className="field !w-[110px] !px-2.5 !py-2"
                  />
                </div>
              ))}
            </div>
          )}
          {weighted && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2.5">
                <div className="flex-1 text-[12.5px] font-semibold">You</div>
                <input
                  type="number"
                  inputMode="decimal"
                  value={weights.me ?? ""}
                  onChange={(e) => setWeights((s) => ({ ...s, me: e.target.value }))}
                  onBlur={(e) => {
                    claim("me");
                    if (amountPaise === undefined) return;
                    const next = redistributeOnEdit(amountPaise, state, selectedIds, "me", e.target.value, touched);
                    if (next?.weights) setWeights(() => next.weights!);
                  }}
                  placeholder={mode === "PERCENT" ? "%" : "parts"}
                  className="field !w-[110px] !px-2.5 !py-2"
                />
              </div>
              {selected.map((p) => (
                <div key={p.id} className="flex items-center gap-2.5">
                  <div className="flex-1 text-[12.5px] font-semibold">{p.name}</div>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={weights[p.id] ?? ""}
                    onChange={(e) => setWeights((s) => ({ ...s, [p.id]: e.target.value }))}
                    onBlur={(e) => {
                      claim(p.id);
                      if (amountPaise === undefined) return;
                      const next = redistributeOnEdit(amountPaise, state, selectedIds, p.id, e.target.value, touched);
                      if (next?.weights) setWeights(() => next.weights!);
                    }}
                    placeholder={mode === "PERCENT" ? "%" : "parts"}
                    className="field !w-[110px] !px-2.5 !py-2"
                  />
                </div>
              ))}
            </div>
          )}
          {/* Said here, before the save, rather than by the server afterwards.
              The preview is content with a zero weight — the shares still total
              the amount — so nothing else on this screen would object. */}
          {problem && (
            <div role="alert" className="text-[12px] font-semibold px-3 py-2 rounded-lg" style={{ background: "var(--redSoft)", color: "var(--red)" }}>
              {problem}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Who owes what, before saving.
 *
 * Every rupee figure here comes from computeShares — the same call that
 * produces the ExpenseSplit rows — so this cannot show one number and store
 * another. It is a preview, not a gate: the server re-derives and re-validates
 * everything, and the DB trigger has the last word.
 *
 * A table from sm up, stacked rows below it; the amounts stay right-aligned in
 * both so a column of figures is scannable either way.
 *
 * Rendered by the expense modal rather than by SplitEditor, because the split
 * controls live inside "More details" and this must not: an expense whose
 * shares are only visible to someone who thinks to expand a collapsed section
 * is exactly the expense that saved ₹843.33 without anyone seeing it. The
 * controls stay where they are; their result comes out.
 */
export function SplitBreakdown({ preview, names }: { preview: SplitPreview | null; names: { id: string; name: string }[] }) {
  if (!preview) {
    return <div className="text-xs font-semibold text-acc bg-accsoft rounded-lg px-3 py-[9px]">Select friends to split with</div>;
  }
  if (preview.error) {
    return (
      <div className="text-xs font-semibold rounded-lg px-3 py-[9px]" style={{ background: "var(--redsoft)", color: "var(--red)" }}>
        {preview.error}
      </div>
    );
  }
  const nameOf = (id: string | null) => (id === null ? "You" : (names.find((n) => n.id === id)?.name ?? "Someone"));
  const payerName = nameOf(preview.rows.find((r) => r.isPayer)?.participantId ?? null);

  return (
    <div className="rounded-lg border border-line2 bg-card overflow-hidden">
      <div className="label-caps px-3 pt-2.5 pb-1">Split breakdown</div>
      <div className="flex flex-col">
        {preview.rows.map((r) => (
          <div
            key={r.participantId ?? "me"}
            className="flex items-baseline gap-2 px-3 py-1.5 border-t border-line first:border-t-0 text-[12.5px]"
          >
            <span className="flex-1 min-w-0 truncate font-semibold text-ink">{nameOf(r.participantId)}</span>
            <span className="flex-none text-[11px] text-mut2 w-[64px] sm:w-[80px] text-right">{r.method}</span>
            <span className="flex-none w-[86px] text-right font-extrabold tabular-nums">{formatPaise(r.owedAmount)}</span>
          </div>
        ))}
      </div>
      <div
        className="flex items-baseline gap-2 px-3 py-2 border-t-2 text-[12.5px] font-bold"
        style={{ borderColor: "var(--line2)", color: preview.balances ? "var(--ink)" : "var(--red)" }}
      >
        <span className="flex-1">Split total</span>
        <span className="flex-none tabular-nums">
          {formatPaise(preview.total)}
          {preview.balances ? " ✓" : ""}
        </span>
      </div>
      {/* The remainder is the difference between an even division and what the
          engine actually stored — it always lands on the payer. Saying so is
          the difference between "₹X each" and the truth. */}
      {preview.remainder > 0 && (
        <div className="px-3 pb-2 text-[10.5px] text-mut2">
          {formatPaise(preview.remainder)} rounding remainder → {payerName}
        </div>
      )}
    </div>
  );
}

/** Builds the SplitInput payload the server actions expect, from SplitEditor's controlled state. */
/** Greatest common divisor, for reducing paise to the simplest whole ratio. */
function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Trims float noise: 25.000000001 and 24.999999 both read as 25. */
function clean(n: number): string {
  return String(Number(n.toFixed(2)));
}

/**
 * The inputs a mode should start from, given how the money is split RIGHT NOW.
 *
 * Switching mode used to blank the fields, so a user who had a distribution in
 * front of them lost it and started from nothing. The distribution is already
 * known — the bridge between modes is the shares the engine currently computes,
 * not the previous mode's raw inputs, so a user's edits carry across too.
 *
 * This does NOT do split arithmetic. It asks computeSplitPreview — the same
 * call the breakdown and the writer use — what each person owes, then expresses
 * that in the next mode's units. The engine then recomputes from those inputs
 * and remains the only thing that decides the stored shares, so a percentage
 * that cannot express the paise exactly is simply re-derived rather than
 * silently disagreeing with what was displayed.
 *
 * Returns nothing when there is no amount or nobody selected: seeding from an
 * empty distribution would only invent numbers.
 */
export function seedForMode(
  amountPaise: number,
  state: SplitEditorState,
  selectedIds: string[],
  next: SplitEditorState["mode"]
): { exact?: Record<string, string>; weights?: Record<string, string> } | null {
  if (next === "EQUAL" || amountPaise <= 0 || selectedIds.length === 0) return null;
  const payload = buildSplitPayload({ ...state, split: true }, selectedIds);
  if (!payload) return null;
  const preview = computeSplitPreview(amountPaise, payload);
  if (preview.error) return null;
  const owed = new Map(preview.rows.map((r) => [r.participantId ?? "me", r.owedAmount]));

  if (next === "EXACT") {
    // "me" is seeded alongside the friends, from the same preview row.
    //
    // It is only CONSUMED when a friend paid — when the owner pays, splitExact
    // derives their share as the balance and ignores this key — but writing it
    // either way is what lets the distribution survive a change of payer.
    // Leaving it out was how a stated ₹300 share silently became ₹0, and the
    // payer was charged for it, the moment somebody else was named as payer.
    const exact: Record<string, string> = { me: clean((owed.get("me") ?? 0) / 100) };
    for (const id of selectedIds) exact[id] = clean((owed.get(id) ?? 0) / 100);
    return { exact };
  }

  const keys = ["me", ...selectedIds];
  const amounts = keys.map((k) => owed.get(k) ?? 0);

  if (next === "PERCENT") {
    const weights: Record<string, string> = {};
    keys.forEach((k, i) => { weights[k] = clean((amounts[i] / amountPaise) * 100); });
    return { weights };
  }

  // RATIO: the smallest whole-number ratio that still describes this split.
  //
  // Reducing the PAISE by their common divisor only works when the shares
  // happen to share one. ₹1,000 three ways is 33333 / 33334 / 33333 — the odd
  // paise the payer absorbs makes those coprime — so the reduction did nothing
  // and the boxes read "33333 parts". Measured: adding a member to that split
  // stored ₹0.11 / ₹749.81 / ₹250.00 / ₹0.08 for a bill everyone meant to share.
  //
  // So the denominator is searched for instead of derived: the first one that
  // reproduces every share to within a rupee wins. ₹1,000 three ways becomes
  // 1 / 1 / 1, 500/300/200 stays 5 / 3 / 2, and the engine re-derives the
  // exact paise from whichever ratio comes back, as it does for any weights.
  const weights: Record<string, string> = {};
  const settle = (parts: number[]) => {
    keys.forEach((k, i) => { weights[k] = String(parts[i]); });
    return { weights };
  };
  for (let d = 1; d <= 200; d++) {
    const parts = amounts.map((a) => Math.round((a * d) / amountPaise));
    const sum = parts.reduce((x, y) => x + y, 0);
    if (sum <= 0) continue;
    // Nobody with a real share may round down to no parts at all.
    if (amounts.some((a, i) => a > 0 && parts[i] === 0)) continue;
    const worst = Math.max(...amounts.map((a, i) => Math.abs((amountPaise * parts[i]) / sum - a)));
    if (worst <= 100) return settle(parts);
  }
  // Nothing small describes it — fall back to the exact paise, reduced.
  const divisor = amounts.reduce((a, b) => gcd(a, b), 0) || 1;
  return settle(amounts.map((a) => Math.round(a / divisor)));
}

/**
 * Spread `target` across `keys` in proportion to `current`, in whole units,
 * with the rounding drift landing on the largest share so the parts always sum
 * to `target` exactly. Falls back to an even spread when there is nothing to be
 * proportional to.
 */
function spread(keys: string[], current: number[], target: number): number[] {
  if (keys.length === 0) return [];
  if (target <= 0) return keys.map(() => 0);
  const sum = current.reduce((a, b) => a + b, 0);
  const base = sum > 0 ? current.map((c) => Math.floor((target * c) / sum)) : keys.map(() => Math.floor(target / keys.length));
  const drift = target - base.reduce((a, b) => a + b, 0);
  if (drift !== 0) {
    let biggest = 0;
    for (let i = 1; i < base.length; i++) if (base[i] > base[biggest]) biggest = i;
    base[biggest] += drift;
  }
  return base;
}

/**
 * What the other people's inputs should become when one person's is edited.
 *
 * The engine never produces an unbalanced split — splitExact hands the payer
 * `total − stated`, and splitByWeights normalises by the weight sum — so this
 * is not about repairing arithmetic. It is about keeping the numbers on screen
 * meaningful: raising one person to 50% should drop the others to fit inside
 * 100, not silently renormalise everyone against a total of 125.
 *
 * Only the OTHER inputs move. The edited value is returned untouched, because
 * the whole point is that the user's own number wins.
 *
 * Three modes behave differently, on purpose:
 *   • EXACT — friends carry stated amounts and the owner's share is derived, so
 *     the others are scaled to hold that derived share steady. Nothing is
 *     invented for the owner; the engine still derives it. Editing the OWNER's
 *     own field deliberately moves every friend rather than only the unclaimed
 *     ones: when the owner pays, that field is a derived display of
 *     `total − stated`, so it is an instruction about what the friends must
 *     come to, and it has to be honoured the moment it is given or the number
 *     shown would contradict the number typed.
 *   • PERCENT — every participant including the owner has a weight, and the
 *     natural reading is "out of 100", so the rest are scaled into 100 − edited.
 *   • RATIO — weights are relative by definition. Changing 1/1/2 to 2/1/2 is
 *     already meaningful and the engine still totals exactly, so touching the
 *     other numbers would be the surprising thing. Left alone deliberately.
 *
 * `touched` names the fields the reader has set THEMSELVES this session. Only
 * the ones they have not are asked to absorb the difference, so entering a
 * distribution field by field arrives where it was aimed: 40 / 30 / 20 / 10
 * typed in that order stays 40 / 30 / 20 / 10, instead of each entry quietly
 * rewriting the ones before it (measured: it landed on 36.81 / 31.52 / 21.67 /
 * 10). When every other field is spoken for, nothing is rewritten and the
 * total is allowed to exceed 100 — splitInputProblem() says so out loud rather
 * than one of the reader's own numbers being changed to hide it.
 *
 * An empty `touched` is the original behaviour: everyone else absorbs.
 */
const NOTHING_TOUCHED: ReadonlySet<string> = new Set<string>();

export function redistributeOnEdit(
  amountPaise: number,
  state: SplitEditorState,
  selectedIds: string[],
  editedKey: string,
  rawValue: string,
  touched: ReadonlySet<string> = NOTHING_TOUCHED
): { exact?: Record<string, string>; weights?: Record<string, string> } | null {
  if (state.mode === "EQUAL" || state.mode === "RATIO") return null;
  if (selectedIds.length === 0) return null;
  const edited = Number(rawValue);
  if (!Number.isFinite(edited) || edited < 0) return null;

  if (state.mode === "EXACT") {
    if (amountPaise <= 0) return null;
    const toPaise = (v: string | undefined) => Math.round((Number(v) || 0) * 100);
    const editedPaise = Math.round(edited * 100);

    // The owner's own share. There is no exactAmounts key for the owner —
    // splitExact derives it as `total − stated` — so stating it is really an
    // instruction about what the FRIENDS must add up to. Editing it scales
    // them into `total − yours`, and the engine still derives the same figure
    // from the same payload. No second owner share is created.
    if (editedKey === "me") {
      const target = Math.max(0, amountPaise - editedPaise);
      const parts = spread(selectedIds, selectedIds.map((id) => toPaise(state.exact[id])), target);
      // Written down as well as scaled into: when a friend pays it is this key
      // the engine reads, and the two representations must not disagree.
      const exact: Record<string, string> = { ...state.exact, me: clean(edited) };
      selectedIds.forEach((id, i) => { exact[id] = String(Number((parts[i] / 100).toFixed(2))); });
      return { exact };
    }

    const statedBefore = selectedIds.reduce((t, id) => t + toPaise(state.exact[id]), 0);
    // Hold the owner's share steady and let the friends move around it — but
    // measured from the AMOUNT, not from what the friends happened to total a
    // moment ago.
    //
    // Deriving the pool as `friends' total − edited` looks equivalent and is
    // not, because of when this runs. The friend inputs are controlled, so by
    // the time blur fires `state.exact[editedKey]` ALREADY holds the new value
    // — which meant `statedBefore` counted it, `statedBefore − edited` came
    // back as exactly the other friends' current total, and they were "spread"
    // onto themselves. EXACT redistribution has therefore never moved anybody
    // in the browser: editing one friend quietly took the difference out of the
    // owner's derived share instead, whatever the unit tests said. They passed
    // because they hand the function a pre-edit state no real event ever has.
    //
    // Anchoring on the amount removes the dependence on a previous value this
    // callback cannot see. The owner's share comes from their own key when it
    // exists, and falls back to the balance for a payload that predates it.
    const ownerPaise = state.exact.me !== undefined && state.exact.me !== ""
      ? toPaise(state.exact.me)
      : Math.max(0, amountPaise - statedBefore);
    // Which others move is the same question Percent answers: only the people
    // the reader has not already settled on.
    const others = selectedIds.filter((id) => id !== editedKey);
    const free = others.filter((id) => !touched.has(id));
    const spokenFor = others.filter((id) => touched.has(id)).reduce((t, id) => t + toPaise(state.exact[id]), 0);
    const pool = amountPaise - ownerPaise - editedPaise - spokenFor;
    const exact: Record<string, string> = { ...state.exact, [editedKey]: rawValue };
    // Everyone else is spoken for: nothing is rewritten, and an entry that
    // overshoots is caught by splitExact — which refuses stated amounts above
    // the total — and reported by computeSplitPreview as the error the save is
    // gated on, rather than one of the reader's own figures being changed to
    // hide it. With someone free, an overshoot still empties them rather than
    // driving anybody negative.
    if (free.length === 0) return { exact };
    const parts = spread(free, free.map((id) => toPaise(state.exact[id])), Math.max(0, pool));
    free.forEach((id, i) => { exact[id] = String(Number((parts[i] / 100).toFixed(2))); });
    return { exact };
  }

  // PERCENT — keep the visible numbers inside 100.
  const keys = ["me", ...selectedIds];
  const others = keys.filter((k) => k !== editedKey);
  // Hundredths of a percent, so 33.33 stays 33.33 rather than 33.329999.
  const bp = (k: string) => Math.round((Number(state.weights[k]) || 0) * 100);
  const editedBp = Math.round(Math.min(edited, 100) * 100);
  const weights: Record<string, string> = { ...state.weights, [editedKey]: rawValue };

  const free = others.filter((k) => !touched.has(k));
  const spokenFor = others.filter((k) => touched.has(k)).reduce((t, k) => t + bp(k), 0);
  const pool = 10000 - editedBp - spokenFor;
  // Nobody free to absorb it: leave every other number as the reader left it,
  // and splitInputProblem() reports the overflow instead of hiding it in one
  // of their own figures.
  if (free.length === 0) return { weights };

  const parts = spread(free, free.map(bp), Math.max(0, pool));
  free.forEach((k, i) => { weights[k] = String(Number((parts[i] / 100).toFixed(2))); });
  return { weights };
}

/**
 * What a member joining an existing split starts on.
 *
 * An added member used to start blank, which `buildSplitPayload` turned into a
 * weight of 0 — and `splitSchema` refuses that, so the reader reached a split
 * that looked finished, showed no complaint, and was rejected by the server on
 * save with "Number must be greater than 0". Nothing on screen said which
 * person it meant.
 *
 * The rule is one rule in three units: the newcomer takes an EQUAL share of
 * what is currently being divided, and the existing redistribution puts the
 * rest back in proportion.
 *
 *   • PERCENT — 100 ÷ heads, everyone else scaled into what is left.
 *   • RATIO   — the mean of the current weights, so relative standing between
 *               the people already there is untouched. Whole numbers, minimum
 *               one part: a ratio of zero is not a share.
 *   • EXACT   — the amount ÷ heads, taken from the other FRIENDS, which is the
 *               same rule editing any other exact field already follows and
 *               leaves the owner's share where it was.
 *
 * No new arithmetic: PERCENT and EXACT hand off to redistributeOnEdit, and
 * every stored share still comes from the engine.
 */
export function seedForNewMember(
  amountPaise: number | undefined,
  state: SplitEditorState,
  selectedIds: string[],
  newId: string
): { exact?: Record<string, string>; weights?: Record<string, string> } | null {
  if (state.mode === "EQUAL" || !selectedIds.includes(newId)) return null;
  const heads = selectedIds.length + 1; // the friends, plus the owner

  if (state.mode === "RATIO") {
    const current = ["me", ...selectedIds.filter((id) => id !== newId)].map((k) => Number(state.weights[k]) || 0);
    const sum = current.reduce((a, b) => a + b, 0);
    const share = current.length > 0 && sum > 0 ? Math.max(1, Math.round(sum / current.length)) : 1;
    return { weights: { ...state.weights, [newId]: String(share) } };
  }

  if (state.mode === "PERCENT") {
    const share = clean(100 / heads);
    // A fresh redistribution: joining changes what everyone gets, so this is
    // the one edit that is allowed to move numbers the reader typed.
    return redistributeOnEdit(amountPaise ?? 0, state, selectedIds, newId, share) ?? { weights: { ...state.weights, [newId]: share } };
  }

  if (amountPaise === undefined || amountPaise <= 0) return null;
  const share = clean(amountPaise / heads / 100);
  return redistributeOnEdit(amountPaise, state, selectedIds, newId, share) ?? { exact: { ...state.exact, [newId]: share } };
}

/**
 * The reason this split cannot be saved yet, in the reader's words.
 *
 * `computeSplitPreview` is about arithmetic and answers happily here: a
 * participant weighted 0 simply gets ₹0 and the shares still total the amount,
 * so `balances` is true and `error` is null. The server disagrees —
 * `splitSchema.weights` is `positive()` — and the gap between those two is a
 * screen that looks finished and a save that fails.
 *
 * This closes that gap without moving where the rules live: the schema is
 * still the authority, and this only says the same thing early, by name.
 */
export function splitInputProblem(state: SplitEditorState, selectedIds: string[]): string | null {
  if (!state.split || selectedIds.length === 0) return null;
  if (state.mode !== "PERCENT" && state.mode !== "RATIO") return null;

  const keys = ["me", ...selectedIds];
  if (keys.some((k) => !(Number(state.weights[k]) > 0))) {
    return state.mode === "PERCENT"
      ? "Everyone in the split needs a percentage above 0."
      : "Everyone in the split needs at least one part.";
  }
  if (state.mode === "PERCENT") {
    const total = keys.reduce((t, k) => t + (Number(state.weights[k]) || 0), 0);
    // A hundredth of a percent of slack: the redistribution works in basis
    // points and 33.33 × 3 is allowed to be 99.99.
    if (total > 100.005) return `These add up to ${clean(total)}% — that is ${clean(total - 100)}% too much.`;
  }
  return null;
}

export function buildSplitPayload(state: SplitEditorState, selectedIds: string[]) {
  if (!state.split) return undefined;
  const weighted = state.mode === "PERCENT" || state.mode === "RATIO";
  return {
    mode: state.mode,
    participantIds: selectedIds,
    payerParticipantId: effectivePayer(state.payerId, selectedIds),
    exactAmounts:
      state.mode === "EXACT"
        ? {
            // "me" is only consumed when a friend paid — the owner's share is
            // derived when they paid it themselves. Sending it either way keeps
            // the payload one shape.
            me: Math.round((Number(state.exact.me) || 0) * 100),
            ...Object.fromEntries(selectedIds.map((id) => [id, Math.round((Number(state.exact[id]) || 0) * 100)])),
          }
        : undefined,
    weights: weighted
      ? { me: Number(state.weights.me) || 0, ...Object.fromEntries(selectedIds.map((id) => [id, Number(state.weights[id]) || 0])) }
      : undefined,
  };
}
