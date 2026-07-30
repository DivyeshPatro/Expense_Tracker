"use client";

// Asks for the account password, then hands back the decrypted card.
//
// This is the gate in front of every path that produces plaintext — revealing,
// copying, and editing all come through here. Editing goes through it too
// because pre-filling the form means decrypting the card, and the fact that the
// user is editing rather than reading doesn't make that less true.
//
// The revealed card is passed to the caller in memory and never stored. There
// is no "remember for this session": the whole point is that possession of a
// live session isn't sufficient.

import { useState } from "react";
import { revealCreditCardAction } from "@/app/actions";
import { ErrorNote } from "@/components/shell/form-primitives";
import type { RevealedCreditCard } from "@/server/services/credit-cards";
import { CardDialog } from "./card-dialog";

export function PasswordPrompt({
  cardName,
  purpose,
  cardId,
  onRevealed,
  onCancel,
}: {
  cardId: string;
  cardName: string;
  /** What the password is being asked for, so the prompt isn't a bare demand. */
  purpose: string;
  onRevealed: (card: RevealedCreditCard) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    const res = await revealCreditCardAction(cardId, password);
    setBusy(false);
    // Clear the password either way — it has served its purpose, and leaving it
    // sitting in a mounted input is the kind of thing this module exists to avoid.
    setPassword("");
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onRevealed(res.card);
  }

  return (
    <CardDialog title="Confirm it's you" onClose={onCancel} width="380px">
      <div className="text-[12.5px] text-mut leading-relaxed">
        Enter your Ledgerly password to {purpose} <span className="font-bold text-ink">{cardName}</span>.
      </div>
      <input
        type="password"
        className="field"
        autoFocus
        autoComplete="current-password"
        aria-label="Ledgerly password"
        placeholder="Your password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
      />
      <ErrorNote error={error} />
      <div className="flex gap-2">
        <button
          disabled={busy || !password}
          onClick={() => void submit()}
          className="btn-primary flex-1 disabled:opacity-60"
        >
          {busy ? "Checking…" : "Continue"}
        </button>
        <button onClick={onCancel} className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold cursor-pointer">
          Cancel
        </button>
      </div>
    </CardDialog>
  );
}
