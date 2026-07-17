"use client";

// Offline-sync Phase 2 (spec §11): tap-to-view/edit for a still-queued
// (not-yet-synced) intent, sourced from the outbox rather than the server —
// getTransactionDetailAction only knows about entities that exist server-side,
// and a pending intent's entity doesn't exist there yet. Edit coalesces the
// payload into the SAME intent (never a second intent); Remove cancels it
// locally with a 5s undo, and never touches the server since nothing was
// ever created there.

import { useState } from "react";
import type { OutboxIntent } from "@/lib/offline/db";
import { formatPaise } from "@/lib/money";
import { AmountInput, ErrorNote, Field, SubmitButton } from "./form-primitives";
import { useOffline, type CreateKind } from "./offline-context";
import { useUI } from "./ui-context";

// spec §12 failure catalog — shared with transaction-detail.tsx's outbox-aware
// view of an already-synced entity with a queued edit/delete (Phase 3)
// VALIDATION is deliberately absent: the server's raw message for it is
// already specific and useful (a zod issue, or "this transaction was deleted
// elsewhere") — overriding it with one generic line would lose information.
// INVALID_REF_HARD/STALE_INTENT get curated copy because the raw server
// message for those is a plain code-shaped sentence, not user-facing prose.
export const FAILURE_COPY: Record<string, string> = {
  INVALID_REF_HARD: "An account this refers to no longer exists.",
  STALE_INTENT: "This waited too long to sync safely. Review it and add it again.",
};

export function PendingDetailSheet({ intentId }: { intentId: string }) {
  const { pending, needsAttention, closeModal, showToast } = useJoinedUI();
  const intent = [...pending, ...needsAttention].find((i) => i.intentId === intentId);
  const [editing, setEditing] = useState(false);

  if (!intent) {
    return <div className="text-center py-10 text-mut2 text-[13px]">This already synced — check the transaction list.</div>;
  }

  if (editing) {
    return <PendingEditForm intent={intent} onCancel={() => setEditing(false)} onSaved={closeModal} />;
  }

  return <PendingView intent={intent} onEdit={() => setEditing(true)} onCancelled={closeModal} showToast={showToast} />;
}

// small local join so the two hooks this sheet needs read like one call
function useJoinedUI() {
  const offline = useOffline();
  const ui = useUI();
  return { ...offline, closeModal: ui.closeModal, showToast: ui.showToast };
}

function payloadFields(intent: OutboxIntent): { name: string; amtPaise: number; isTransfer: boolean } {
  const p = intent.payload as { amount?: unknown; merchant?: string; fromAccountId?: string; toAccountId?: string };
  const amtPaise = Math.round((Number(p.amount) || 0) * 100);
  const isTransfer = intent.kind === "transfer.create";
  const name = isTransfer ? "Transfer" : p.merchant || (intent.kind === "income.create" ? "Income" : "Expense");
  return { name, amtPaise, isTransfer };
}

function PendingView({
  intent,
  onEdit,
  onCancelled,
  showToast,
}: {
  intent: OutboxIntent;
  onEdit: () => void;
  onCancelled: () => void;
  showToast: (msg: string, undo?: () => void) => void;
}) {
  const { cancelPending, restorePending } = useOffline();
  const [busy, setBusy] = useState(false);
  const { name, amtPaise } = payloadFields(intent);
  const needsAttention = intent.status === "needs-attention";
  const online = typeof navigator === "undefined" || navigator.onLine;

  const statusLine = needsAttention
    ? `⚠ Needs your attention — ${(intent.lastErrorCode && FAILURE_COPY[intent.lastErrorCode]) || (intent.lastError ? cleanCopy(intent.lastError) : "This couldn't be synced.")}`
    : online
      ? "⏳ Waiting to sync · will happen automatically"
      : "⏳ Waiting for internet · will happen automatically";

  async function handleCancel() {
    setBusy(true);
    const removed = await cancelPending(intent.intentId);
    setBusy(false);
    onCancelled();
    if (!removed) return;
    showToast("Removed — it was never synced", () => void restorePending(removed));
  }

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl grid place-items-center text-lg flex-none bg-accsoft" aria-hidden="true">
          {intent.kind === "transfer.create" ? "⇄" : "⏳"}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-bold truncate">{name}</div>
        </div>
        <div className="text-[19px] font-extrabold flex-none" style={{ color: intent.kind === "income.create" ? "var(--green)" : "var(--ink)" }}>
          {intent.kind === "income.create" ? "+" : intent.kind === "expense.create" ? "−" : ""}
          {formatPaise(amtPaise)}
        </div>
      </div>

      <div
        className="text-[13px] font-semibold rounded-[10px] px-3.5 py-3"
        style={{ background: needsAttention ? "var(--redSoft)" : "var(--accSoft)", color: needsAttention ? "var(--red)" : "var(--mut)" }}
      >
        {statusLine}
      </div>

      <div className="flex gap-2.5">
        <button
          onClick={onEdit}
          className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border border-line2 bg-card hover:bg-accsoft"
        >
          {needsAttention ? "Edit & retry" : "Edit"}
        </button>
        <button
          onClick={handleCancel}
          disabled={busy}
          className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border-none text-white hover:brightness-108 disabled:opacity-60"
          style={{ background: "var(--red)" }}
        >
          {busy ? "…" : needsAttention ? "Discard" : "Remove"}
        </button>
      </div>
    </div>
  );
}

/** strips leading taxonomy-adjacent phrasing servers sometimes echo, keeping just the human sentence */
function cleanCopy(msg: string): string {
  return msg.charAt(0).toUpperCase() + msg.slice(1);
}

function PendingEditForm({ intent, onCancel, onSaved }: { intent: OutboxIntent; onCancel: () => void; onSaved: () => void }) {
  const { refData } = useUI();
  const { editPending } = useOffline();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = intent.kind as CreateKind;
  const p = intent.payload as Record<string, unknown>;

  const [amount, setAmount] = useState(String(p.amount ?? ""));
  const [accountId, setAccountId] = useState(String(p.accountId ?? refData.accounts[0]?.id ?? ""));
  const [categoryId, setCategoryId] = useState(String(p.categoryId ?? ""));
  const [merchant, setMerchant] = useState(String(p.merchant ?? ""));
  const [date, setDate] = useState(String(p.date ?? ""));
  const [notes, setNotes] = useState(String(p.notes ?? ""));
  const [fromAccountId, setFromAccountId] = useState(String(p.fromAccountId ?? refData.accounts[0]?.id ?? ""));
  const [toAccountId, setToAccountId] = useState(String(p.toAccountId ?? refData.accounts[1]?.id ?? refData.accounts[0]?.id ?? ""));

  const categories = kind === "income.create" ? refData.incomeCategories : refData.expenseCategories;

  async function handleSave() {
    setBusy(true);
    setError(null);
    const payload =
      kind === "transfer.create"
        ? { amount, fromAccountId, toAccountId, date, notes: notes || undefined }
        : kind === "income.create"
          ? { amount, accountId, categoryId: categoryId || null, merchant, date, notes: notes || undefined }
          : { amount, accountId: accountId || null, categoryId: categoryId || null, merchant, date, notes: notes || undefined };
    const res = await editPending(intent.intentId, payload);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onSaved();
  }

  return (
    <div className="flex flex-col gap-3">
      {kind === "transfer.create" ? (
        <div className="flex gap-2.5 flex-wrap">
          <Field label="FROM">
            <select className="field" value={fromAccountId} onChange={(e) => setFromAccountId(e.target.value)}>
              {refData.accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.icon} {a.name}</option>
              ))}
            </select>
          </Field>
          <Field label="TO">
            <select className="field" value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>
              {refData.accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.icon} {a.name}</option>
              ))}
            </select>
          </Field>
        </div>
      ) : (
        <div className="flex gap-2.5 flex-wrap">
          <Field label={kind === "income.create" ? "INTO ACCOUNT" : "ACCOUNT"}>
            <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {refData.accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.icon} {a.name}</option>
              ))}
            </select>
          </Field>
          <Field label={kind === "income.create" ? "SOURCE" : "CATEGORY"}>
            <select className="field" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
              ))}
            </select>
          </Field>
        </div>
      )}

      <Field label="AMOUNT (₹)">
        <AmountInput value={amount} onChange={setAmount} autoFocus />
      </Field>

      {kind !== "transfer.create" && (
        <Field label={kind === "income.create" ? "DESCRIPTION" : "MERCHANT"}>
          <input className="field" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="e.g. Swiggy" />
        </Field>
      )}

      <Field label="DATE">
        <input className="field" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field label="NOTES">
        <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
      </Field>

      <ErrorNote error={error} />
      <div className="flex gap-2.5">
        <button onClick={onCancel} className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border border-line2 bg-card hover:bg-accsoft">
          Cancel
        </button>
        <div className="flex-[2]">
          <SubmitButton busy={busy} onClick={handleSave}>
            Save changes
          </SubmitButton>
        </div>
      </div>
    </div>
  );
}
