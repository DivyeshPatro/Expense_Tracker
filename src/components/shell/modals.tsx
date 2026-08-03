"use client";

// Modal forms, matching the prototype: centered dialog on desktop, bottom sheet
// on mobile. Amount + category + account is enough to log an expense (≤3 interactions).

import { useEffect, useRef, useState } from "react";
import {
  addExpenseAction,
  addParticipantAction,
  createAccountAction,
  createBillAction,
  createGroupAction,
  openLoansForContactAction,
  saveBudgetAction,
  settleAction,
  updateAccountCardDetailsAction,
  updateParticipantDetailsAction,
} from "@/app/actions";
import { friendlyDay, todayYMD } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { ensureDeviceId, getDeviceName } from "@/lib/offline/db";
import type { OpenLoanRow } from "@/server/services/lending";
import { AccountOptions } from "./account-options";
import { DateField } from "./date-field";
import { createRuleFor, RepeatBlock, useRepeat } from "./repeat-block";
import { AmountInput, ErrorNote, Field, SubmitButton, useSubmit } from "./form-primitives";
import { CategoryPicker } from "./category-picker";
import { GroupCategorySelect } from "./group-category-select";
import { LendingContactSheet } from "./lending-detail";
import { LoanDetailModal } from "@/components/lending/loan-detail";
import { useOffline } from "./offline-context";
import { PendingDetailSheet } from "./pending-detail";
import { buildSplitPayload, SplitEditor, type SplitEditorState } from "./split-editor";
import { TransactionDetailSheet } from "./transaction-detail";
import { useUI, type ModalPrefill } from "./ui-context";
import { useFocusTrap } from "./use-focus-trap";

const TITLES: Record<string, string> = {
  exp: "Add expense",
  inc: "Add income",
  tr: "Transfer money",
  settle: "Settle up",
  budget: "New budget",
  account: "New account",
  bill: "New bill",
  friend: "Add friend",
  group: "New group",
  txDetail: "Transaction",
  pendingDetail: "Transaction",
  lendingEntry: "Lending entry",
  lendingContact: "Contact",
  loanDetail: "Loan details",
  accountCardDetails: "Card details",
};

/**
 * Tracks the on-screen keyboard via the visualViewport API. `inset` is the
 * keyboard height (0 when closed); `height` is the visible viewport height.
 * A modal that lifts by `inset` and caps its height at `height` keeps its
 * sticky Save above the keyboard instead of behind it — the core of the
 * mobile keyboard-aware layout (Phase 3).
 */
function useKeyboardInset() {
  const [state, setState] = useState({ inset: 0, height: 0 });
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setState({ inset, height: vv.height });
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, []);
  return state;
}

export function Modals() {
  const { modal, closeModal } = useUI();
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { inset, height } = useKeyboardInset();
  useFocusTrap(panelRef, !!modal);
  useEffect(() => {
    if (modal) panelRef.current?.focus();
  }, [modal]);
  if (!modal) return null;
  // Bring the just-focused control into view inside the scroll body once the
  // keyboard has had a moment to animate in — so typing never happens under
  // the fold or behind the keyboard.
  const onFocusIn = (e: React.FocusEvent) => {
    const t = e.target as HTMLElement;
    if (t.matches("input, select, textarea")) {
      setTimeout(() => t.scrollIntoView({ block: "center", behavior: "smooth" }), 120);
    }
  };
  return (
    <div
      onClick={closeModal}
      className="fixed inset-0 z-[60] flex items-end md:items-center justify-center p-0 md:p-4"
      style={{ background: "var(--ov)", paddingBottom: inset > 0 ? inset : undefined }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={TITLES[modal.type]}
        onClick={(e) => e.stopPropagation()}
        onFocus={onFocusIn}
        className="w-full md:w-[min(460px,100%)] max-h-[92dvh] md:max-h-[88vh] bg-card rounded-t-[18px] rounded-b-none md:rounded-2xl box-border flex flex-col outline-none overflow-hidden"
        style={{ boxShadow: "var(--shLg)", animation: "rise .22s ease", maxHeight: inset > 0 && height ? `${height - 12}px` : undefined }}
      >
        <div className="flex justify-between items-center flex-none px-[22px] pt-[18px] pb-2">
          <div className="text-base font-extrabold tracking-tight">{TITLES[modal.type]}</div>
          <button onClick={closeModal} aria-label="Close" className="w-8 h-8 rounded-lg grid place-items-center text-mut cursor-pointer bg-transparent border-none hover:bg-accsoft">
            ✕
          </button>
        </div>
        <div ref={bodyRef} className="flex-1 overflow-auto px-[22px] pb-[22px] flex flex-col gap-[13px]">
        {modal.type === "exp" && <ExpenseForm prefill={modal.prefill} />}
        {modal.type === "inc" && <IncomeForm prefill={modal.prefill} />}
        {modal.type === "tr" && <TransferForm prefill={modal.prefill} />}
        {modal.type === "settle" && <SettleForm prefill={modal.prefill} />}
        {modal.type === "budget" && <BudgetForm />}
        {modal.type === "account" && <AccountForm />}
        {modal.type === "bill" && <BillForm />}
        {modal.type === "friend" && <FriendForm />}
        {modal.type === "group" && <GroupForm />}
        {modal.type === "txDetail" && modal.prefill?.transactionId && <TransactionDetailSheet transactionId={modal.prefill.transactionId} />}
        {modal.type === "pendingDetail" && modal.prefill?.intentId && <PendingDetailSheet intentId={modal.prefill.intentId} />}
        {modal.type === "lendingEntry" && <LendingEntryForm prefill={modal.prefill} />}
        {modal.type === "lendingContact" && modal.prefill?.participantId && <LendingContactSheet participantId={modal.prefill.participantId} />}
        {modal.type === "loanDetail" && modal.prefill?.loanEntryId && <LoanDetailModal loanEntryId={modal.prefill.loanEntryId} />}
        {modal.type === "accountCardDetails" && modal.prefill?.accountId && <AccountCardDetailsForm accountId={modal.prefill.accountId} />}
        </div>
      </div>
    </div>
  );
}

// ─────────── Expense (with split) ───────────

function ExpenseForm({ prefill }: { prefill?: ModalPrefill }) {
  const { refData } = useUI();
  const { createViaOutbox } = useOffline();
  const { run, busy, error } = useSubmit();
  const [amount, setAmount] = useState(prefill?.dupAmountRupees ?? "");
  const [accountId, setAccountId] = useState(prefill?.dupAccountId ?? refData.accounts[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState(
    () => prefill?.dupCategoryId ?? (refData.expenseCategories.find((c) => c.name === "Food") ?? refData.expenseCategories[0])?.id ?? ""
  );
  const [merchant, setMerchant] = useState(prefill?.dupMerchant ?? "");
  const [date, setDate] = useState(todayYMD());
  const [notes, setNotes] = useState(prefill?.dupNotes ?? "");
  const [groupId, setGroupId] = useState(prefill?.dupGroupId ?? ""); // "" = personal — collaboration-architecture-rfc §2/§4 (migration step 4)
  const [split, setSplit] = useState(!!prefill?.split);
  const [mode, setMode] = useState<"EQUAL" | "EXACT" | "PERCENT" | "RATIO">("EQUAL");
  const [parts, setParts] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(refData.participants.slice(0, 2).map((p) => [p.id, !!prefill?.split]))
  );
  const [exact, setExact] = useState<Record<string, string>>({});
  const [weights, setWeights] = useState<Record<string, string>>({});
  // group-expenses-sprint: who actually paid — null = "Me". The expense's
  // creator and its payer are two different people (Rahul paid, I logged
  // it) — defaults to Me, same as the implicit behavior before this existed.
  const [payerId, setPayerId] = useState<string | null>(null);
  const repeat = useRepeat();
  // Captured by the submit closure so a schedule that fails to save can be
  // reported in the success message without failing the whole submission.
  let scheduleError: string | null = null;

  const splitState: SplitEditorState = { split, setSplit, mode, setMode, parts, setParts, exact, setExact, weights, setWeights, payerId, setPayerId };
  const selected = refData.participants.filter((p) => parts[p.id]);
  const amtPaise = Math.round((Number(amount) || 0) * 100);

  function selectGroup(id: string) {
    setGroupId(id);
    // group-expenses-sprint: a category id from the wrong namespace (personal,
    // or a different group) must never silently ride along across a group switch
    setCategoryId("");
  }

  return (
    <div className="flex flex-col gap-3">
      <Field label="AMOUNT (₹)">
        <AmountInput value={amount} onChange={setAmount} autoFocus />
      </Field>
      <div className="flex gap-2.5 flex-wrap">
        <Field label="ACCOUNT">
          <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <AccountOptions accounts={refData.accounts} />
          </select>
        </Field>
        <Field label="CATEGORY">
          {groupId ? (
            <GroupCategorySelect groupId={groupId} value={categoryId} onChange={setCategoryId} />
          ) : (
            <CategoryPicker categories={refData.expenseCategories} value={categoryId} onChange={setCategoryId} recentKey="ledgerly-recent-cat-expense" />
          )}
        </Field>
      </div>
      <div className="flex gap-2.5 flex-wrap">
        <Field label="MERCHANT">
          <input className="field" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="e.g. Swiggy" />
        </Field>
        <Field label="DATE">
          <DateField value={date} onChange={setDate} />
        </Field>
      </div>
      <Field label="NOTES">
        <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
      </Field>
      {refData.groups.length > 0 && (
        <Field label="GROUP">
          <select className="field" value={groupId} onChange={(e) => selectGroup(e.target.value)}>
            <option value="">Personal (not in a group)</option>
            {refData.groups.map((g) => (
              <option key={g.id} value={g.id}>🏠 {g.name}</option>
            ))}
          </select>
        </Field>
      )}

      <SplitEditor state={splitState} amtPaise={amtPaise} participants={refData.participants} />

      {/* A rule's template carries neither splits nor a group, so repeating is
          offered only for a plain personal expense rather than silently
          scheduling something different from what's on screen. */}
      {!split && !groupId && <RepeatBlock state={repeat} transactionYmd={date} />}

      <ErrorNote error={error} />
      <SubmitButton
        busy={busy}
        onClick={() =>
          run(
            () => {
              const payload = {
                amount,
                accountId: accountId || null,
                categoryId: categoryId || null,
                merchant,
                date,
                notes: notes || undefined,
                split: buildSplitPayload(splitState, selected.map((p) => p.id)),
                groupId: groupId || null,
              };
              // Phase 1 queues solo creates only (spec §17); a split touches
              // friends' balances and needs the server's validation
              if (split) {
                if (typeof navigator !== "undefined" && !navigator.onLine) {
                  return Promise.resolve({ ok: false as const, error: "Split expenses need internet — try again when you're back online." });
                }
                // production audit §1.2/§PhaseA.2: this direct call used to
                // carry no intent at all, so it never created an Intent row —
                // invisible to any LATER conflict check on this same
                // transaction. Real device identity when available (same
                // quality of tracking as an outbox create), an ephemeral one
                // only if IndexedDB is truly unavailable.
                return (async () => {
                  const deviceId = await ensureDeviceId().catch(() => crypto.randomUUID());
                  const deviceName = await getDeviceName().catch(() => undefined);
                  return addExpenseAction({
                    ...payload,
                    intent: { intentId: crypto.randomUUID(), deviceId, deviceName, clientTs: new Date().toISOString() },
                  });
                })();
              }
              // Schedule after the transaction lands. A failure here must not
              // fail the submission — the expense is already committed, and
              // reporting failure would invite a duplicate on resubmit — so it
              // is surfaced in the success message instead.
              return createViaOutbox("expense.create", payload).then(async (res) => {
                if (res.ok && repeat.on && !split && !groupId) {
                  scheduleError = await createRuleFor(repeat, {
                    type: "EXPENSE",
                    amount,
                    accountId: accountId || null,
                    categoryId: categoryId || null,
                    merchant,
                    date,
                  });
                }
                return res;
              });
            },
            () =>
              scheduleError
                ? `Expense added — but the repeat wasn't saved: ${scheduleError}`
                : repeat.on && !split && !groupId
                  ? "Expense added and scheduled to repeat"
                  : split
                    ? "Split expense added"
                    : "Expense added"
          )
        }
      >
        Add expense
      </SubmitButton>
    </div>
  );
}

// ─────────── Income ───────────

function IncomeForm({ prefill }: { prefill?: ModalPrefill }) {
  const { refData } = useUI();
  const { createViaOutbox } = useOffline();
  const { run, busy, error } = useSubmit();
  const [amount, setAmount] = useState(prefill?.dupAmountRupees ?? "");
  const [accountId, setAccountId] = useState(prefill?.dupAccountId ?? refData.accounts[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState(
    () => prefill?.dupCategoryId ?? (refData.incomeCategories.find((c) => c.name === "Salary") ?? refData.incomeCategories[0])?.id ?? ""
  );
  const [merchant, setMerchant] = useState(prefill?.dupMerchant ?? "");
  const [date, setDate] = useState(todayYMD());
  const [groupId, setGroupId] = useState(prefill?.dupGroupId ?? "");
  const repeat = useRepeat();
  let scheduleError: string | null = null;
  return (
    <div className="flex flex-col gap-3">
      <Field label="AMOUNT (₹)">
        <AmountInput value={amount} onChange={setAmount} autoFocus />
      </Field>
      <div className="flex gap-2.5 flex-wrap">
        <Field label="INTO ACCOUNT">
          <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <AccountOptions accounts={refData.accounts} />
          </select>
        </Field>
        <Field label="SOURCE">
          <CategoryPicker categories={refData.incomeCategories} value={categoryId} onChange={setCategoryId} recentKey="ledgerly-recent-cat-income" label="Choose a source" />
        </Field>
      </div>
      <div className="flex gap-2.5 flex-wrap">
        <Field label="DESCRIPTION">
          <input className="field" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="e.g. Salary · Acme Corp" />
        </Field>
        <Field label="DATE">
          <DateField value={date} onChange={setDate} />
        </Field>
      </div>
      {refData.groups.length > 0 && (
        <Field label="GROUP">
          <select className="field" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">Personal (not in a group)</option>
            {refData.groups.map((g) => (
              <option key={g.id} value={g.id}>🏠 {g.name}</option>
            ))}
          </select>
        </Field>
      )}
      {!groupId && <RepeatBlock state={repeat} transactionYmd={date} />}
      <ErrorNote error={error} />
      <SubmitButton
        busy={busy}
        color="var(--green)"
        onClick={() =>
          run(
            () =>
              createViaOutbox("income.create", { amount, accountId, categoryId: categoryId || null, merchant, date, groupId: groupId || null }).then(
                async (res) => {
                  if (res.ok && repeat.on && !groupId) {
                    scheduleError = await createRuleFor(repeat, {
                      type: "INCOME",
                      amount,
                      accountId: accountId || null,
                      categoryId: categoryId || null,
                      merchant,
                      date,
                    });
                  }
                  return res;
                }
              ),
            () =>
              scheduleError
                ? `Income added — but the repeat wasn't saved: ${scheduleError}`
                : repeat.on && !groupId
                  ? "Income added and scheduled to repeat"
                  : "Income added"
          )
        }
      >
        Add income
      </SubmitButton>
    </div>
  );
}

// ─────────── Transfer ───────────

function TransferForm({ prefill }: { prefill?: ModalPrefill }) {
  const { refData } = useUI();
  const { createViaOutbox } = useOffline();
  const { run, busy, error } = useSubmit();
  const [amount, setAmount] = useState(prefill?.dupAmountRupees ?? "");
  const [from, setFrom] = useState(prefill?.dupAccountId ?? refData.accounts[0]?.id ?? "");
  const [to, setTo] = useState(prefill?.dupToAccountId ?? refData.accounts[1]?.id ?? refData.accounts[0]?.id ?? "");
  const [date, setDate] = useState(todayYMD());
  const [groupId, setGroupId] = useState(prefill?.dupGroupId ?? "");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2.5 flex-wrap">
        <Field label="FROM">
          <select className="field" value={from} onChange={(e) => setFrom(e.target.value)}>
            <AccountOptions accounts={refData.accounts} />
          </select>
        </Field>
        <Field label="TO">
          <select className="field" value={to} onChange={(e) => setTo(e.target.value)}>
            <AccountOptions accounts={refData.accounts} />
          </select>
        </Field>
      </div>
      <Field label="AMOUNT (₹)">
        <AmountInput value={amount} onChange={setAmount} autoFocus />
      </Field>
      <Field label="DATE">
        <DateField value={date} onChange={setDate} />
      </Field>
      {refData.groups.length > 0 && (
        <Field label="GROUP">
          <select className="field" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">Personal (not in a group)</option>
            {refData.groups.map((g) => (
              <option key={g.id} value={g.id}>🏠 {g.name}</option>
            ))}
          </select>
        </Field>
      )}
      <ErrorNote error={error} />
      <SubmitButton
        busy={busy}
        onClick={() =>
          run(
            () => createViaOutbox("transfer.create", { amount, fromAccountId: from, toAccountId: to, date, groupId: groupId || null }),
            "Transfer recorded"
          )
        }
      >
        Transfer
      </SubmitButton>
    </div>
  );
}

// ─────────── Settle up ───────────

function SettleForm({ prefill }: { prefill?: ModalPrefill }) {
  const { run, busy, error } = useSubmit();
  const [amount, setAmount] = useState(prefill?.amountRupees ?? "");
  const [method, setMethod] = useState<"UPI" | "CASH" | "BANK">("UPI");
  const direction = prefill?.direction ?? "TO_OWNER";
  const name = prefill?.participantName ?? "";
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[13px] text-mut bg-accsoft rounded-[9px] px-[13px] py-[11px] font-semibold">
        {direction === "TO_OWNER" ? `${name} pays you back` : `You pay ${name} back`}
      </div>
      <Field label="AMOUNT (₹)">
        <AmountInput value={amount} onChange={setAmount} autoFocus />
      </Field>
      <Field label="METHOD">
        <div className="flex gap-1.5">
          {(["UPI", "CASH", "BANK"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMethod(m)}
              className="px-[15px] py-[7px] rounded-lg text-[12.5px] font-semibold cursor-pointer border-none"
              style={{ background: method === m ? "var(--acc)" : "var(--accSoft)", color: method === m ? "#fff" : "var(--acc)" }}
            >
              {m === "UPI" ? "UPI" : m === "CASH" ? "Cash" : "Bank"}
            </button>
          ))}
        </div>
      </Field>
      <ErrorNote error={error} />
      <SubmitButton
        busy={busy}
        color="var(--green)"
        onClick={() => run(() => settleAction({ participantId: prefill?.participantId, direction, amount, method }), "Settlement recorded")}
      >
        Record settlement
      </SubmitButton>
    </div>
  );
}

// ─────────── Lending (Phase 1): "You Gave" / "You Got" ───────────

const NEW_CONTACT = "__new__";

function LendingEntryForm({ prefill }: { prefill?: ModalPrefill }) {
  const { refData } = useUI();
  const { createViaOutbox } = useOffline();
  const { run, busy, error } = useSubmit();
  const [kind, setKind] = useState<"GAVE" | "GOT">(prefill?.loanKind ?? "GAVE");
  const [participantId, setParticipantId] = useState(prefill?.participantId ?? refData.participants[0]?.id ?? "");
  const [amount, setAmount] = useState(prefill?.dupAmountRupees ?? prefill?.targetLoanRemainingRupees ?? "");
  const [accountId, setAccountId] = useState(prefill?.dupAccountId ?? "");
  const [date, setDate] = useState(todayYMD());
  const [dueDate, setDueDate] = useState(prefill?.dupDueDate ?? "");
  const [reason, setReason] = useState(prefill?.dupMerchant ?? "");
  const [notes, setNotes] = useState(prefill?.dupNotes ?? "");
  // lending-module-phase2: manual settlement allocation, GOT entries only.
  // "auto" ⇒ send no allocations, server FIFO-allocates. "custom" ⇒ send
  // exactly what's in allocationAmounts. Arriving here via "Record
  // Repayment" on a specific loan (Loan Detail) starts pre-targeted at that
  // loan instead of defaulting to auto.
  const [allocationMode, setAllocationMode] = useState<"auto" | "custom">(prefill?.targetLoanEntryId ? "custom" : "auto");
  const [allocationAmounts, setAllocationAmounts] = useState<Record<string, string>>(() =>
    prefill?.targetLoanEntryId ? { [prefill.targetLoanEntryId]: prefill.targetLoanRemainingRupees ?? "" } : {}
  );
  // "+ New Contact" (objective: never leave the lending flow just to add a
  // contact). refData is loaded once at layout mount and isn't updated by a
  // server action's revalidatePath within the same client session, so a
  // contact created here wouldn't appear in refData.participants until the
  // next full navigation — tracked locally instead and merged into the
  // dropdown's options, which is all this form actually needs.
  const [justCreated, setJustCreated] = useState<{ id: string; name: string }[]>([]);

  const allParticipants = [...refData.participants, ...justCreated.map((p) => ({ ...p, initial: p.name.charAt(0).toUpperCase(), color: "var(--acc)" }))];
  const participantName = allParticipants.find((p) => p.id === participantId)?.name ?? "";

  if (participantId === NEW_CONTACT) {
    return (
      <NewContactInline
        onCreated={(p) => {
          setJustCreated((list) => [...list, p]);
          setParticipantId(p.id);
        }}
        onCancel={() => setParticipantId(refData.participants[0]?.id ?? "")}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1.5">
        {(["GAVE", "GOT"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            aria-pressed={kind === k}
            className="flex-1 px-[13px] py-2 rounded-lg text-[13px] font-bold cursor-pointer border-none"
            style={{ background: kind === k ? "var(--acc)" : "var(--accSoft)", color: kind === k ? "#fff" : "var(--acc)" }}
          >
            {k === "GAVE" ? "You Gave" : "You Got"}
          </button>
        ))}
      </div>
      <Field label="AMOUNT (₹)">
        <AmountInput value={amount} onChange={setAmount} autoFocus />
      </Field>
      <Field label="CONTACT">
        <select className="field" value={participantId} onChange={(e) => setParticipantId(e.target.value)}>
          {allParticipants.length === 0 && <option value="">Add a friend first</option>}
          {allParticipants.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
          <option value={NEW_CONTACT}>+ New Contact</option>
        </select>
      </Field>
      {kind === "GOT" && participantId && (
        <LoanAllocationPicker
          participantId={participantId}
          mode={allocationMode}
          setMode={setAllocationMode}
          amounts={allocationAmounts}
          setAmounts={setAllocationAmounts}
          repaymentAmountRupees={amount}
        />
      )}
      <div className="flex gap-2.5 flex-wrap">
        <Field label="FUNDING SOURCE">
          <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Untracked / cash in hand</option>
            <AccountOptions accounts={refData.accounts} />
          </select>
        </Field>
        <Field label="DATE">
          <DateField value={date} onChange={setDate} />
        </Field>
      </div>
      {kind === "GAVE" && (
        <Field label="DUE DATE (OPTIONAL)">
          <div className="flex items-center gap-2">
            <DateField value={dueDate} onChange={setDueDate} min={date} />
            {dueDate && (
              <button
                type="button"
                onClick={() => setDueDate("")}
                className="text-[11.5px] font-semibold text-mut2 bg-transparent border-none cursor-pointer hover:text-ink flex-none"
              >
                Clear
              </button>
            )}
          </div>
        </Field>
      )}
      <Field label="REASON">
        <input className="field" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Dinner, rent help" />
      </Field>
      <Field label="NOTES">
        <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
      </Field>
      <ErrorNote error={error} />
      <SubmitButton
        busy={busy}
        color={kind === "GAVE" ? "var(--acc)" : "var(--green)"}
        onClick={() =>
          run(
            () =>
              createViaOutbox("loan.create", {
                participantId,
                kind,
                amount,
                accountId: accountId || null,
                reason: reason || undefined,
                notes: notes || undefined,
                date,
                dueDate: kind === "GAVE" && dueDate ? dueDate : null,
                participantName, // display-only, for intentLabel — ignored by the server schema
                allocations:
                  kind === "GOT" && allocationMode === "custom"
                    ? Object.entries(allocationAmounts)
                        .filter(([, v]) => Number(v) > 0)
                        .map(([gaveEntryId, v]) => ({ gaveEntryId, amount: v }))
                    : undefined,
              }),
            kind === "GAVE" ? "Loan recorded" : "Repayment recorded"
          )
        }
      >
        {kind === "GAVE" ? "Record You Gave" : "Record You Got"}
      </SubmitButton>
    </div>
  );
}

/** Inline "+ New Contact" (objective: never leave the lending flow just to
 * add a contact). Two existing actions composed, not a new service:
 * addParticipantAction (name only — matches FriendForm's own contract)
 * followed by updateParticipantDetailsAction only if an optional field was
 * actually filled in, so a bare-name contact doesn't trigger a pointless
 * second write. */
function NewContactInline({ onCreated, onCancel }: { onCreated: (p: { id: string; name: string }) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [photo, setPhoto] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await addParticipantAction({ displayName: name.trim() });
    if (!res.ok || !res.participantId) {
      setBusy(false);
      setError(res.ok ? "Something went wrong" : res.error);
      return;
    }
    if (phone.trim() || photo.trim() || notes.trim()) {
      await updateParticipantDetailsAction({
        participantId: res.participantId,
        displayName: name.trim(),
        phone: phone.trim() || null,
        photo: photo.trim() || null,
        notes: notes.trim() || null,
      });
    }
    setBusy(false);
    onCreated({ id: res.participantId, name: name.trim() });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="text-[13.5px] font-bold">New contact</div>
        <button type="button" onClick={onCancel} className="text-[11.5px] font-semibold text-mut2 bg-transparent border-none cursor-pointer hover:text-ink">
          Cancel
        </button>
      </div>
      <Field label="NAME">
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rohan" autoFocus />
      </Field>
      <Field label="PHONE (OPTIONAL)">
        <input className="field" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Optional" />
      </Field>
      <Field label="PHOTO URL (OPTIONAL)">
        <input className="field" value={photo} onChange={(e) => setPhoto(e.target.value)} placeholder="https://…" />
      </Field>
      <Field label="NOTES (OPTIONAL)">
        <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
      </Field>
      <ErrorNote error={error} />
      <SubmitButton busy={busy} onClick={create}>
        Create & continue
      </SubmitButton>
    </div>
  );
}

/** Settlement engine, Priority 1's "allow users to manually override the
 * allocation" — default is FIFO (server-computed, nothing sent); Custom
 * lets the user split this repayment across specific open loans. Omitted
 * entirely (returns null) when the contact has no open loans to allocate
 * against — the repayment is just recorded as an ordinary balance
 * reduction, same as Phase 1. */
function LoanAllocationPicker({
  participantId,
  repaymentAmountRupees,
  mode,
  setMode,
  amounts,
  setAmounts,
}: {
  participantId: string;
  repaymentAmountRupees: string;
  mode: "auto" | "custom";
  setMode: (m: "auto" | "custom") => void;
  amounts: Record<string, string>;
  setAmounts: (fn: (prev: Record<string, string>) => Record<string, string>) => void;
}) {
  const [loans, setLoans] = useState<OpenLoanRow[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setLoans(undefined);
    void openLoansForContactAction(participantId).then((rows) => {
      if (!cancelled) setLoans(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [participantId]);

  if (loans === undefined) return <div className="text-[11.5px] text-mut2 px-1">Checking open loans…</div>;
  if (loans.length === 0) return null;

  const repaymentPaise = Math.round((Number(repaymentAmountRupees) || 0) * 100);
  const totalAllocated = loans.reduce((s, l) => s + Math.round((Number(amounts[l.id]) || 0) * 100), 0);

  return (
    <div className="flex flex-col gap-2 bg-accsoft rounded-[10px] p-3">
      <div className="flex items-center justify-between">
        <div className="text-[11.5px] font-bold">Apply to</div>
        <div className="flex gap-1 bg-card border border-line rounded-[7px] p-[2px]">
          {(["auto", "custom"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className="px-2.5 py-1 rounded-[5px] text-[11px] font-bold cursor-pointer border-none"
              style={{ background: mode === m ? "var(--acc)" : "transparent", color: mode === m ? "#fff" : "var(--mut)" }}
            >
              {m === "auto" ? "Auto" : "Custom"}
            </button>
          ))}
        </div>
      </div>
      {mode === "auto" && (
        <div className="text-[11px] text-mut2">Applied to the oldest outstanding loan(s) first.</div>
      )}
      {mode === "custom" && (
        <div className="flex flex-col gap-1.5">
          {loans.map((l) => (
            <div key={l.id} className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-semibold truncate">{l.reason || friendlyDay(l.occurredAt)}</div>
                <div className="text-[10.5px] text-mut2">Remaining {formatPaise(l.remainingAmount)}</div>
              </div>
              <input
                type="number"
                inputMode="decimal"
                className="field w-[92px] flex-none"
                placeholder="0"
                value={amounts[l.id] ?? ""}
                onChange={(e) => setAmounts((prev) => ({ ...prev, [l.id]: e.target.value }))}
              />
            </div>
          ))}
          <div className="text-[11px] text-mut2">
            Allocated {formatPaise(totalAllocated)} of {formatPaise(repaymentPaise)}
            {totalAllocated > repaymentPaise && <span className="text-red font-semibold"> — exceeds the amount above</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────── Budget ───────────

function BudgetForm() {
  const { refData } = useUI();
  const { run, busy, error } = useSubmit();
  const [categoryId, setCategoryId] = useState(
    () => (refData.expenseCategories.find((c) => c.name === "Food") ?? refData.expenseCategories[0])?.id ?? ""
  );
  const [amount, setAmount] = useState("");
  return (
    <div className="flex flex-col gap-3">
      <Field label="CATEGORY">
        <select className="field" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          {refData.expenseCategories.map((c) => (
            <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
          ))}
        </select>
      </Field>
      <Field label="MONTHLY LIMIT (₹)">
        <AmountInput value={amount} onChange={setAmount} autoFocus />
      </Field>
      <ErrorNote error={error} />
      <SubmitButton busy={busy} onClick={() => run(() => saveBudgetAction({ categoryId, limit: amount }), "Budget saved")}>
        Save budget
      </SubmitButton>
    </div>
  );
}

// ─────────── Account ───────────

const ACCOUNT_TYPES = [
  { value: "BANK", label: "🏦 Bank account" },
  { value: "CASH", label: "💵 Cash" },
  { value: "WALLET", label: "📱 UPI wallet" },
  { value: "CREDIT_CARD", label: "💳 Credit card" },
  { value: "INVESTMENT", label: "📈 Investment" },
] as const;

function AccountForm() {
  const { run, busy, error } = useSubmit();
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("BANK");
  const [opening, setOpening] = useState("");
  const [cardNetwork, setCardNetwork] = useState("");
  const [cardLast4, setCardLast4] = useState("");
  const [statementDay, setStatementDay] = useState("");
  const [dueDay, setDueDay] = useState("");
  const isCard = type === "CREDIT_CARD";
  return (
    <div className="flex flex-col gap-3">
      <Field label="NICKNAME">
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. HDFC Savings" autoFocus />
      </Field>
      <div className="flex gap-2.5 flex-wrap">
        <Field label="TYPE">
          <select className="field" value={type} onChange={(e) => setType(e.target.value)}>
            {ACCOUNT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </Field>
        <Field label="OPENING BALANCE (₹)">
          <input type="number" inputMode="decimal" className="field" value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0" />
        </Field>
      </div>
      {isCard && (
        <>
          <div className="flex gap-2.5 flex-wrap">
            <Field label="NETWORK">
              <input className="field" value={cardNetwork} onChange={(e) => setCardNetwork(e.target.value)} placeholder="e.g. Visa" />
            </Field>
            <Field label="LAST 4 DIGITS">
              <input className="field" inputMode="numeric" maxLength={4} value={cardLast4} onChange={(e) => setCardLast4(e.target.value.replace(/\D/g, ""))} placeholder="4242" />
            </Field>
          </div>
          <div className="flex gap-2.5 flex-wrap">
            <Field label="STATEMENT DAY (1–31)">
              <input type="number" min={1} max={31} className="field" value={statementDay} onChange={(e) => setStatementDay(e.target.value)} placeholder="e.g. 3" />
            </Field>
            <Field label="PAYMENT DUE DAY (1–31)">
              <input type="number" min={1} max={31} className="field" value={dueDay} onChange={(e) => setDueDay(e.target.value)} placeholder="e.g. 18" />
            </Field>
          </div>
        </>
      )}
      <ErrorNote error={error} />
      <SubmitButton
        busy={busy}
        onClick={() =>
          run(
            () =>
              createAccountAction({
                name,
                type,
                openingBalance: opening || 0,
                cardNetwork: isCard && cardNetwork ? cardNetwork : undefined,
                cardLast4: isCard && cardLast4 ? cardLast4 : undefined,
                statementDay: isCard && statementDay ? statementDay : undefined,
                dueDay: isCard && dueDay ? dueDay : undefined,
              }),
            "Account added"
          )
        }
      >
        Add account
      </SubmitButton>
    </div>
  );
}

function AccountCardDetailsForm({ accountId }: { accountId: string }) {
  const { refData } = useUI();
  const { run, busy, error } = useSubmit();
  const account = refData.accounts.find((a) => a.id === accountId);
  const [cardNetwork, setCardNetwork] = useState(account?.cardNetwork ?? "");
  const [cardLast4, setCardLast4] = useState(account?.cardLast4 ?? "");
  const [statementDay, setStatementDay] = useState(account?.statementDay ? String(account.statementDay) : "");
  const [dueDay, setDueDay] = useState(account?.dueDay ? String(account.dueDay) : "");
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[12.5px] text-mut2">{account?.name ?? "This card"}&apos;s billing cycle drives Card Billing Intelligence&apos;s recovery guidance.</div>
      <div className="flex gap-2.5 flex-wrap">
        <Field label="NETWORK">
          <input className="field" value={cardNetwork} onChange={(e) => setCardNetwork(e.target.value)} placeholder="e.g. Visa" autoFocus />
        </Field>
        <Field label="LAST 4 DIGITS">
          <input className="field" inputMode="numeric" maxLength={4} value={cardLast4} onChange={(e) => setCardLast4(e.target.value.replace(/\D/g, ""))} placeholder="4242" />
        </Field>
      </div>
      <div className="flex gap-2.5 flex-wrap">
        <Field label="STATEMENT DAY (1–31)">
          <input type="number" min={1} max={31} className="field" value={statementDay} onChange={(e) => setStatementDay(e.target.value)} placeholder="e.g. 3" />
        </Field>
        <Field label="PAYMENT DUE DAY (1–31)">
          <input type="number" min={1} max={31} className="field" value={dueDay} onChange={(e) => setDueDay(e.target.value)} placeholder="e.g. 18" />
        </Field>
      </div>
      <ErrorNote error={error} />
      <SubmitButton
        busy={busy}
        onClick={() =>
          run(
            () =>
              updateAccountCardDetailsAction({
                accountId,
                cardNetwork: cardNetwork || null,
                cardLast4: cardLast4 || null,
                statementDay: statementDay ? statementDay : null,
                dueDay: dueDay ? dueDay : null,
              }),
            "Card details saved"
          )
        }
      >
        Save card details
      </SubmitButton>
    </div>
  );
}

// ─────────── Bill ───────────

function BillForm() {
  const { refData } = useUI();
  const { run, busy, error } = useSubmit();
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState(refData.expenseCategories[0]?.id ?? "");
  const [dueDate, setDueDate] = useState(todayYMD());
  const [cadence, setCadence] = useState<string>("MONTHLY");
  return (
    <div className="flex flex-col gap-3">
      <Field label="NAME">
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. ACT Fibernet" autoFocus />
      </Field>
      <div className="flex gap-2.5 flex-wrap">
        <Field label="AMOUNT (₹)">
          <AmountInput value={amount} onChange={setAmount} />
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
        <Field label="DUE DATE">
          <DateField value={dueDate} onChange={setDueDate} />
        </Field>
        <Field label="REPEATS">
          <select className="field" value={cadence} onChange={(e) => setCadence(e.target.value)}>
            <option value="MONTHLY">🔁 Monthly</option>
            <option value="WEEKLY">🔁 Weekly</option>
            <option value="QUARTERLY">🔁 Quarterly</option>
            <option value="YEARLY">🔁 Yearly</option>
            <option value="">One-off</option>
          </select>
        </Field>
      </div>
      <ErrorNote error={error} />
      <SubmitButton
        busy={busy}
        onClick={() => run(() => createBillAction({ name, amount, categoryId: categoryId || null, dueDate, cadence: cadence || null }), "Bill added")}
      >
        Add bill
      </SubmitButton>
    </div>
  );
}

// ─────────── Friend ───────────

function FriendForm() {
  const { run, busy, error } = useSubmit();
  const [name, setName] = useState("");
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[12.5px] text-mut">
        Friends don&apos;t need an account — you can split with them right away, and link them to a real user later via invitation.
      </div>
      <Field label="NAME">
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rohan" autoFocus />
      </Field>
      <ErrorNote error={error} />
      <SubmitButton busy={busy} onClick={() => run(() => addParticipantAction({ displayName: name }), "Friend added")}>
        Add friend
      </SubmitButton>
    </div>
  );
}

// ─────────── Group ───────────

function GroupForm() {
  const { refData } = useUI();
  const { run, busy, error } = useSubmit();
  const [name, setName] = useState("");
  const [parts, setParts] = useState<Record<string, boolean>>({});
  const selected = refData.participants.filter((p) => parts[p.id]);
  return (
    <div className="flex flex-col gap-3">
      <Field label="GROUP NAME">
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Flat 402" autoFocus />
      </Field>
      <Field label="MEMBERS">
        <div className="flex gap-2 flex-wrap mt-1.5">
          {refData.participants.length === 0 && <div className="text-[12.5px] text-mut2">Add a friend first.</div>}
          {refData.participants.map((p) => {
            const on = !!parts[p.id];
            return (
              <button
                key={p.id}
                onClick={() => setParts((s) => ({ ...s, [p.id]: !s[p.id] }))}
                className="flex items-center gap-[7px] px-3 py-[7px] rounded-full text-[12.5px] font-semibold cursor-pointer"
                style={{
                  border: `1px solid ${on ? "var(--acc)" : "var(--line2)"}`,
                  background: on ? "var(--accSoft)" : "transparent",
                  color: on ? "var(--acc)" : "var(--mut)",
                }}
              >
                <span className="w-[18px] h-[18px] rounded-full grid place-items-center text-[9.5px] font-bold text-white" style={{ background: p.color }}>
                  {p.initial}
                </span>
                {p.name}
              </button>
            );
          })}
        </div>
      </Field>
      <ErrorNote error={error} />
      <SubmitButton
        busy={busy}
        onClick={() => run(() => createGroupAction({ name, participantIds: selected.map((p) => p.id) }), "Group created")}
      >
        Create group
      </SubmitButton>
    </div>
  );
}
