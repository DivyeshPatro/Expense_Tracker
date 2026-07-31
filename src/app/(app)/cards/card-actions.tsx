"use client";

// Add / edit / delete / set-default for cards.
//
// Editing routes through the password prompt, because pre-filling the form
// means decrypting the card. Deleting and setting the default don't: neither
// produces plaintext, and demanding a password to rename what's already on
// screen trains people to type it without thinking, which is the opposite of
// what the prompt is for.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deleteCreditCardAction, setDefaultCreditCardAction } from "@/app/actions";
import { useUI } from "@/components/shell/ui-context";
import type { CreditCardListItem, RevealedCreditCard } from "@/server/services/credit-cards";
import { CardForm, type CardFormInitial } from "./card-form";
import { CheckoutHelper } from "./checkout-helper";
import { PasswordPrompt } from "./password-prompt";
import { RevealPanel } from "./reveal-panel";

export function AddCardButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} className="btn-primary">
        ＋ Add card
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
        {card.keyMatches && (
          <button
            onClick={() => setMode("unlock-reveal")}
            className="px-2.5 py-1.5 rounded-lg border-none bg-acc text-white text-[11.5px] font-bold cursor-pointer hover:brightness-108"
          >
            Show details
          </button>
        )}
        {card.keyMatches && (
          <SmallButton onClick={() => setMode("unlock-edit")}>Edit</SmallButton>
        )}
        {!card.isDefault && (
          <SmallButton disabled={busy} onClick={() => void run(() => setDefaultCreditCardAction(card.id), "Default card updated")}>
            Make default
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
