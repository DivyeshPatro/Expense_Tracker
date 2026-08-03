"use client";

// The one bottom-sheet used across the app — Quick Add, the Bills action
// sheet, the Dashboard "Customize" sheet, and the mobile period picker all
// render through this. It is a bottom sheet on phones and a centred dialog on
// wider screens, and owns the parts every sheet needs identically: a portal to
// <body>, an overlay that dismisses on backdrop tap, a focus trap, Escape to
// close, initial focus, a drag handle, safe-area padding, and the rise
// entrance. Callers supply only the content.
//
// Not for: the transaction modal shell (modals.tsx — keyboard-aware sticky
// footer) or the period picker's desktop popover (anchored to its trigger),
// which are deliberately their own components.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "./use-focus-trap";

export function BottomSheet({
  onClose,
  label,
  children,
  maxWidth = 440,
  className = "",
  z = 55,
}: {
  /** Backdrop tap and Escape both call this. */
  onClose: () => void;
  /** Accessible name for the dialog. */
  label: string;
  children: React.ReactNode;
  /** Desktop dialog max width in px (mobile is always full-width). */
  maxWidth?: number;
  /** Extra classes for the panel (e.g. gap/spacing overrides). */
  className?: string;
  /** Overlay z-index. Default 55; raise it above another overlay when the
   * sheet opens from within one (e.g. a picker inside the z-60 modal). */
  z?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Respect a control that autoFocused inside (e.g. a confirm input);
    // otherwise take focus onto the panel so the trap has an anchor.
    if (!el.contains(document.activeElement)) el.focus();
  }, []);

  return createPortal(
    <div onClick={onClose} className="fixed inset-0 flex items-end md:items-center md:justify-center" style={{ background: "var(--ov)", zIndex: z }}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-h-[92dvh] md:max-h-[88vh] overflow-y-auto bg-card rounded-t-[20px] md:rounded-[20px] px-4 pt-3 flex flex-col outline-none ${className}`}
        style={{ animation: "rise .22s ease", paddingBottom: "calc(16px + env(safe-area-inset-bottom))", boxShadow: "var(--shLg)", maxWidth: `min(100%, ${maxWidth}px)` }}
      >
        <div className="w-[38px] h-1 rounded-sm bg-line2 mx-auto mb-3 md:hidden" />
        {children}
      </div>
    </div>,
    document.body,
  );
}
