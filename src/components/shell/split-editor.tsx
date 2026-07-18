"use client";

// Split-with-friends editor: the toggle, Paid By, the Split Between
// checklist (add/remove, guarded against removing the last participant),
// EQUAL/EXACT/PERCENT/RATIO mode picker, per-person amount/weight inputs,
// and the computed summary line. Fully controlled so both the Add Expense
// form and the Edit Expense form drive identical split behavior from one
// place.

import { formatPaise } from "@/lib/money";

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

export function computeSplitInfo(
  amtPaise: number,
  mode: SplitEditorState["mode"],
  selected: { id: string; name: string }[],
  exact: Record<string, string>,
  weights: Record<string, string>
): string {
  if (!selected.length) return "Select friends to split with";
  if (mode === "EQUAL") {
    return `${formatPaise(Math.floor(amtPaise / (selected.length + 1)))} each · you + ${selected.length} ${selected.length > 1 ? "friends" : "friend"}`;
  }
  if (mode === "EXACT") {
    const sum = selected.reduce((s, p) => s + Math.round((Number(exact[p.id]) || 0) * 100), 0);
    return `Your share: ${formatPaise(Math.max(0, amtPaise - sum))}${sum > amtPaise ? " · ⚠ splits exceed total" : ""}`;
  }
  const meW = Number(weights.me) || 0;
  const friendW = selected.reduce((s, p) => s + (Number(weights[p.id]) || 0), 0);
  const total = meW + friendW;
  return total > 0
    ? `Your share: ${formatPaise(Math.floor((amtPaise * meW) / total))}${mode === "PERCENT" ? ` (${meW}%)` : ` (${meW} ${meW === 1 ? "part" : "parts"})`}`
    : "Enter a weight for each person";
}

/** The effective payer: `state.payerId` only counts if that person is
 * actually still selected in the split — a removed participant can't stay
 * the payer of record. Shared by SplitEditor's own render and by
 * buildSplitPayload below, so the two can never disagree. */
function effectivePayer(payerId: string | null, selectedIds: string[]): string | null {
  return payerId && selectedIds.includes(payerId) ? payerId : null;
}

export function SplitEditor({
  state,
  amtPaise,
  participants,
}: {
  state: SplitEditorState;
  amtPaise: number;
  participants: { id: string; name: string; initial: string; color: string }[];
}) {
  const { split, setSplit, mode, setMode, parts, setParts, exact, setExact, weights, setWeights, payerId, setPayerId } = state;
  const selected = participants.filter((p) => parts[p.id]);
  const selectedIds = selected.map((p) => p.id);
  const weighted = mode === "PERCENT" || mode === "RATIO";
  const splitInfo = computeSplitInfo(amtPaise, mode, selected, exact, weights);
  const payer = effectivePayer(payerId, selectedIds);

  // group-expenses-sprint: removing the last remaining participant would
  // leave a "split" with nobody to split with (the server requires at least
  // one — splitSchema's participantIds.min(1)) — block it here instead of
  // letting the user hit a confusing server validation error on submit.
  function toggle(id: string) {
    const turningOff = !!parts[id];
    if (turningOff && selected.length <= 1) return;
    setParts((s) => ({ ...s, [id]: !turningOff }));
    if (turningOff && payerId === id) setPayerId(null); // the removed person can't stay the payer
  }

  return (
    <div className="border-t border-line pt-3">
      <button onClick={() => setSplit(!split)} className="flex items-center justify-between cursor-pointer w-full bg-transparent border-none p-0">
        <span className="text-[13px] font-bold text-ink">👥 Split with friends</span>
        <span className="w-10 h-[23px] rounded-full relative transition-colors" style={{ background: split ? "var(--acc)" : "var(--line2)" }}>
          <span className="w-[17px] h-[17px] rounded-full bg-white absolute top-[3px] transition-all shadow" style={{ left: split ? 20 : 3 }} />
        </span>
      </button>
      {split && (
        <div className="flex flex-col gap-3 mt-3">
          {selected.length > 0 && (
            <div>
              <div className="label-caps mb-1.5">Paid by</div>
              <select className="field" aria-label="Paid by" value={payer ?? ""} onChange={(e) => setPayerId(e.target.value || null)}>
                <option value="">Me</option>
                {selected.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <div className="label-caps mb-1.5">Split between</div>
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2.5 py-1.5">
                <span className="w-[18px] h-[18px] rounded-[5px] grid place-items-center flex-none" style={{ background: "var(--acc)" }} aria-hidden="true">
                  <span className="text-white text-[11px] font-bold">✓</span>
                </span>
                <span className="w-[18px] h-[18px] rounded-full grid place-items-center text-[9.5px] font-bold text-white flex-none" style={{ background: "var(--acc)" }}>Y</span>
                <span className="text-[13px] font-semibold text-ink flex-1">Me</span>
                {payer === null && <span className="text-[11px] font-bold text-acc">· paid</span>}
              </div>
              {participants.map((p) => {
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
                onClick={() => setMode(m)}
                className="px-[13px] py-1.5 rounded-lg text-xs font-semibold cursor-pointer border-none"
                style={{ background: mode === m ? "var(--acc)" : "var(--accSoft)", color: mode === m ? "#fff" : "var(--acc)" }}
              >
                {m === "EQUAL" ? "Equal split" : m === "EXACT" ? "Exact amounts" : m === "PERCENT" ? "Percent" : "Ratio"}
              </button>
            ))}
          </div>
          {mode === "EXACT" && (
            <div className="flex flex-col gap-2">
              {selected.map((p) => (
                <div key={p.id} className="flex items-center gap-2.5">
                  <div className="flex-1 text-[12.5px] font-semibold">{p.name}</div>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={exact[p.id] ?? ""}
                    onChange={(e) => setExact((s) => ({ ...s, [p.id]: e.target.value }))}
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
                    placeholder={mode === "PERCENT" ? "%" : "parts"}
                    className="field !w-[110px] !px-2.5 !py-2"
                  />
                </div>
              ))}
            </div>
          )}
          <div className="text-xs font-semibold text-acc bg-accsoft rounded-lg px-3 py-[9px]">{splitInfo}</div>
        </div>
      )}
    </div>
  );
}

/** Builds the SplitInput payload the server actions expect, from SplitEditor's controlled state. */
export function buildSplitPayload(state: SplitEditorState, selectedIds: string[]) {
  if (!state.split) return undefined;
  const weighted = state.mode === "PERCENT" || state.mode === "RATIO";
  return {
    mode: state.mode,
    participantIds: selectedIds,
    payerParticipantId: effectivePayer(state.payerId, selectedIds),
    exactAmounts:
      state.mode === "EXACT" ? Object.fromEntries(selectedIds.map((id) => [id, Math.round((Number(state.exact[id]) || 0) * 100)])) : undefined,
    weights: weighted
      ? { me: Number(state.weights.me) || 0, ...Object.fromEntries(selectedIds.map((id) => [id, Number(state.weights[id]) || 0])) }
      : undefined,
  };
}
