"use client";

import { useEffect } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Traps Tab/Shift+Tab focus cycling within `ref`'s subtree while `active` is
 * true — the missing half of a dialog's expected keyboard behavior.
 * Escape-to-close (useEscapeToClose in app-shell.tsx) and initial focus are
 * handled separately by each caller; this is what stops Tab from leaking out
 * to the page behind the overlay, letting a keyboard/screen-reader user get
 * stranded outside the dialog they're supposedly still "in".
 */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const focusable = Array.from(container!.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = document.activeElement;
      const inside = activeEl instanceof Node && container!.contains(activeEl);
      if (e.shiftKey) {
        if (!inside || activeEl === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (!inside || activeEl === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [ref, active]);
}
