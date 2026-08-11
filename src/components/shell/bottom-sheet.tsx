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

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "./use-focus-trap";

/**
 * The visible viewport, i.e. what's left after the on-screen keyboard.
 *
 * `100dvh` is not enough here. The dynamic viewport unit follows browser
 * chrome (the collapsing address bar), but on Android the keyboard overlays
 * the page WITHOUT resizing the layout viewport, so a sheet anchored to the
 * layout bottom keeps roughly its lower half underneath the keyboard. That is
 * why searching for a category and getting one result put that result out of
 * reach: the sheet had not moved, the keyboard had covered it.
 *
 * visualViewport reports the actually-visible rectangle, so the sheet can be
 * sized and positioned against that instead. Returns null until measured and
 * on browsers without the API, where the existing dvh behaviour is kept.
 */
function useVisualViewport() {
  const [vv, setVv] = useState<{ height: number; offsetTop: number } | null>(null);
  useEffect(() => {
    const v = window.visualViewport;
    if (!v) return;
    const sync = () => setVv({ height: v.height, offsetTop: v.offsetTop });
    sync();
    v.addEventListener("resize", sync);
    v.addEventListener("scroll", sync);
    return () => {
      v.removeEventListener("resize", sync);
      v.removeEventListener("scroll", sync);
    };
  }, []);
  return vv;
}

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
  const vv = useVisualViewport();
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
    <div
      onClick={onClose}
      className="fixed left-0 right-0 flex items-end md:items-center md:justify-center"
      style={{
        background: "var(--ov)",
        zIndex: z,
        // Pin the overlay to the VISIBLE rectangle when we can measure it, so
        // `items-end` means "above the keyboard" rather than "under it".
        // Falls back to inset-0 where visualViewport isn't available.
        top: vv ? vv.offsetTop : 0,
        height: vv ? vv.height : undefined,
        bottom: vv ? undefined : 0,
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        className={`w-full ${vv ? "" : "max-h-[92dvh]"} md:max-h-[88vh] overflow-y-auto bg-card rounded-t-[20px] md:rounded-[20px] px-4 pt-3 flex flex-col outline-none ${className}`}
        style={{
          animation: "rise .22s ease",
          paddingBottom: "calc(16px + env(safe-area-inset-bottom))",
          boxShadow: "var(--shLg)",
          maxWidth: `min(100%, ${maxWidth}px)`,
          // 92% of what's visible, matching the dvh behaviour it replaces.
          ...(vv ? { maxHeight: Math.round(vv.height * 0.92) } : {}),
        }}
      >
        <div className="w-[38px] h-1 rounded-sm bg-line2 mx-auto mb-3 md:hidden" />
        {children}
      </div>
    </div>,
    document.body,
  );
}
