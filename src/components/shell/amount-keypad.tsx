"use client";

// Ledgerly's own amount keypad — an input method for the expression engine
// that already exists in lib/expression.ts, not a second calculator.
//
// Layout: digits in a 3-wide grid with an accent operator rail on the right,
// and a slim utility strip above it for brackets, percent, clear, backspace
// and paste. Operators are permanently visible on purpose: arithmetic in the
// amount field is the whole point of the feature, and hiding it behind a
// disclosure chip is how merchant recall ended up shipped-but-unused.
//
// Deliberately NOT here: an expression line and a live result. The amount
// field sits directly above this and already shows both. A second copy would
// be two sources of truth for one string, and ~70px of a 390x844 phone.
//
// Touch only. On desktop a physical keyboard beats any on-screen grid, and
// forcing screen-reader or switch-access users through a custom widget is a
// regression — the underlying <input> always stays typable.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** CSS var carrying the keypad's height so layouts above it can reserve space. */
export const KEYPAD_HEIGHT_VAR = "--keypad-h";

export interface KeypadKey {
  /** What gets inserted. Undefined for actions. */
  insert?: string;
  label: string;
  /** Spoken name — "7" and "÷" read poorly on their own. */
  aria: string;
  action?: "backspace" | "clear" | "paste";
  kind: "digit" | "operator" | "utility";
}

const UTILITY: KeypadKey[] = [
  { insert: "(", label: "(", aria: "Open bracket", kind: "utility" },
  { insert: ")", label: ")", aria: "Close bracket", kind: "utility" },
  { insert: "%", label: "%", aria: "Percent", kind: "utility" },
  { label: "C", aria: "Clear amount", action: "clear", kind: "utility" },
  { label: "⌫", aria: "Delete last character", action: "backspace", kind: "utility" },
  { label: "📋", aria: "Paste amount", action: "paste", kind: "utility" },
];

// Phone-style ascending rows (7-8-9 on top). Calculators and numeric keypads
// use this; only phone dialers invert it, and this is a calculator.
/** Exported so the full-screen composer lays out the SAME keys in its own
 *  grid. It cannot mount AmountKeypad itself — that one is portalled and fixed
 *  to the bottom of the viewport to dock under a modal, which would cover the
 *  composer's swipe-to-confirm bar — but the two must never offer different
 *  arithmetic. */
export const GRID: KeypadKey[] = [
  { insert: "7", label: "7", aria: "7", kind: "digit" },
  { insert: "8", label: "8", aria: "8", kind: "digit" },
  { insert: "9", label: "9", aria: "9", kind: "digit" },
  { insert: "÷", label: "÷", aria: "Divide", kind: "operator" },
  { insert: "4", label: "4", aria: "4", kind: "digit" },
  { insert: "5", label: "5", aria: "5", kind: "digit" },
  { insert: "6", label: "6", aria: "6", kind: "digit" },
  { insert: "×", label: "×", aria: "Multiply", kind: "operator" },
  { insert: "1", label: "1", aria: "1", kind: "digit" },
  { insert: "2", label: "2", aria: "2", kind: "digit" },
  { insert: "3", label: "3", aria: "3", kind: "digit" },
  { insert: "-", label: "−", aria: "Minus", kind: "operator" },
  { insert: ".", label: ".", aria: "Decimal point", kind: "digit" },
  { insert: "0", label: "0", aria: "0", kind: "digit" },
  // Earns its slot on rupee amounts — ₹1200 is 1, 2, 00.
  { insert: "00", label: "00", aria: "Double zero", kind: "digit" },
  { insert: "+", label: "+", aria: "Plus", kind: "operator" },
];

/** True on touch-first devices. Read in an effect so SSR and hydration agree. */
export function useCoarsePointer() {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    const sync = () => setCoarse(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return coarse;
}

export function AmountKeypad({
  onInsert,
  onBackspace,
  onClear,
  onPaste,
}: {
  onInsert: (text: string) => void;
  onBackspace: () => void;
  onClear: () => void;
  onPaste: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Publish the height so the modal can reserve space above it, exactly as it
  // already does for the OS keyboard's visualViewport inset. Without this the
  // keypad would cover the sticky Save button — a real keyboard gets out of the
  // way because the browser resizes the viewport; ours has to say so itself.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const publish = () => document.documentElement.style.setProperty(KEYPAD_HEIGHT_VAR, `${Math.round(el.getBoundingClientRect().height)}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty(KEYPAD_HEIGHT_VAR);
    };
  }, [mounted]);

  function press(k: KeypadKey) {
    if (k.action === "backspace") return onBackspace();
    if (k.action === "clear") return onClear();
    if (k.action === "paste") return onPaste();
    if (k.insert) onInsert(k.insert);
  }

  const keyClass =
    "grid place-items-center rounded-[12px] font-bold select-none cursor-pointer border " +
    // active:scale is the only motion, and globals.css already disables
    // transitions under prefers-reduced-motion.
    "active:scale-[.96] transition-transform";

  if (!mounted) return null;

  // Portalled and fixed to the bottom of the viewport, because a keyboard is
  // not a form field.
  //
  // Rendered inline it sat INSIDE the modal's 397px scroll body and competed
  // with the amount, merchant, category and Save for that space — the form and
  // the keypad squeezing each other. Docking it below the sheet means the form
  // scrolls above a stationary keypad, which is how every OS keyboard behaves
  // and what "should feel native" actually requires. It also makes the keypad
  // reusable outside modals, on any page with an amount field.
  return createPortal(
    <div
      ref={ref}
      // Not role="group" with a name only — a labelled region so a screen
      // reader user landing here knows what these 22 buttons belong to.
      role="group"
      aria-label="Amount keypad"
      className="fixed left-0 right-0 bottom-0 px-4 pt-2.5 border-t border-line2"
      style={{
        background: "var(--bg)",
        // Above the modal's z-60 so it docks under the sheet rather than behind it.
        zIndex: 70,
        paddingBottom: "calc(10px + env(safe-area-inset-bottom))",
        boxShadow: "0 -8px 24px rgba(0,0,0,.18)",
        animation: "rise .18s ease",
      }}
    >
      <div className="grid grid-cols-6 gap-1.5 mb-1.5 mx-auto" style={{ maxWidth: 460 }}>
        {UTILITY.map((k) => (
          <button
            key={k.label}
            type="button"
            // The field must keep focus and its caret: a button steals focus on
            // mousedown, which would collapse the selection and break inserting
            // at the cursor.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => press(k)}
            aria-label={k.aria}
            className={`${keyClass} min-h-[40px] text-[14px]`}
            style={{ background: "var(--card)", borderColor: "var(--line2)", color: "var(--mut)" }}
          >
            <span aria-hidden="true">{k.label}</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-1.5 mx-auto" style={{ maxWidth: 460 }}>
        {GRID.map((k) => (
          <button
            key={k.label}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => press(k)}
            aria-label={k.aria}
            // 52px comfortably clears the 44px floor .field was raised to.
            className={`${keyClass} min-h-[52px] ${k.kind === "operator" ? "text-[20px]" : "text-[19px]"}`}
            style={
              k.kind === "operator"
                ? { background: "var(--accSoft)", borderColor: "var(--line2)", color: "var(--acc)" }
                : { background: "var(--card)", borderColor: "var(--line2)", color: "var(--ink)" }
            }
          >
            <span aria-hidden="true">{k.label}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
