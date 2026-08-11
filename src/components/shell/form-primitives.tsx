"use client";

// Small, generic building blocks shared by every modal form (create *and*
// edit) — kept dependency-free of any specific form's business logic so
// reuse never grows into coupling.

import { useRouter } from "next/navigation";
import { useRef, useState, useId } from "react";
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

  // Resolve the expression to its result when the field loses focus, so every
  // existing caller keeps receiving a plain numeric string and nothing
  // downstream (toPaise, validation, the offline outbox) has to learn about
  // arithmetic. Tapping a button blurs the field first, so Save sees the
  // resolved number.
  const settle = () => {
    if (result?.ok) onChange(String(result.paise / 100));
  };

  return (
    <>
      <input
        // Deliberately text, not number: a number input silently refuses "+",
        // "(" and "%" so the expression could never be typed. It also drops
        // the spinner arrows (meaningless for currency) and the scroll-wheel
        // capture that could change an amount while scrolling past it.
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={settle}
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
