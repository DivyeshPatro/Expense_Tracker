"use client";

// Add / edit / delete / set-default for cards.
//
// Editing routes through the password prompt, because pre-filling the form
// means decrypting the card. Deleting and setting the default don't: neither
// produces plaintext, and demanding a password to rename what's already on
// screen trains people to type it without thinking, which is the opposite of
// what the prompt is for.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  deleteCreditCardAction,
  setCreditCardArchivedAction,
  setCreditCardFavoriteAction,
  setDefaultCreditCardAction,
} from "@/app/actions";
import { useUI } from "@/components/shell/ui-context";
import type { CreditCardListItem, RevealedCreditCard } from "@/server/services/credit-cards";
import { CardForm, type CardFormInitial } from "./card-form";
import { CheckoutHelper } from "./checkout-helper";
import { PasswordPrompt } from "./password-prompt";
import { RevealPanel } from "./reveal-panel";

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

type Mode = "idle" | "unlock-reveal" | "revealed" | "checkout" | "unlock-edit" | "edit" | "confirm-delete";

export function CardActions({ card }: { card: CreditCardListItem }) {
  const router = useRouter();
  const { showToast } = useUI();
  const [mode, setMode] = useState<Mode>("idle");
  const [initial, setInitial] = useState<CardFormInitial | null>(null);
  const [revealed, setRevealed] = useState<RevealedCreditCard | null>(null);
  const [busy, setBusy] = useState(false);

  function close() {
    setMode("idle");
    // Drop the decrypted values the moment anything showing them closes — they
    // only ever needed to exist while that panel or form was on screen.
    setInitial(null);
    setRevealed(null);
  }

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    if (busy) return;
    setBusy(true);
    const res = await fn();
    setBusy(false);
    showToast(res.ok ? success : (res.error ?? "Something went wrong"));
    if (res.ok) {
      close();
      router.refresh();
    }
  }

  function onRevealedForEdit(revealed: RevealedCreditCard) {
    setInitial({ card, revealed });
    setMode("edit");
  }

  return (
    <>
      <div className="flex items-center gap-1.5 flex-wrap">
        {/* A card sealed under a different key can't be decrypted, so revealing
            and editing are impossible — but deleting it is exactly what you'd
            want to do, so that button stays. */}
        {card.keyMatches && !card.isArchived && (
          <button
            onClick={() => setMode("unlock-reveal")}
            className="px-2.5 py-1.5 rounded-lg border-none bg-acc text-white text-[11.5px] font-bold cursor-pointer hover:brightness-108"
          >
            Show details
          </button>
        )}
        {card.keyMatches && !card.isArchived && (
          <SmallButton onClick={() => setMode("unlock-edit")}>Edit</SmallButton>
        )}
        {!card.isArchived && !card.isDefault && (
          <SmallButton disabled={busy} onClick={() => void run(() => setDefaultCreditCardAction(card.id), "Default card updated")}>
            Make default
          </SmallButton>
        )}
        {card.isArchived ? (
          <SmallButton disabled={busy} onClick={() => void run(() => setCreditCardArchivedAction(card.id, false), "Card restored")}>
            Unarchive
          </SmallButton>
        ) : (
          <SmallButton disabled={busy} onClick={() => void run(() => setCreditCardArchivedAction(card.id, true), "Card archived")}>
            Archive
          </SmallButton>
        )}
        <SmallButton onClick={() => setMode("confirm-delete")}>Delete</SmallButton>
      </div>

      {mode === "unlock-reveal" && (
        <PasswordPrompt
          cardId={card.id}
          cardName={card.nickname}
          purpose="show the details for"
          onRevealed={(r) => {
            setRevealed(r);
            setMode("revealed");
          }}
          onCancel={close}
        />
      )}

      {mode === "revealed" && revealed && (
        <RevealPanel card={card} revealed={revealed} onHide={close} onCheckout={() => setMode("checkout")} />
      )}

      {mode === "checkout" && revealed && <CheckoutHelper card={card} revealed={revealed} onClose={close} />}

      {mode === "unlock-edit" && (
        <PasswordPrompt
          cardId={card.id}
          cardName={card.nickname}
          purpose="edit"
          onRevealed={onRevealedForEdit}
          onCancel={close}
        />
      )}

      {mode === "edit" && initial && <CardForm initial={initial} onDone={close} />}

      {mode === "confirm-delete" && (
        <ConfirmDelete
          card={card}
          busy={busy}
          onCancel={close}
          onConfirm={() => void run(() => deleteCreditCardAction(card.id), "Card deleted")}
        />
      )}
    </>
  );
}

function ConfirmDelete({
  card,
  busy,
  onCancel,
  onConfirm,
}: {
  card: CreditCardListItem;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="mt-2 flex flex-col gap-2 p-3 rounded-[10px] border border-line2 bg-card">
      <div className="text-[12.5px] font-semibold">
        Delete {card.nickname}? Its encrypted details are removed for good.
      </div>
      {card.isDefault && (
        <div className="text-[11.5px] text-mut2">Your next card becomes the default.</div>
      )}
      <div className="flex gap-2">
        <button
          disabled={busy}
          onClick={onConfirm}
          className="px-2.5 py-1.5 rounded-lg border-none bg-red text-white text-[11.5px] font-semibold cursor-pointer disabled:opacity-60"
        >
          Delete
        </button>
        <SmallButton onClick={onCancel}>Keep</SmallButton>
      </div>
    </div>
  );
}

/**
 * The star that pins a card (#85). Lives as an overlay on the card face so
 * favouriting is a single tap on the card itself, not a trip into the action
 * row. Archived cards don't show it — a pinned-but-hidden card is a
 * contradiction, and archiving already clears the flag server-side.
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

function SmallButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-2.5 py-1.5 rounded-lg border border-line2 text-[11.5px] font-semibold text-acc cursor-pointer bg-transparent hover:bg-accsoft disabled:opacity-60"
    >
      {children}
    </button>
  );
}
