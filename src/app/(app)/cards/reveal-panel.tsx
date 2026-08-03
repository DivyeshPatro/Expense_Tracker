"use client";

// The revealed card: the details, a copy button beside each, and a countdown.
//
// Auto-hide after 30 seconds is the whole design. A revealed card that stays
// revealed is a card number sitting on a screen someone walks past, and the
// realistic failure isn't an attacker — it's you, having filled the form,
// switching tabs and forgetting the panel is open behind them.
//
// The countdown is computed from an absolute deadline rather than by
// decrementing a counter each tick. Browsers throttle timers in background
// tabs, so a decrementing counter would pause while the tab is hidden and the
// card would stay revealed for as long as you were away — the exact case the
// timer exists for.

import { logCardAccessAction } from "@/app/actions";
import { useUI } from "@/components/shell/ui-context";
import { copyText } from "@/lib/clipboard";
import { useCountdown } from "./use-countdown";
import { formatCardNumber, formatExpiry } from "@/lib/card-identity";
import type { CreditCardListItem, RevealedCreditCard } from "@/server/services/credit-cards";

/** How long a reveal stays on screen. */
export const REVEAL_MS = 30_000;

export function RevealPanel({
  card,
  revealed,
  onHide,
  onCheckout,
}: {
  card: CreditCardListItem;
  revealed: RevealedCreditCard;
  onHide: () => void;
  /** Copying everything is the signal that you're mid-checkout, so it hands
   *  over to the helper rather than starting a 30-second clock you'll lose. */
  onCheckout: () => void;
}) {
  const { showToast } = useUI();
  const remaining = useCountdown(REVEAL_MS, onHide);

  const number = formatCardNumber(revealed.cardNumber);
  const expiry = formatExpiry(revealed.expiryMonth, revealed.expiryYear);

  // The copy itself is local and instant; the audit ping is fire-and-forget so
  // it never delays the clipboard write or blocks the checkout hand-off.
  async function copy(label: string, value: string, access?: "copy-number" | "copy-expiry" | "copy-cvv" | "copy-details") {
    if (access) void logCardAccessAction(card.id, access);
    showToast((await copyText(value)) ? `${label} copied` : "Couldn't copy — select the text instead");
  }

  return (
    <div className="mt-2.5 flex flex-col gap-2 p-3 rounded-[12px] border border-line2 bg-card" style={{ animation: "rise .2s ease" }}>
      <div className="flex items-center gap-2">
        <div className="text-[11.5px] font-bold text-mut flex-1">Visible for {Math.ceil(remaining / 1000)}s</div>
        <button
          onClick={onHide}
          className="px-2 py-1 rounded-lg border border-line2 text-[11px] font-semibold text-mut cursor-pointer bg-transparent hover:bg-accsoft"
        >
          Hide now
        </button>
      </div>
      {/* A bar, not just a number: at a checkout you're watching it out of the
          corner of your eye while typing into another field. */}
      <div className="h-1 rounded-full bg-line2 overflow-hidden" aria-hidden>
        <div
          className="h-full rounded-full"
          style={{ width: `${(remaining / REVEAL_MS) * 100}%`, background: "var(--acc)", transition: "width .25s linear" }}
        />
      </div>

      <SecretRow label="Card number" value={number} mono onCopy={() => copy("Card number", revealed.cardNumber, "copy-number")} />
      <div className="flex gap-2">
        <SecretRow label="Expiry" value={expiry} mono grow onCopy={() => copy("Expiry", expiry, "copy-expiry")} />
        <SecretRow label="CVV" value={revealed.cvv} mono grow onCopy={() => copy("CVV", revealed.cvv, "copy-cvv")} />
      </div>
      <SecretRow label="Name" value={revealed.cardholderName} onCopy={() => copy("Cardholder name", revealed.cardholderName)} />
      {revealed.notes && <SecretRow label="Notes" value={revealed.notes} onCopy={() => copy("Notes", revealed.notes!)} />}

      <button
        onClick={async () => {
          await copy(
            "Card details",
            // The order a checkout form asks for them, so pasting into one
            // field at a time follows the same sequence top to bottom.
            [revealed.cardNumber, expiry, revealed.cvv, revealed.cardholderName].join("\n"),
            "copy-details"
          );
          onCheckout();
        }}
        className="btn-primary mt-0.5"
      >
        Copy card details
      </button>
      <div className="text-[11px] text-mut2">
        {card.nickname} · the clipboard keeps what you copy until you copy something else.
      </div>
    </div>
  );
}

function SecretRow({
  label,
  value,
  onCopy,
  mono,
  grow,
}: {
  label: string;
  value: string;
  onCopy: () => void;
  mono?: boolean;
  grow?: boolean;
}) {
  return (
    <div className={`flex items-center gap-2 px-2.5 py-2 rounded-[9px] bg-side ${grow ? "flex-1 min-w-0" : ""}`}>
      <div className="flex-1 min-w-0">
        <div className="text-[9.5px] uppercase tracking-wider text-mut2 font-bold">{label}</div>
        <div className={`text-[13px] font-semibold truncate ${mono ? "font-mono tracking-wide tabular-nums" : ""}`}>{value}</div>
      </div>
      <button
        onClick={onCopy}
        aria-label={`Copy ${label.toLowerCase()}`}
        className="px-2 py-1.5 rounded-lg border border-line2 text-[11px] font-semibold text-acc cursor-pointer bg-card hover:bg-accsoft flex-none"
      >
        Copy
      </button>
    </div>
  );
}
