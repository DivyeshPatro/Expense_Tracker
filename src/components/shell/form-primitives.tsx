"use client";

// Small, generic building blocks shared by every modal form (create *and*
// edit) — kept dependency-free of any specific form's business logic so
// reuse never grows into coupling.

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useId } from "react";
import { AmountKeypad, useCoarsePointer } from "./amount-keypad";
import type { ActionResult } from "@/app/actions";
import { evaluateAmount, looksLikeExpression } from "@/lib/expression";
import { formatPaise } from "@/lib/money";
import { useUI } from "./ui-context";

export function useSubmit() {
  const { closeModal, showToast } = useUI();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // a ref, not just `busy` state: two clicks landing in the same tick both
  // fire before React commits the disabled attribute, so the DOM-level
  // guard alone can't stop a true double-tap from submitting twice — this
  // check is synchronous and closes that gap (offline-sync spec §17 Phase 2
  // exit criterion: "double-tap submit produces one intent")
  const inFlight = useRef(false);
  async function run(
    action: () => Promise<ActionResult & { queued?: boolean }>,
    successMsg: string | ((res: ActionResult & { queued?: boolean }) => string)
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const res = await action();
    inFlight.current = false;
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    closeModal();
    showToast(typeof successMsg === "function" ? successMsg(res) : successMsg);
    // a queued (offline) create changed nothing server-side — refreshing would
    // fire a doomed RSC fetch; the local echo renders from the outbox instead,
    // and the drain refreshes when the change actually lands
    if (!res.queued) router.refresh();
  }
  return { run, busy, error };
}

/**
 * Issue #197/#198: progressive disclosure for the entry forms.
 *
 * Add Expense showed nine controls at once — Amount, Account, Category,
 * Merchant, Date, Notes, Group, the split editor and the repeat block — of
 * which exactly two are required. The two-tap path existed but nobody saw it;
 * they saw a nine-field form.
 *
 * Amount and Category stay above this; everything else lives inside. A native
 * <details> so it needs no JS, is keyboard- and screen-reader-operable for
 * free, and can be opened by default when a caller has pre-filled something
 * inside it (duplicating a transaction, say) — hiding a value the user can see
 * they set would be worse than showing the field.
 */
export function AdvancedFields({
  children,
  defaultOpen = false,
  summary = "More details",
  hint,
}: {
  children: React.ReactNode;
  defaultOpen?: boolean;
  summary?: string;
  hint?: string;
}) {
  return (
    <details open={defaultOpen} className="group border-t border-line pt-2.5">
      <summary className="list-none cursor-pointer select-none min-h-[44px] flex items-center gap-1.5 text-[13px] font-semibold text-mut hover:text-ink">
        <span aria-hidden className="transition-transform group-open:rotate-90 text-[15px] leading-none">›</span>
        {summary}
        {hint && <span className="text-[11.5px] font-medium text-mut2">— {hint}</span>}
      </summary>
      <div className="flex flex-col gap-3 pt-2.5">{children}</div>
    </details>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  // An implicit <label> (wrapping its control) rather than a plain <div> —
  // every form across the app uses this, and axe-core's select-name/
  // label finding on the expense form's selects was really this component,
  // not a one-off. Browsers only forward the label's click-to-focus
  // behavior to the first labelable control, so Fields that also nest a
  // non-form element (e.g. a "Clear" button next to a DateField) are
  // unaffected — buttons handle their own clicks regardless.
  return (
    <label className="flex-1 min-w-[130px] block">
      <div className="label-caps">{label}</div>
      {children}
    </label>
  );
}

export function AmountInput({
  value,
  onChange,
  autoFocus,
  disabled,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  /** For amount fields that repeat on a page, where the visible "AMOUNT (₹)"
   * label alone doesn't say which row it belongs to. */
  ariaLabel?: string;
}) {
  const hintId = useId();
  const trimmed = value.trim();
  const isExpr = looksLikeExpression(trimmed);
  // Only evaluated for the preview; the stored value is normalised on blur.
  const result = isExpr ? evaluateAmount(trimmed) : null;

  const inputRef = useRef<HTMLInputElement>(null);
  const coarse = useCoarsePointer();
  const [focused, setFocused] = useState(false);

  // The modal auto-focuses this field on open, inside a rAF, which can land
  // before React attaches the onFocus handler — so `focused` stayed false while
  // the field WAS the active element. With inputMode="none" already suppressing
  // the OS keyboard, that left a focused amount field with no keyboard and no
  // keypad: nothing to type with at all, on the app's most common action.
  // Checking activeElement on mount closes that gap; onFocus still handles
  // every later focus.
  useEffect(() => {
    if (inputRef.current && document.activeElement === inputRef.current) setFocused(true);
  }, []);
  // Keypad only on touch, and only while the field is being used. On desktop a
  // physical keyboard is faster than any grid, and the input stays typable on
  // every device so assistive tech is never routed through a custom widget.
  const showKeypad = coarse && focused && !disabled;

  // Resolve the expression to its result when the field loses focus, so every
  // existing caller keeps receiving a plain numeric string and nothing
  // downstream (toPaise, validation, the offline outbox) has to learn about
  // arithmetic. Tapping a button blurs the field first, so Save sees the
  // resolved number.
  const settle = () => {
    if (result?.ok) onChange(String(result.paise / 100));
  };

  // Keypad edits are applied against these refs, not against the `value` prop
  // and the live DOM caret.
  //
  // Why: `value` only updates when the parent re-renders, and the DOM caret is
  // only repositioned on the next frame. Two taps landing before either
  // catches up both read the same stale state, and the second overwrites the
  // first — measured as eight taps producing "2500+1%", silently losing the 8.
  // Dropped input is worse than lag, and a fast one-handed user is exactly who
  // this feature is for. Refs update synchronously inside the handler, so a
  // burst of taps composes correctly no matter how React schedules the renders.
  const pendingRef = useRef(value);
  const caretRef = useRef<number | null>(null);

  // Resync whenever the value changes from outside the keypad — typing,
  // merchant recall, a prefill, or `settle()` collapsing an expression.
  useEffect(() => {
    if (pendingRef.current !== value) {
      pendingRef.current = value;
      caretRef.current = null;
    }
  }, [value]);

  /** Current caret, preferring our own tracked position over the lagging DOM. */
  const readCaret = (): { start: number; end: number } => {
    const el = inputRef.current;
    const len = pendingRef.current.length;
    if (caretRef.current !== null) return { start: caretRef.current, end: caretRef.current };
    if (!el) return { start: len, end: len };
    return { start: el.selectionStart ?? len, end: el.selectionEnd ?? len };
  };

  const commit = (next: string, caret: number) => {
    pendingRef.current = next;
    caretRef.current = caret;
    onChange(next);
    // Best-effort caret restore once React has committed the new value.
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(caret, caret));
  };

  /**
   * Insert at the caret rather than appending, so tapping into the middle of
   * "250+80" and adding a digit does what it looks like it does.
   */
  const insertAtCaret = (text: string) => {
    const { start, end } = readCaret();
    const cur = pendingRef.current;
    commit(cur.slice(0, start) + text + cur.slice(end), start + text.length);
  };

  const backspaceAtCaret = () => {
    const { start, end } = readCaret();
    const cur = pendingRef.current;
    // A selection deletes the selection; a caret deletes the character before it.
    const from = start === end ? Math.max(0, start - 1) : start;
    commit(cur.slice(0, from) + cur.slice(end), from);
  };

  const clearAll = () => commit("", 0);

  // Suppressing the OS keyboard removes the only way to paste, and amounts get
  // pasted out of UPI and bank SMS constantly — hence an explicit control.
  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      // Keep only what the expression parser can read, so pasting a whole SMS
      // yields the number in it rather than an error.
      const cleaned = text.replace(/[^0-9+\-*/%().×÷\s]/g, "").trim();
      if (cleaned) insertAtCaret(cleaned);
    } catch {
      // Denied permission or no clipboard API — the field is still typable.
    }
  };

  return (
    <>
      <input
        // Deliberately text, not number: a number input silently refuses "+",
        // "(" and "%" so the expression could never be typed. It also drops
        // the spinner arrows (meaningless for currency) and the scroll-wheel
        // capture that could change an amount while scrolling past it.
        ref={inputRef}
        type="text"
        // "none" suppresses the OS keyboard so only Ledgerly's keypad shows —
        // but only on touch. Desktop and any device without a coarse pointer
        // keep "decimal" and behave exactly as before.
        inputMode={coarse ? "none" : "decimal"}
        onFocus={() => setFocused(true)}
        autoComplete="off"
        value={value}
        onChange={(e) => {
          // Typed input moves the caret itself; drop our tracked position so
          // the next keypad press reads the real one.
          caretRef.current = null;
          pendingRef.current = e.target.value;
          onChange(e.target.value);
        }}
        onBlur={(e) => {
          settle();
          // A keypad key preventDefaults mousedown so focus never leaves — but
          // taps elsewhere should close it. relatedTarget is the element being
          // focused next; null (or outside the group) means we're really gone.
          const next = e.relatedTarget as HTMLElement | null;
          if (next?.closest?.('[aria-label="Amount keypad"]')) return;
          // Deferred, not immediate: unmounting the keypad removes ~293px of
          // reserved space and the sheet drops that far. Doing it synchronously
          // on blur moves the layout BETWEEN pointerdown and click, so the tap
          // that was aimed at Merchant landed on backdrop instead. Waiting for
          // the current gesture to finish keeps the target under the finger.
          setTimeout(() => setFocused(false), 0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") settle();
        }}
        placeholder="0"
        autoFocus={autoFocus}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={result && !result.ok ? true : undefined}
        aria-describedby={isExpr ? hintId : undefined}
        className="field !py-3 !text-[19px] !font-bold disabled:opacity-60 disabled:cursor-not-allowed"
      />
      {/* The preview is what makes arithmetic safe to allow at all: the
          resolved figure is visible before saving, so a convention like
          "2500+18% = 2950" is never something the user has to guess.
          role="status" is polite — it must not interrupt typing. */}
      {isExpr && result && (
        <div
          id={hintId}
          role="status"
          aria-live="polite"
          className="text-[12px] font-semibold mt-1 tabular-nums"
          style={{ color: result.ok ? "var(--green)" : "var(--red)" }}
        >
          {result.ok ? `= ${formatPaise(result.paise)}` : result.error}
        </div>
      )}
      {showKeypad && (
        <AmountKeypad
          onInsert={insertAtCaret}
          onBackspace={backspaceAtCaret}
          onClear={clearAll}
          onPaste={pasteFromClipboard}
        />
      )}
    </>
  );
}

export function SubmitButton({
  busy,
  color,
  children,
  onClick,
}: {
  busy: boolean;
  color?: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  // Sticky footer flush to the bottom of the modal's scroll body: `-mb`
  // cancels the body's bottom padding so it sits at the true edge, a matching
  // background + hairline lets the form scroll under it, and it stays put when
  // the keyboard is open (the panel is sized to the visible viewport). The
  // 48px min height is a comfortable one-thumb target.
  return (
    <div className="sticky bottom-0 -mx-[22px] -mb-[22px] mt-1 px-[22px] pt-2.5 bg-card border-t border-line z-10" style={{ paddingBottom: "calc(14px + env(safe-area-inset-bottom))" }}>
      <button
        onClick={onClick}
        disabled={busy}
        className="w-full min-h-[48px] p-3.5 rounded-[12px] text-white text-[14px] font-bold text-center cursor-pointer border-none hover:brightness-108 disabled:opacity-60"
        style={{ background: color ?? "var(--acc)" }}
      >
        {busy ? "…" : children}
      </button>
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="text-[12.5px] font-semibold text-red bg-redsoft rounded-lg px-3 py-2">{error}</div>;
}
