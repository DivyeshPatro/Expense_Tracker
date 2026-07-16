"use client";

// Tap-to-view/edit for a single transaction. Reuses the same bottom-sheet
// shell as every other modal (rendered by <Modals> for modal.type==="txDetail")
// so mobile gets the existing bottom-sheet visual language for free and
// desktop gets the same centered dialog every other modal already uses.
//
// Default state is read-only; Edit switches the same sheet into a form
// (reusing Field/AmountInput/SubmitButton/SplitEditor — the same building
// blocks the Add Expense/Income/Transfer forms use) pre-filled from the
// transaction. Delete lives here now instead of always-visible on the list
// row, with the same confirm-then-5s-undo pattern the row used to have.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  deleteTransactionAction,
  entityHistoryAction,
  getTransactionDetailAction,
  undoDeleteAction,
  updateExpenseAction,
  updateIncomeAction,
  updateTransferAction,
} from "@/app/actions";
import { formatDiffRow, type TimelineEvent } from "@/lib/activity";
import { friendlyDay } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import type { TransactionDetail } from "@/server/services/transactions";
import { AmountInput, ErrorNote, Field, SubmitButton, useSubmit } from "./form-primitives";
import { buildSplitPayload, SplitEditor, type SplitEditorState } from "./split-editor";
import { useUI } from "./ui-context";

export function TransactionDetailSheet({ transactionId }: { transactionId: string }) {
  const { refData, closeModal, showToast } = useUI();
  const router = useRouter();
  // undefined = still loading, null = fetched but gone (e.g. deleted elsewhere)
  const [detail, setDetail] = useState<TransactionDetail | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getTransactionDetailAction(transactionId).then((d) => {
      if (!cancelled) setDetail(d);
    });
    return () => {
      cancelled = true;
    };
  }, [transactionId]);

  async function handleDelete() {
    setDeleteBusy(true);
    const res = await deleteTransactionAction(transactionId);
    setDeleteBusy(false);
    if (!res.ok) {
      showToast(res.error);
      return;
    }
    closeModal();
    router.refresh();
    showToast("Transaction deleted", async () => {
      const undo = await undoDeleteAction(transactionId);
      showToast(undo.ok ? "Restored" : "Could not restore");
      router.refresh();
    });
  }

  if (detail === undefined) {
    return <div className="text-center py-10 text-mut2 text-[13px]">Loading…</div>;
  }
  if (detail === null) {
    return <div className="text-center py-10 text-mut2 text-[13px]">This transaction no longer exists.</div>;
  }

  if (editing) {
    if (detail.type === "EXPENSE") return <EditExpenseForm detail={detail} onCancel={() => setEditing(false)} />;
    if (detail.type === "INCOME") return <EditIncomeForm detail={detail} onCancel={() => setEditing(false)} />;
    return <EditTransferForm detail={detail} onCancel={() => setEditing(false)} />;
  }

  const categories = [...refData.expenseCategories, ...refData.incomeCategories];
  const category = categories.find((c) => c.id === detail.categoryId);
  const amtColor = detail.type === "INCOME" ? "var(--green)" : detail.type === "TRANSFER" ? "var(--mut)" : "var(--ink)";
  const amtPrefix = detail.type === "INCOME" ? "+" : detail.type === "TRANSFER" ? "" : "−";

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl grid place-items-center text-lg flex-none bg-accsoft">
          {detail.type === "TRANSFER" ? "⇄" : (category?.icon ?? "📦")}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-bold truncate">{detail.merchant}</div>
          <div className="text-[12px] text-mut2">{friendlyDay(detail.ymd)}</div>
        </div>
        <div className="text-[19px] font-extrabold flex-none" style={{ color: amtColor }}>
          {amtPrefix}
          {formatPaise(detail.amount)}
        </div>
      </div>

      <div className="card p-[var(--pad)] flex flex-col gap-2.5">
        {detail.type !== "TRANSFER" && <DetailRow label="Category" value={category ? `${category.icon} ${category.name}` : "Uncategorized"} />}
        {detail.type === "TRANSFER" ? (
          <>
            <DetailRow label="From" value={detail.accountName ?? "—"} />
            <DetailRow label="To" value={detail.toAccountName ?? "—"} />
          </>
        ) : (
          <DetailRow label="Account" value={detail.paidByParticipantId ? "Paid by a friend" : (detail.accountName ?? "Unassigned")} />
        )}
        <DetailRow label="Date" value={friendlyDay(detail.ymd)} />
        {detail.notes && <DetailRow label="Notes" value={detail.notes} />}
        {detail.isRecurring && <DetailRow label="Recurring" value="Yes" />}
      </div>

      {detail.splits.length > 0 && (
        <div className="card p-[var(--pad)] flex flex-col gap-2">
          <div className="text-[11px] font-bold text-mut2 tracking-[.06em] uppercase">Split</div>
          {detail.splits.map((s) => {
            const who = s.participantId ? refData.participants.find((p) => p.id === s.participantId) : null;
            const name = who ? who.name : "You";
            const isPayer = s.participantId === detail.paidByParticipantId;
            return (
              <div key={s.participantId ?? "me"} className="flex items-center justify-between text-[13px]">
                <span className="font-semibold">
                  {name}
                  {isPayer ? " · paid" : ""}
                </span>
                <span className="font-bold">{formatPaise(s.owedAmount)}</span>
              </div>
            );
          })}
        </div>
      )}

      <HistoryCard transactionId={transactionId} />

      {!confirmingDelete ? (
        <div className="flex gap-2.5">
          <button
            onClick={() => setEditing(true)}
            className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border border-line2 bg-card hover:bg-accsoft"
          >
            Edit
          </button>
          <button
            onClick={() => setConfirmingDelete(true)}
            className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border-none text-white hover:brightness-108"
            style={{ background: "var(--red)" }}
          >
            Delete
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2.5 bg-redsoft rounded-[10px] px-3.5 py-3">
          <span className="flex-1 text-[13px] font-semibold text-red">Delete this transaction?</span>
          <button
            onClick={() => setConfirmingDelete(false)}
            className="px-3 py-1.5 rounded-lg border border-line2 text-[12px] font-semibold cursor-pointer bg-card"
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            disabled={deleteBusy}
            className="px-3 py-1.5 rounded-lg text-[12px] font-bold cursor-pointer border-none text-white disabled:opacity-60"
            style={{ background: "var(--red)" }}
          >
            {deleteBusy ? "…" : "Delete"}
          </button>
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12px] text-mut2">{label}</span>
      <span className="text-[13px] font-semibold text-right">{value}</span>
    </div>
  );
}

// ─────────── History (RFC §4: per-entity slice of the activity projection) ───────────

/** friendlyDay over the event's LOCAL date — slicing the ISO string would use UTC */
function historyDayLabel(iso: string): string {
  const d = new Date(iso);
  return friendlyDay(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
}

function HistoryCard({ transactionId }: { transactionId: string }) {
  const { closeModal } = useUI();
  const [history, setHistory] = useState<{ events: TimelineEvent[]; more: boolean } | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    entityHistoryAction(transactionId).then((h) => {
      if (!cancelled) setHistory(h);
    });
    return () => {
      cancelled = true;
    };
  }, [transactionId]);

  if (!history || history.events.length === 0) return null;
  const related = history.events[history.events.length - 1]?.related ?? [];

  return (
    <div className="card p-[var(--pad)] flex flex-col gap-2">
      <div className="text-[11px] font-bold text-mut2 tracking-[.06em] uppercase">History</div>
      <div className="flex flex-col">
        {history.events.map((ev, i) => (
          <div key={ev.activityId} className="flex gap-2.5">
            <div className="flex flex-col items-center w-3 flex-none" aria-hidden="true">
              <span className="w-[7px] h-[7px] rounded-full mt-[5px] flex-none" style={{ background: "var(--acc)" }} />
              {i < history.events.length - 1 && <span className="w-px flex-1 bg-line2" />}
            </div>
            <div className="flex-1 min-w-0 pb-2.5">
              <div className="flex items-baseline gap-2">
                <span className="text-[12.5px] font-semibold flex-1">{ev.summary}</span>
                <time dateTime={ev.ts} className="text-[11px] text-mut2 flex-none">
                  {historyDayLabel(ev.ts)},{" "}
                  {new Date(ev.ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                </time>
              </div>
              {ev.diff.length === 0 && ev.detail && <div className="text-[11.5px] text-mut2">{ev.detail}</div>}
              {ev.diff.map((d) => (
                <div key={d.field} className="text-[11.5px] text-mut2">
                  <span className="font-semibold text-mut">{d.fieldLabel}</span> {formatDiffRow(d)}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {history.more && (
        <Link
          href={`/activity?entity=${transactionId}`}
          onClick={closeModal}
          className="text-[12px] font-semibold text-acc no-underline self-start"
        >
          Full history →
        </Link>
      )}
      {related.length > 0 && (
        <div className="flex gap-1.5 flex-wrap pt-1 border-t border-line">
          {related.map((r) => (
            <Link
              key={r.href}
              href={r.href}
              onClick={closeModal}
              className="px-2.5 py-1 rounded-full bg-accsoft text-acc text-[11.5px] font-semibold no-underline"
            >
              {r.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────── Edit: Expense ───────────

function EditExpenseForm({ detail, onCancel }: { detail: TransactionDetail; onCancel: () => void }) {
  const { refData } = useUI();
  const { run, busy, error } = useSubmit();
  const [amount, setAmount] = useState(String(detail.amount / 100));
  const [accountId, setAccountId] = useState(detail.accountId ?? refData.accounts[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState(detail.categoryId ?? refData.expenseCategories[0]?.id ?? "");
  const [merchant, setMerchant] = useState(detail.merchant);
  const [date, setDate] = useState(detail.ymd);
  const [notes, setNotes] = useState(detail.notes ?? "");

  const hadSplit = detail.splits.length > 0;
  // PERCENT/RATIO store only the resulting paise amount, not the original
  // weights — those can't be losslessly reconstructed, so a split that was
  // created as percent/ratio reopens as EXACT with today's exact amounts
  // pre-filled (accurate) rather than guessing at weights (which would be
  // wrong unless the user happened to re-enter them before saving).
  const initialMode: "EQUAL" | "EXACT" = detail.splits[0]?.method === "EQUAL" ? "EQUAL" : "EXACT";
  const [split, setSplit] = useState(hadSplit);
  const [mode, setMode] = useState<"EQUAL" | "EXACT" | "PERCENT" | "RATIO">(initialMode);
  const [parts, setParts] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(detail.splits.filter((s) => s.participantId).map((s) => [s.participantId as string, true]))
  );
  const [exact, setExact] = useState<Record<string, string>>(() =>
    Object.fromEntries(detail.splits.filter((s) => s.participantId).map((s) => [s.participantId as string, String(s.owedAmount / 100)]))
  );
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [payerId, setPayerId] = useState<string | null>(detail.paidByParticipantId);

  const splitState: SplitEditorState = { split, setSplit, mode, setMode, parts, setParts, exact, setExact, weights, setWeights };
  const selected = refData.participants.filter((p) => parts[p.id]);
  const amtPaise = Math.round((Number(amount) || 0) * 100);
  // payer must be either "you" or someone currently selected in the split
  const effectivePayerId = payerId && selected.some((p) => p.id === payerId) ? payerId : null;

  return (
    <div className="flex flex-col gap-3">
      <Field label="AMOUNT (₹)">
        <AmountInput value={amount} onChange={setAmount} autoFocus />
      </Field>
      <div className="flex gap-2.5 flex-wrap">
        <Field label="ACCOUNT">
          <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {refData.accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.icon} {a.name}</option>
            ))}
          </select>
        </Field>
        <Field label="CATEGORY">
          <select className="field" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            {refData.expenseCategories.map((c) => (
              <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="flex gap-2.5 flex-wrap">
        <Field label="MERCHANT">
          <input className="field" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="e.g. Swiggy" />
        </Field>
        <Field label="DATE">
          <input className="field" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <Field label="NOTES">
        <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
      </Field>

      <SplitEditor state={splitState} amtPaise={amtPaise} participants={refData.participants} />

      {split && selected.length > 0 && (
        <Field label="PAID BY">
          <div className="flex gap-1.5 flex-wrap">
            {[{ id: null as string | null, name: "You" }, ...selected.map((p) => ({ id: p.id as string | null, name: p.name }))].map((who) => (
              <button
                key={who.id ?? "me"}
                onClick={() => setPayerId(who.id)}
                className="px-3 py-[7px] rounded-full text-[12px] font-semibold cursor-pointer border-none"
                style={{
                  background: effectivePayerId === who.id ? "var(--acc)" : "var(--accSoft)",
                  color: effectivePayerId === who.id ? "#fff" : "var(--acc)",
                }}
              >
                {who.name}
              </button>
            ))}
          </div>
        </Field>
      )}

      <ErrorNote error={error} />
      <div className="flex gap-2.5">
        <button onClick={onCancel} className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border border-line2 bg-card hover:bg-accsoft">
          Cancel
        </button>
        <div className="flex-[2]">
          <SubmitButton
            busy={busy}
            onClick={() =>
              run(
                () =>
                  updateExpenseAction({
                    id: detail.id,
                    amount,
                    accountId: accountId || null,
                    categoryId: categoryId || null,
                    merchant,
                    date,
                    notes: notes || undefined,
                    split: buildSplitPayload(splitState, selected.map((p) => p.id), effectivePayerId),
                  }),
                "Transaction updated"
              )
            }
          >
            Save changes
          </SubmitButton>
        </div>
      </div>
    </div>
  );
}

// ─────────── Edit: Income ───────────

function EditIncomeForm({ detail, onCancel }: { detail: TransactionDetail; onCancel: () => void }) {
  const { refData } = useUI();
  const { run, busy, error } = useSubmit();
  const [amount, setAmount] = useState(String(detail.amount / 100));
  const [accountId, setAccountId] = useState(detail.accountId ?? refData.accounts[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState(detail.categoryId ?? refData.incomeCategories[0]?.id ?? "");
  const [merchant, setMerchant] = useState(detail.merchant);
  const [date, setDate] = useState(detail.ymd);
  const [notes, setNotes] = useState(detail.notes ?? "");

  return (
    <div className="flex flex-col gap-3">
      <Field label="AMOUNT (₹)">
        <AmountInput value={amount} onChange={setAmount} autoFocus />
      </Field>
      <div className="flex gap-2.5 flex-wrap">
        <Field label="INTO ACCOUNT">
          <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {refData.accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.icon} {a.name}</option>
            ))}
          </select>
        </Field>
        <Field label="SOURCE">
          <select className="field" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            {refData.incomeCategories.map((c) => (
              <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="flex gap-2.5 flex-wrap">
        <Field label="DESCRIPTION">
          <input className="field" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="e.g. Salary · Acme Corp" />
        </Field>
        <Field label="DATE">
          <input className="field" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <Field label="NOTES">
        <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
      </Field>
      <ErrorNote error={error} />
      <div className="flex gap-2.5">
        <button onClick={onCancel} className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border border-line2 bg-card hover:bg-accsoft">
          Cancel
        </button>
        <div className="flex-[2]">
          <SubmitButton
            busy={busy}
            color="var(--green)"
            onClick={() =>
              run(
                () => updateIncomeAction({ id: detail.id, amount, accountId, categoryId: categoryId || null, merchant, date, notes: notes || undefined }),
                "Transaction updated"
              )
            }
          >
            Save changes
          </SubmitButton>
        </div>
      </div>
    </div>
  );
}

// ─────────── Edit: Transfer ───────────

function EditTransferForm({ detail, onCancel }: { detail: TransactionDetail; onCancel: () => void }) {
  const { refData } = useUI();
  const { run, busy, error } = useSubmit();
  const [amount, setAmount] = useState(String(detail.amount / 100));
  const [from, setFrom] = useState(detail.accountId ?? refData.accounts[0]?.id ?? "");
  const [to, setTo] = useState(detail.toAccountId ?? refData.accounts[1]?.id ?? refData.accounts[0]?.id ?? "");
  const [date, setDate] = useState(detail.ymd);
  const [notes, setNotes] = useState(detail.notes ?? "");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2.5 flex-wrap">
        <Field label="FROM">
          <select className="field" value={from} onChange={(e) => setFrom(e.target.value)}>
            {refData.accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.icon} {a.name}</option>
            ))}
          </select>
        </Field>
        <Field label="TO">
          <select className="field" value={to} onChange={(e) => setTo(e.target.value)}>
            {refData.accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.icon} {a.name}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="AMOUNT (₹)">
        <AmountInput value={amount} onChange={setAmount} autoFocus />
      </Field>
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
          <SubmitButton
            busy={busy}
            onClick={() =>
              run(
                () => updateTransferAction({ id: detail.id, amount, fromAccountId: from, toAccountId: to, date, notes: notes || undefined }),
                "Transaction updated"
              )
            }
          >
            Save changes
          </SubmitButton>
        </div>
      </div>
    </div>
  );
}
