"use client";

// The card detail screen's interactive half: the face, the primary "Show
// details" flow, and the Manage group. It reuses the exact security-sensitive
// pieces unchanged — PasswordPrompt (the password gate), RevealPanel (30s
// auto-hide reveal), CheckoutHelper (60s copy pad), CardForm (edit). Only the
// layout around them is new: one hero action, everything else demoted to a quiet
// list, instead of a row of equal-weight buttons under a full-bleed tile.

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  deleteCreditCardAction,
  setCreditCardArchivedAction,
  setDefaultCreditCardAction,
} from "@/app/actions";
import { useUI } from "@/components/shell/ui-context";
import type { CreditCardListItem, RevealedCreditCard } from "@/server/services/credit-cards";
import { CardFace, KeyMismatchNotice } from "../card-face";
import { FavoriteToggle } from "../card-actions";
import { CardForm, type CardFormInitial } from "../card-form";
import { CheckoutHelper } from "../checkout-helper";
import { PasswordPrompt } from "../password-prompt";
import { RevealPanel } from "../reveal-panel";

type Mode = "idle" | "unlock-reveal" | "revealed" | "checkout" | "unlock-edit" | "edit" | "confirm-delete";

export function CardDetail({ card }: { card: CreditCardListItem }) {
  const router = useRouter();
  const { showToast } = useUI();
  const [mode, setMode] = useState<Mode>("idle");
  const [initial, setInitial] = useState<CardFormInitial | null>(null);
  const [revealed, setRevealed] = useState<RevealedCreditCard | null>(null);
  const [busy, setBusy] = useState(false);

  function close() {
    setMode("idle");
    // Drop the decrypted values the moment anything showing them closes.
    setInitial(null);
    setRevealed(null);
  }

  // Refresh-in-place for archive/default/edit; delete leaves for the wallet.
  async function run(fn: () => Promise<{ ok: boolean; error?: string }>, success: string, leave = false) {
    if (busy) return;
    setBusy(true);
    const res = await fn();
    setBusy(false);
    showToast(res.ok ? success : res.error ?? "Something went wrong");
    if (res.ok) {
      close();
      if (leave) router.push("/cards");
      else router.refresh();
    }
  }

  const canReveal = card.keyMatches && !card.isArchived;

  return (
    <div className="flex flex-col gap-3.5">
      <div className="relative">
        <CardFace card={card}>{!card.isArchived && <FavoriteToggle card={card} />}</CardFace>
      </div>
      {!card.keyMatches && <KeyMismatchNotice />}

      {canReveal && (
        <button onClick={() => setMode("unlock-reveal")} className="btn-primary">
          Show details
        </button>
      )}

      {mode === "revealed" && revealed && (
        <RevealPanel card={card} revealed={revealed} onHide={close} onCheckout={() => setMode("checkout")} />
      )}

      {/* Manage — everything that isn't the reason you opened the card. */}
      <section className="card p-[var(--pad)] flex flex-col">
        <h2 className="text-[11px] font-bold uppercase tracking-wide text-mut2 mb-1">Manage</h2>
        {canReveal && (
          <ManageRow label="Edit card" hint="Update the name, number or expiry" onClick={() => setMode("unlock-edit")} />
        )}
        {!card.isArchived && !card.isDefault && (
          <ManageRow
            label="Make default"
            hint="Use this card first at checkout"
            disabled={busy}
            onClick={() => void run(() => setDefaultCreditCardAction(card.id), "Default card updated")}
          />
        )}
        {card.isArchived ? (
          <ManageRow
            label="Unarchive"
            hint="Bring this card back to the wallet"
            disabled={busy}
            onClick={() => void run(() => setCreditCardArchivedAction(card.id, false), "Card restored")}
          />
        ) : (
          <ManageRow
            label="Archive"
            hint="Hide it without deleting the details"
            disabled={busy}
            onClick={() => void run(() => setCreditCardArchivedAction(card.id, true), "Card archived")}
          />
        )}
        <ManageRow label="Delete card" hint="Remove its encrypted details for good" danger onClick={() => setMode("confirm-delete")} />
      </section>

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

      {mode === "checkout" && revealed && <CheckoutHelper card={card} revealed={revealed} onClose={close} />}

      {mode === "unlock-edit" && (
        <PasswordPrompt
          cardId={card.id}
          cardName={card.nickname}
          purpose="edit"
          onRevealed={(r) => {
            setInitial({ card, revealed: r });
            setMode("edit");
          }}
          onCancel={close}
        />
      )}

      {mode === "edit" && initial && <CardForm initial={initial} onDone={close} />}

      {mode === "confirm-delete" && (
        <ConfirmDelete
          card={card}
          busy={busy}
          onCancel={close}
          onConfirm={() => void run(() => deleteCreditCardAction(card.id), "Card deleted", true)}
        />
      )}
    </div>
  );
}

function ManageRow({
  label,
  hint,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-3 py-2.5 px-1 text-left bg-transparent border-none border-t border-line first:border-t-0 cursor-pointer disabled:opacity-50 hover:bg-accsoft rounded-lg -mx-1"
    >
      <span className="flex-1 min-w-0">
        <span className={`block text-[13px] font-semibold ${danger ? "text-red" : "text-ink"}`}>{label}</span>
        <span className="block text-[11px] text-mut2 truncate">{hint}</span>
      </span>
      <svg className="flex-none text-mut2" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="m9 18 6-6-6-6" />
      </svg>
    </button>
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
    <div className="flex flex-col gap-2 p-3 rounded-[12px] border border-line2 bg-card">
      <div className="text-[12.5px] font-semibold">Delete {card.nickname}? Its encrypted details are removed for good.</div>
      {card.isDefault && <div className="text-[11.5px] text-mut2">Your next card becomes the default.</div>}
      <div className="flex gap-2">
        <button
          disabled={busy}
          onClick={onConfirm}
          className="px-3 py-2 rounded-lg border-none bg-red text-white text-[12px] font-semibold cursor-pointer disabled:opacity-60"
        >
          Delete
        </button>
        <button onClick={onCancel} className="px-3 py-2 rounded-lg border border-line2 bg-card text-[12px] font-semibold cursor-pointer">
          Keep
        </button>
      </div>
    </div>
  );
}
