"use client";

// Split-with-friends editor: the toggle, participant chips, EQUAL/EXACT/
// PERCENT/RATIO mode picker, per-person amount/weight inputs, and the
// computed summary line. Fully controlled so both the Add Expense form and
// the Edit Expense form drive identical split behavior from one place.

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

export function SplitEditor({
  state,
  amtPaise,
  participants,
}: {
  state: SplitEditorState;
  amtPaise: number;
  participants: { id: string; name: string; initial: string; color: string }[];
}) {
  const { split, setSplit, mode, setMode, parts, setParts, exact, setExact, weights, setWeights } = state;
  const selected = participants.filter((p) => parts[p.id]);
  const weighted = mode === "PERCENT" || mode === "RATIO";
  const splitInfo = computeSplitInfo(amtPaise, mode, selected, exact, weights);

  return (
    <div className="border-t border-line pt-3">
      <button onClick={() => setSplit(!split)} className="flex items-center justify-between cursor-pointer w-full bg-transparent border-none p-0">
        <span className="text-[13px] font-bold text-ink">👥 Split with friends</span>
        <span className="w-10 h-[23px] rounded-full relative transition-colors" style={{ background: split ? "var(--acc)" : "var(--line2)" }}>
          <span className="w-[17px] h-[17px] rounded-full bg-white absolute top-[3px] transition-all shadow" style={{ left: split ? 20 : 3 }} />
        </span>
      </button>
      {split && (
        <div className="flex flex-col gap-[11px] mt-3">
          <div className="flex gap-2 flex-wrap">
            {participants.map((p) => {
              const on = !!parts[p.id];
              return (
                <button
                  key={p.id}
                  onClick={() => setParts((s) => ({ ...s, [p.id]: !s[p.id] }))}
                  className="flex items-center gap-[7px] px-3 py-[7px] rounded-full text-[12.5px] font-semibold cursor-pointer"
                  style={{
                    border: `1px solid ${on ? "var(--acc)" : "var(--line2)"}`,
                    background: on ? "var(--accSoft)" : "transparent",
                    color: on ? "var(--acc)" : "var(--mut)",
                  }}
                >
                  <span className="w-[18px] h-[18px] rounded-full grid place-items-center text-[9.5px] font-bold text-white" style={{ background: p.color }}>
                    {p.initial}
                  </span>
                  {p.name}
                </button>
              );
            })}
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
export function buildSplitPayload(state: SplitEditorState, selectedIds: string[], payerParticipantId: string | null = null) {
  if (!state.split) return undefined;
  const weighted = state.mode === "PERCENT" || state.mode === "RATIO";
  return {
    mode: state.mode,
    participantIds: selectedIds,
    payerParticipantId,
    exactAmounts:
      state.mode === "EXACT" ? Object.fromEntries(selectedIds.map((id) => [id, Math.round((Number(state.exact[id]) || 0) * 100)])) : undefined,
    weights: weighted
      ? { me: Number(state.weights.me) || 0, ...Object.fromEntries(selectedIds.map((id) => [id, Number(state.weights[id]) || 0])) }
      : undefined,
  };
}
