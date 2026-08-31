"use client";

// The shared shell every full-screen entry experience is built from.
//
// Spending and Lending are different domains with different fields, different
// services and different validation — they are NOT one component with a
// `domain` prop. What they legitimately share is the SHAPE: a screen rather
// than a dialog, one enormous amount, a row of metadata chips, a keypad, and a
// deliberate swipe instead of a Save button.
//
// So the shape lives here and each domain composes it. Nothing in this file
// knows what a transaction or a loan is, which is the point — the day a third
// entry experience appears it takes the shell and brings its own fields.

import { useRef, useState } from "react";
import { GRID } from "./amount-keypad";
import { looksLikeExpression, partialAmount } from "@/lib/expression";


/** Pill selector — the shape both the type and the personal/group choice take. */
export function Segmented({
  options,
  value,
  onChange,
  tint,
  small,
  label,
}: {
  options: { value: string; label: string; glyph?: string }[];
  value: string;
  /** Omitted when the choice is fixed — the buttons then read as a statement
   *  of what this transaction IS, rather than a control that does nothing. */
  onChange?: (v: string) => void;
  tint?: string;
  small?: boolean;
  /** What the choice is between. A screen has more than one of these, and an
   *  unnamed role="group" tells a screen reader nothing about which. */
  label?: string;
}) {
  return (
    <div className={`inline-flex gap-1 rounded-full bg-side border border-line2 ${small ? "p-0.5" : "p-1"}`} role="group" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange?.(o.value)}
            aria-pressed={on}
            disabled={!onChange}
            title={!onChange && !on ? "A saved transaction can't change between Debit and Credit" : undefined}
            className={`inline-flex items-center gap-1.5 rounded-full border-none font-bold transition-colors ${
              onChange ? "cursor-pointer" : "cursor-default"
            } ${!onChange && !on ? "opacity-40" : ""} ${
              small ? "px-3 min-h-[32px] text-[11.5px]" : "px-4 min-h-[38px] text-[13px]"
            }`}
            style={{ background: on ? "var(--card)" : "transparent", color: on ? "var(--ink)" : "var(--mut2)" }}
          >
            {o.glyph && <span aria-hidden style={{ color: on ? tint : "inherit" }}>{o.glyph}</span>}
            <span className="truncate max-w-[38vw]">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Drag the handle to commit. A real pointer gesture, not a button wearing a
 *  track: releasing short of the threshold animates back and saves nothing. */
export function SwipeToConfirm({ onComplete, label }: { onComplete: () => Promise<boolean>; label: string }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [locked, setLocked] = useState(false);
  const travel = useRef(1);

  const span = () => {
    const t = trackRef.current;
    travel.current = t ? Math.max(1, t.clientWidth - 62) : 1;
    return travel.current;
  };

  function move(clientX: number) {
    const t = trackRef.current;
    if (!t) return;
    const left = t.getBoundingClientRect().left;
    setX(Math.min(span(), Math.max(0, clientX - left - 31)));
  }

  async function release() {
    setDragging(false);
    if (x >= span() * 0.85) {
      setLocked(true);
      setX(span());
      const ok = await onComplete();
      if (!ok) {
        // Rejected — hand the control back rather than stranding it at the end.
        setLocked(false);
        setX(0);
      }
      return;
    }
    setX(0);
  }

  const pct = Math.round((x / travel.current) * 100);

  return (
    <div
      ref={trackRef}
      className="relative flex-none h-[58px] rounded-full bg-side border border-line2 overflow-hidden select-none touch-none"
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      tabIndex={0}
      onKeyDown={async (e) => {
        // Keyboard equivalent: the gesture cannot be the only way in.
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (!locked) {
            setLocked(true);
            const ok = await onComplete();
            if (!ok) setLocked(false);
          }
        }
      }}
      onPointerDown={(e) => {
        if (locked) return;
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        setDragging(true);
        move(e.clientX);
      }}
      onPointerMove={(e) => dragging && move(e.clientX)}
      onPointerUp={release}
      onPointerCancel={release}
    >
      {/* Filled portion, growing behind the handle. */}
      <div
        className="absolute inset-y-0 left-0"
        style={{
          // Starts at nothing: at rest the track is dark and only the handle's
          // glow is green, as in the reference. A fill that already had width
          // before the drag began read as a stub of progress that was not there.
          width: x,
          background: "var(--green)",
          opacity: 0.35 + (x / travel.current) * 0.45,
          transition: dragging ? "none" : "width .22s ease, opacity .22s ease",
        }}
      />
      <span className="absolute inset-0 grid place-items-center text-[13px] font-bold text-ink pointer-events-none px-14 text-center">
        {label}
      </span>
      <div
        className="absolute top-[4px] left-0 w-[50px] h-[50px] rounded-full bg-white grid place-items-center text-[17px] text-[#111] cursor-grab active:cursor-grabbing"
        style={{
          transform: `translateX(${x + 4}px)`,
          transition: dragging ? "none" : "transform .22s ease",
          boxShadow: "0 4px 14px rgba(0,0,0,.35), 0 0 18px 4px color-mix(in oklab, var(--green) 55%, transparent)",
        }}
      >
        →
      </div>
    </div>
  );
}

/** The success state: the whole screen, briefly. */
export function SuccessWash({ label }: { label: string }) {
  return (
    <div
      data-wash
      className="fixed inset-0 z-[80] grid place-items-center"
      style={{ background: "radial-gradient(120% 90% at 50% 38%, #12a06a 0%, #0b6b47 45%, #052e21 100%)", animation: "washIn .18s ease" }}
      role="status"
    >
      <div className="flex items-center gap-2 -mt-16 text-white">
        <span className="w-5 h-5 rounded-full bg-white/90 grid place-items-center text-[12px] text-[#0f7a52] font-black" aria-hidden>✓</span>
        <span className="text-[15px] font-semibold">{label}</span>
      </div>
    </div>
  );
}

/**
 * The digits under the ₹, for an entry that may be an expression.
 *
 * Formatting the raw string stopped working the moment the keypad grew
 * operators — "500+250" has no integer part to group — so the display shows
 * what the entry EVALUATES to. The expression itself is shown on its own line
 * above, so nothing is hidden.
 */
export function displayDigits(raw: string): string {
  if (!raw) return "0";
  const rupees = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(partialAmount(raw) / 100);
  // A plain number keeps its trailing point while it is being typed — "12."
  // collapsing back to "12" reads as the tap not registering.
  return !looksLikeExpression(raw) && raw.endsWith(".") ? `${rupees}.` : rupees;
}

/** The amount, and the working above it when there is arithmetic to show. */
export function AmountHero({ entry, sign, tint }: { entry: string; sign: string; tint: string }) {
  return (
    <>
      {looksLikeExpression(entry) && (
        <div className="text-[15px] font-semibold text-mut2 tabular-nums select-none" aria-hidden>
          {entry}
        </div>
      )}
      <div className="flex items-baseline justify-center gap-1 select-none" aria-live="polite">
        <span className="text-[30px] font-bold leading-none" style={{ color: tint }}>{sign}</span>
        <span className="text-[30px] font-semibold leading-none text-mut2">₹</span>
        <span className="text-[54px] font-extrabold leading-none tabular-nums tracking-tight">{displayDigits(entry)}</span>
      </div>
    </>
  );
}

/**
 * The keypad: clear and backspace above, then the sixteen keys AmountKeypad
 * defines. Imported from there rather than restated so the two can never offer
 * different arithmetic.
 */
export function EntryKeypad({ press }: { press: (key: string) => void }) {
  return (
    <>
      <div className="flex justify-end gap-2 flex-none">
        <button
          onClick={() => press("clear")}
          aria-label="Clear amount"
          className="min-h-[38px] px-4 rounded-[12px] bg-side border-none text-[13px] font-bold text-mut2 cursor-pointer active:brightness-125 select-none"
        >
          C
        </button>
        <button
          onClick={() => press("back")}
          aria-label="Backspace"
          className="min-h-[38px] px-4 rounded-[12px] bg-side border-none text-[15px] font-semibold text-mut2 cursor-pointer active:brightness-125 select-none"
        >
          ⌫
        </button>
      </div>

      <div className="grid grid-cols-4 gap-2 flex-none">
        {GRID.map((k) => (
          <button
            key={k.label}
            onClick={() => press(k.insert ?? "")}
            aria-label={k.aria}
            className={`min-h-[52px] rounded-[18px] border-none text-[20px] font-semibold cursor-pointer active:brightness-125 select-none grid place-items-center ${
              k.kind === "operator" ? "bg-accsoft text-acc" : "bg-side text-ink"
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>
    </>
  );
}

/** One metadata chip. `unset` reads as an invitation rather than a value. */
export interface EntryChip {
  key: string;
  icon: string;
  /** The field's name, for the accessible label — "Category", "Date". */
  what: string;
  label: string;
  unset: boolean;
}

export function MetaChips({ chips, onPick }: { chips: EntryChip[]; onPick: (key: string) => void }) {
  return (
    <div className="flex items-center justify-center gap-2 flex-wrap flex-none">
      {chips.map((c) => (
        <button
          key={c.key}
          onClick={() => onPick(c.key)}
          aria-label={c.unset ? `Choose a ${c.what.toLowerCase()}` : `${c.what}: ${c.label}`}
          data-unset={c.unset ? "" : undefined}
          className={`inline-flex items-center gap-1.5 px-3 min-h-[36px] rounded-full border border-line2 bg-transparent text-[12px] font-semibold cursor-pointer hover:bg-accsoft max-w-[46vw] ${
            c.unset ? "text-mut2" : "text-ink"
          }`}
        >
          <span aria-hidden className="text-[12px] opacity-70">{c.icon}</span>
          <span className="truncate">{c.label}</span>
        </button>
      ))}
    </div>
  );
}
