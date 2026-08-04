"use client";

// The two card controls that live outside the detail screen: adding a card
// (from the wallet header and the context-aware FAB) and the favourite star
// (overlaid on the card face, on the wallet row and the detail screen).
//
// Reveal / edit / delete / set-default moved to the detail screen (card-detail
// .tsx), where a single card has room for unambiguous actions instead of a row
// of equal-weight buttons under every tile.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { setCreditCardFavoriteAction } from "@/app/actions";
import { useUI } from "@/components/shell/ui-context";
import type { CreditCardListItem } from "@/server/services/credit-cards";
import { CardForm } from "./card-form";

export function AddCardButton({ label = "＋ Add card" }: { label?: string }) {
  const [open, setOpen] = useState(false);
  // The context-aware FAB (app-shell) can't open this form directly — it holds a
  // decrypted CVV and is deliberately route-scoped (card-dialog.tsx) — so it
  // signals via an event this route-local button listens for.
  useEffect(() => {
    const onAdd = () => setOpen(true);
    window.addEventListener("ledgerly:add-card", onAdd);
    return () => window.removeEventListener("ledgerly:add-card", onAdd);
  }, []);
  return (
    <>
      <button onClick={() => setOpen(true)} className="btn-primary">
        {label}
      </button>
      {open && <CardForm onDone={() => setOpen(false)} />}
    </>
  );
}

/**
 * The star that pins a card (#85). Overlaid on the card face (detail screen) so
 * favouriting is a single tap on the card itself. Archived cards don't show it —
 * a pinned-but-hidden card is a contradiction, and archiving clears the flag
 * server-side.
 */
export function FavoriteToggle({ card }: { card: CreditCardListItem }) {
  const router = useRouter();
  const { showToast } = useUI();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    const next = !card.isFavorite;
    const res = await setCreditCardFavoriteAction(card.id, next);
    setBusy(false);
    if (res.ok) {
      showToast(next ? "Pinned to favorites" : "Removed from favorites");
      router.refresh();
    } else {
      showToast(res.error ?? "Something went wrong");
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      aria-pressed={card.isFavorite}
      aria-label={card.isFavorite ? "Remove from favorites" : "Add to favorites"}
      title={card.isFavorite ? "Remove from favorites" : "Add to favorites"}
      className="absolute top-2.5 right-2.5 w-8 h-8 grid place-items-center rounded-full text-[15px] leading-none cursor-pointer border-none bg-black/25 backdrop-blur-sm hover:bg-black/40 disabled:opacity-60 transition-colors"
      style={{ color: card.isFavorite ? "#ffd34d" : "rgba(255,255,255,.85)" }}
    >
      {card.isFavorite ? "★" : "☆"}
    </button>
  );
}
