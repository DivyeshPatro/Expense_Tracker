"use client";

// The dialog shell used by every Cards overlay.
//
// Deliberately local rather than added to the global Modals registry in
// components/shell: those modals live in a provider mounted on every page and
// hold their state in shared context, which is the wrong home for a form that
// holds a decrypted CVV. Keeping these overlays inside the /cards route means
// their state unmounts when you navigate away.

import { useEffect, useRef } from "react";
import { useFocusTrap } from "@/components/shell/use-focus-trap";

export function CardDialog({
  title,
  onClose,
  children,
  width = "460px",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true);
  useEffect(() => panelRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div onClick={onClose} className="fixed inset-0 z-[60] flex items-end md:items-center justify-center p-0 md:p-4" style={{ background: "var(--ov)" }}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-h-[92vh] md:max-h-[88vh] overflow-auto bg-card rounded-t-[18px] rounded-b-none md:rounded-2xl p-[22px] box-border flex flex-col gap-[13px] outline-none"
        style={{
          width: `min(${width}, 100%)`,
          boxShadow: "var(--shLg)",
          animation: "rise .22s ease",
          paddingBottom: "calc(22px + env(safe-area-inset-bottom))",
        }}
      >
        <div className="flex justify-between items-center">
          <div className="text-base font-extrabold tracking-tight">{title}</div>
          <button onClick={onClose} aria-label="Close" className="w-7 h-7 rounded-lg grid place-items-center text-mut cursor-pointer bg-transparent border-none hover:bg-accsoft">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
