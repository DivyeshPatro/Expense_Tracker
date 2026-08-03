"use client";

// The dialog shell used by every Cards overlay.
//
// Deliberately local rather than added to the global Modals registry in
// components/shell: those modals live in a provider mounted on every page and
// hold their state in shared context, which is the wrong home for a form that
// holds a decrypted CVV. Keeping these overlays inside the /cards route means
// their state unmounts when you navigate away. It renders through the shared
// <BottomSheet> (portal, focus trap, Escape, backdrop, safe-area) and only adds
// the title header on top.

import { BottomSheet } from "@/components/shell/bottom-sheet";

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
  const maxWidth = parseInt(width, 10) || 460;
  return (
    <BottomSheet onClose={onClose} label={title} maxWidth={maxWidth} className="gap-[13px]">
      <div className="flex justify-between items-center">
        <div className="text-base font-extrabold tracking-tight">{title}</div>
        <button onClick={onClose} aria-label="Close" className="w-8 h-8 rounded-lg grid place-items-center text-mut cursor-pointer bg-transparent border-none hover:bg-accsoft">
          ✕
        </button>
      </div>
      {children}
    </BottomSheet>
  );
}
