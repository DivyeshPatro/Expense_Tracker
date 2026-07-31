"use client";

// The checkout helper — the reason this module exists.
//
// You've copied the card details and you're now in the payment form. The one
// thing you must not have to do is go back, re-enter your password, and find
// the card again just to read the CVV. So for sixty seconds after "Copy card
// details" the fields stay one tap away, each copying on its own.
//
// Sixty seconds, then it's gone. That's about as long as filling a payment form
// takes, and it's short enough that walking away from the phone doesn't leave a
// card number on screen. There is no "keep open" — an indefinitely open helper
// is just a card number on a screen, which is what this whole module avoids.
//
// Nothing here is persisted. The details live in this component's props and
// disappear with it: no localStorage, no sessionStorage, no service worker
// cache. A reload asks for the password again, by construction.

import { createPortal } from "react-dom";
import { useState } from "react";
import { useUI } from "@/components/shell/ui-context";
import { formatCardNumber, formatExpiry } from "@/lib/card-identity";
import { copyText } from "@/lib/clipboard";
import type { CreditCardListItem, RevealedCreditCard } from "@/server/services/credit-cards";
import { useCountdown } from "./use-countdown";
import { useDocumentPip } from "./use-document-pip";

/** How long the helper stays available after copying. */
export const CHECKOUT_MS = 60_000;

export function CheckoutHelper({
  card,
  revealed,
  onClose,
}: {
  card: CreditCardListItem;
  revealed: RevealedCreditCard;
  onClose: () => void;
}) {
  const remaining = useCountdown(CHECKOUT_MS, onClose);
  const pip = useDocumentPip();

  const body = <HelperBody card={card} revealed={revealed} remaining={remaining} onClose={onClose} pip={pip} />;

  // Popped out, the bottom sheet would be a second copy of the same secrets on
  // a second screen — so it moves rather than duplicates.
  if (pip.pipWindow) {
    return createPortal(
      <div className="bg-bg text-ink p-3 box-border min-h-screen">{body}</div>,
      pip.pipWindow.document.body
    );
  }

  return (
    <div
      className="fixed inset-x-0 z-[70] px-3 print:hidden"
      // Clear of the mobile tab bar and the home indicator — the helper is used
      // one-handed on a phone, and sitting under the nav makes it untappable.
      style={{ bottom: "calc(72px + env(safe-area-inset-bottom))" }}
    >
      <div
        className="mx-auto max-w-[520px] rounded-[14px] border border-line2 bg-card p-3"
        style={{ boxShadow: "var(--shLg)", animation: "rise .2s ease" }}
      >
        {body}
      </div>
    </div>
  );
}

function HelperBody({
  card,
  revealed,
  remaining,
  onClose,
  pip,
}: {
  card: CreditCardListItem;
  revealed: RevealedCreditCard;
  remaining: number;
  onClose: () => void;
  pip: ReturnType<typeof useDocumentPip>;
}) {
  const { showToast } = useUI();
  const [copied, setCopied] = useState<string | null>(null);
  const expiry = formatExpiry(revealed.expiryMonth, revealed.expiryYear);
  const seconds = Math.ceil(remaining / 1000);

  async function copy(label: string, value: string) {
    const ok = await copyText(value);
    if (!ok) {
      showToast("Couldn't copy — select the text instead");
      return;
    }
    // Feedback lands inside the helper rather than as a toast: in the PiP
    // window the app's toast is on the other screen entirely.
    setCopied(label);
    setTimeout(() => setCopied((c) => (c === label ? null : c)), 1400);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="text-[12.5px] font-extrabold flex-1 min-w-0 truncate">
          {card.nickname} <span className="text-mut2 font-semibold">•••• {card.last4}</span>
        </div>
        <div className="text-[11.5px] font-bold tabular-nums" style={{ color: seconds <= 10 ? "var(--red)" : "var(--mut)" }}>
          {seconds}s
        </div>
        {pip.supported && !pip.pipWindow && (
          <button
            onClick={() => void pip.open(320, 260)}
            title="Keep this on top while you pay"
            className="px-2 py-1 rounded-lg border border-line2 text-[11px] font-semibold text-acc cursor-pointer bg-transparent hover:bg-accsoft"
          >
            Pop out
          </button>
        )}
        <button
          onClick={onClose}
          aria-label="Close checkout helper"
          className="w-6 h-6 rounded-lg grid place-items-center text-mut cursor-pointer bg-transparent border-none hover:bg-accsoft"
        >
          ✕
        </button>
      </div>

      <div className="h-1 rounded-full bg-line2 overflow-hidden" aria-hidden>
        <div
          className="h-full rounded-full"
          style={{
            width: `${(remaining / CHECKOUT_MS) * 100}%`,
            background: seconds <= 10 ? "var(--red)" : "var(--acc)",
            transition: "width .25s linear",
          }}
        />
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <Chip label="Number" hint={formatCardNumber(revealed.cardNumber)} copied={copied === "Number"} onClick={() => void copy("Number", revealed.cardNumber)} wide />
        <Chip label="Expiry" hint={expiry} copied={copied === "Expiry"} onClick={() => void copy("Expiry", expiry)} />
        <Chip label="CVV" hint={revealed.cvv} copied={copied === "CVV"} onClick={() => void copy("CVV", revealed.cvv)} />
        <Chip label="Name" hint={revealed.cardholderName} copied={copied === "Name"} onClick={() => void copy("Name", revealed.cardholderName)} wide />
      </div>
    </div>
  );
}

function Chip({
  label,
  hint,
  copied,
  onClick,
  wide,
}: {
  label: string;
  hint: string;
  copied: boolean;
  onClick: () => void;
  wide?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      // A full-width tap target per field: this is used one-handed, mid-checkout,
      // often while holding something else.
      className={`flex items-center gap-2 px-2.5 py-2 rounded-[10px] border text-left cursor-pointer min-h-[44px] ${wide ? "col-span-2" : ""}`}
      style={{
        borderColor: copied ? "var(--acc)" : "var(--line2)",
        background: copied ? "var(--accsoft)" : "var(--side)",
      }}
    >
      <div className="flex-1 min-w-0">
        <div className="text-[9.5px] uppercase tracking-wider text-mut2 font-bold">{label}</div>
        <div className="text-[13px] font-semibold font-mono tabular-nums truncate">{hint}</div>
      </div>
      <span className="text-[11px] font-bold flex-none" style={{ color: copied ? "var(--acc)" : "var(--mut2)" }}>
        {copied ? "Copied ✓" : "Copy"}
      </span>
    </button>
  );
}
