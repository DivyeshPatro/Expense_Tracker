"use client";

// Add / edit a card.
//
// The same component does both, because the difference is only where the
// initial values come from — and on edit those values arrived through a
// password prompt, so they are already decrypted in memory.
//
// Validation mirrors creditCardSchema on the server rather than replacing it:
// the checks here exist to tell you about a typo before you submit, not to be
// the thing standing between a bad value and the database.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createCreditCardAction, updateCreditCardAction } from "@/app/actions";
import { ErrorNote, Field } from "@/components/shell/form-primitives";
import { useUI } from "@/components/shell/ui-context";
import {
  CARD_NETWORKS,
  detectNetwork,
  formatCardNumber,
  isPlausibleLength,
  isValidCvv,
  isValidLuhn,
  networkLabel,
  normalizeCardNumber,
  parseExpiry,
  type CardNetwork,
} from "@/lib/card-identity";
import { CARD_COLORS, cardColor } from "@/lib/card-visual";
import type { CreditCardListItem, RevealedCreditCard } from "@/server/services/credit-cards";
import { CardDialog } from "./card-dialog";

export interface CardFormInitial {
  card: CreditCardListItem;
  revealed: RevealedCreditCard;
}

export function CardForm({ initial, onDone }: { initial?: CardFormInitial; onDone: () => void }) {
  const router = useRouter();
  const { showToast } = useUI();
  const editing = initial !== undefined;

  const [nickname, setNickname] = useState(initial?.card.nickname ?? "");
  const [bank, setBank] = useState(initial?.card.bank ?? "");
  const [cardholderName, setCardholderName] = useState(initial?.revealed.cardholderName ?? "");
  const [cardNumber, setCardNumber] = useState(initial ? formatCardNumber(initial.revealed.cardNumber) : "");
  const [expiryMonth, setExpiryMonth] = useState(initial ? String(initial.revealed.expiryMonth).padStart(2, "0") : "");
  const [expiryYear, setExpiryYear] = useState(initial ? String(initial.revealed.expiryYear) : "");
  const [cvv, setCvv] = useState(initial?.revealed.cvv ?? "");
  // An explicit network overrides detection — co-badged cards exist, and the
  // user knows which logo is printed on theirs better than the IIN table does.
  const [network, setNetwork] = useState<CardNetwork | "">(initial ? initial.card.network : "");
  const [color, setColor] = useState(initial?.card.color ?? "");
  const [notes, setNotes] = useState(initial?.revealed.notes ?? "");
  const [isDefault, setIsDefault] = useState(initial?.card.isDefault ?? false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const digits = normalizeCardNumber(cardNumber);
  const detected = useMemo(() => detectNetwork(digits), [digits]);
  const effectiveNetwork: CardNetwork = network || detected;

  // Live hints while typing, but only once there's enough typed to be talking
  // about a real mistake rather than an unfinished field.
  const numberHint =
    digits.length >= 12 && !isValidLuhn(digits)
      ? "That number doesn't pass the checksum — look for a transposed digit"
      : digits.length >= 12 && !isPlausibleLength(digits, effectiveNetwork)
        ? `${networkLabel(effectiveNetwork)} cards have a different number of digits`
        : null;
  const cvvHint =
    cvv.length > 0 && !isValidCvv(cvv, effectiveNetwork)
      ? effectiveNetwork === "AMEX"
        ? "Amex CVVs are 4 digits"
        : "CVV is 3 digits"
      : null;

  async function save() {
    if (busy) return;
    setError(null);

    const expiry = parseExpiry(expiryMonth, expiryYear);
    if (!expiry.ok) {
      setError(expiry.error);
      return;
    }

    setBusy(true);
    const payload = {
      nickname,
      bank,
      cardholderName,
      cardNumber: digits,
      expiryMonth: expiry.parts.month,
      expiryYear: expiry.parts.year,
      cvv,
      network: effectiveNetwork,
      color: color || null,
      notes: notes.trim() || null,
      isDefault,
    };
    const res = editing
      ? await updateCreditCardAction({ id: initial.card.id, ...payload })
      : await createCreditCardAction(payload);
    setBusy(false);

    if (!res.ok) {
      setError(res.error);
      return;
    }
    showToast(editing ? "Card updated" : "Card saved");
    router.refresh();
    onDone();
  }

  return (
    <CardDialog title={editing ? "Edit card" : "Add card"} onClose={onDone} width="520px">
      <div className="flex gap-2.5 flex-wrap">
        <Field label="NICKNAME">
          <input
            className="field"
            autoFocus={!editing}
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="Amazon card"
            aria-label="Card nickname"
          />
        </Field>
        <Field label="BANK">
          <input
            className="field"
            value={bank}
            onChange={(e) => setBank(e.target.value)}
            placeholder="HDFC Bank"
            aria-label="Issuing bank"
          />
        </Field>
      </div>

      <Field label="CARD NUMBER">
        <input
          className="field font-mono tracking-wide"
          inputMode="numeric"
          autoComplete="off"
          value={cardNumber}
          // Reformatted as you type, in the grouping printed on the card — the
          // point of typing it in is checking it against the plastic in front
          // of you, and an unbroken run of 16 digits is hard to check.
          onChange={(e) => setCardNumber(formatCardNumber(e.target.value.replace(/[^\d\s]/g, "")))}
          placeholder="4111 1111 1111 1111"
          aria-label="Card number"
        />
      </Field>
      <div className="flex items-center gap-2 -mt-1.5 text-[11.5px]">
        {digits.length >= 2 && (
          <span className="px-2 py-[3px] rounded-full font-bold" style={{ background: "var(--accsoft)", color: "var(--acc)" }}>
            {networkLabel(effectiveNetwork)}
            {!network && detected !== "OTHER" ? " · detected" : ""}
          </span>
        )}
        {numberHint && <span className="text-red font-semibold">{numberHint}</span>}
      </div>

      <div className="flex gap-2.5 flex-wrap">
        <Field label="EXPIRY MONTH">
          <input
            className="field"
            inputMode="numeric"
            maxLength={2}
            value={expiryMonth}
            onChange={(e) => setExpiryMonth(e.target.value.replace(/\D/g, ""))}
            placeholder="09"
            aria-label="Expiry month"
          />
        </Field>
        <Field label="EXPIRY YEAR">
          <input
            className="field"
            inputMode="numeric"
            maxLength={4}
            value={expiryYear}
            onChange={(e) => setExpiryYear(e.target.value.replace(/\D/g, ""))}
            placeholder="2029"
            aria-label="Expiry year"
          />
        </Field>
        <Field label="CVV">
          <input
            className="field"
            inputMode="numeric"
            maxLength={4}
            autoComplete="off"
            value={cvv}
            onChange={(e) => setCvv(e.target.value.replace(/\D/g, ""))}
            placeholder="123"
            aria-label="CVV"
          />
        </Field>
      </div>
      {cvvHint && <div className="-mt-1.5 text-[11.5px] text-red font-semibold">{cvvHint}</div>}

      <div className="flex gap-2.5 flex-wrap">
        <Field label="CARDHOLDER NAME">
          <input
            className="field uppercase"
            value={cardholderName}
            onChange={(e) => setCardholderName(e.target.value)}
            placeholder="As printed on the card"
            aria-label="Cardholder name"
          />
        </Field>
        <Field label="NETWORK">
          <select className="field" value={network} onChange={(e) => setNetwork(e.target.value as CardNetwork | "")}>
            <option value="">Detect automatically</option>
            {CARD_NETWORKS.map((n) => (
              <option key={n.value} value={n.value}>
                {n.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div>
        <div className="label-caps">COLOUR</div>
        <div className="flex gap-2 flex-wrap">
          {CARD_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              aria-label={c.label}
              aria-pressed={cardColor(color || null, effectiveNetwork) === c.value}
              onClick={() => setColor(c.value)}
              className="w-8 h-8 rounded-[9px] cursor-pointer"
              style={{
                background: c.value,
                border: cardColor(color || null, effectiveNetwork) === c.value ? "2.5px solid var(--acc)" : "1px solid var(--line2)",
              }}
            />
          ))}
        </div>
      </div>

      <Field label="NOTES (OPTIONAL)">
        <input
          className="field"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="5% back on groceries"
          aria-label="Notes"
        />
      </Field>

      <label className="flex items-center gap-2 text-[12.5px] font-semibold cursor-pointer">
        <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        Use as my default card
      </label>

      <ErrorNote error={error} />
      <div className="flex gap-2">
        <button disabled={busy} onClick={() => void save()} className="btn-primary flex-1 disabled:opacity-60">
          {busy ? "Saving…" : editing ? "Save changes" : "Save card"}
        </button>
        <button onClick={onDone} className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold cursor-pointer">
          Cancel
        </button>
      </div>
    </CardDialog>
  );
}
