// The card face shown in the gallery.
//
// It shows the last four digits and nothing else that is secret. There is no
// masked full number here because there is no full number here — the digits
// simply aren't in the payload this component receives. That's the difference
// between hiding a secret and not having it.

import { maskFromLast4, networkLabel } from "@/lib/card-identity";
import { cardGradient } from "@/lib/card-visual";
import type { CreditCardListItem } from "@/server/services/credit-cards";

export function CardFace({
  card,
  children,
}: {
  card: CreditCardListItem;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="relative rounded-[16px] p-[18px] text-white flex flex-col justify-between aspect-[1.586] min-h-[190px] overflow-hidden"
      style={{ background: cardGradient(card.color, card.network), boxShadow: "var(--shLg)" }}
    >
      {/* A soft highlight so the face reads as plastic rather than a coloured box. */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{ background: "radial-gradient(120% 90% at 85% -10%, rgba(255,255,255,.22), transparent 60%)" }}
      />

      <div className="relative flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] font-extrabold truncate">{card.nickname}</div>
          <div className="text-[11.5px] opacity-80 truncate">{card.bank}</div>
        </div>
        <div className="flex flex-col items-end gap-1">
          {card.isDefault && (
            <span className="text-[10px] font-bold px-2 py-[3px] rounded-full bg-white/20 backdrop-blur-sm whitespace-nowrap">
              Default
            </span>
          )}
          {card.isExpired && (
            <span className="text-[10px] font-bold px-2 py-[3px] rounded-full bg-black/35 whitespace-nowrap">Expired</span>
          )}
        </div>
      </div>

      <div className="relative flex flex-col gap-2">
        {/* The chip — three quarters of recognising a card at a glance is its shape. */}
        <div className="w-[34px] h-[25px] rounded-[5px] bg-white/70 border border-white/40" aria-hidden />
        <div className="font-mono text-[15px] tracking-[0.12em] tabular-nums">
          {maskFromLast4(card.network, card.last4)}
        </div>
        <div className="flex items-end gap-2">
          <div className="flex-1 min-w-0">
            <div className="text-[9px] uppercase tracking-wider opacity-65">Cardholder</div>
            <div className="text-[11.5px] font-semibold truncate uppercase">
              {card.cardholderName ?? (card.keyMatches ? "—" : "Unavailable")}
            </div>
          </div>
          <div className="text-[12px] font-extrabold tracking-wide opacity-95 whitespace-nowrap">
            {networkLabel(card.network)}
          </div>
        </div>
      </div>

      {children}
    </div>
  );
}

/**
 * Shown when a row was sealed with a different CARD_ENCRYPTION_KEY — restoring a
 * backup onto a fresh instance without carrying the key across is the realistic
 * way to get here. The metadata still displays; saying plainly why the rest is
 * missing beats a card that silently shows blanks.
 */
export function KeyMismatchNotice() {
  return (
    <div className="mt-2 text-[11.5px] font-semibold px-2.5 py-2 rounded-[9px]" style={{ background: "var(--amberSoft)", color: "var(--amber)" }}>
      Encrypted with a different key — this card&apos;s details can&apos;t be read on this instance.
    </div>
  );
}
