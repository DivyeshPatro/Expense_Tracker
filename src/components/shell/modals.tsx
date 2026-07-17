"use client";

// Modal forms, matching the prototype: centered dialog on desktop, bottom sheet
// on mobile. Amount + category + account is enough to log an expense (≤3 interactions).

import { useState } from "react";
import {
  addExpenseAction,
  addParticipantAction,
  createAccountAction,
  createBillAction,
  createGroupAction,
  saveBudgetAction,
  settleAction,
} from "@/app/actions";
import { todayYMD } from "@/lib/dates";
import { AmountInput, ErrorNote, Field, SubmitButton, useSubmit } from "./form-primitives";
import { useOffline } from "./offline-context";
import { buildSplitPayload, SplitEditor, type SplitEditorState } from "./split-editor";
import { TransactionDetailSheet } from "./transaction-detail";
import { useUI, type ModalPrefill } from "./ui-context";

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
};

export function Modals() {
  const { modal, closeModal } = useUI();
  if (!modal) return null;
  return (
    <div onClick={closeModal} className="fixed inset-0 z-[60] flex items-end md:items-center justify-center p-0 md:p-4" style={{ background: "var(--ov)" }}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full md:w-[min(460px,100%)] max-h-[92vh] md:max-h-[88vh] overflow-auto bg-card rounded-t-[18px] rounded-b-none md:rounded-2xl p-[22px] box-border flex flex-col gap-[13px]"
        style={{ boxShadow: "var(--shLg)", animation: "rise .22s ease", paddingBottom: "calc(22px + env(safe-area-inset-bottom))" }}
      >
        <div className="flex justify-between items-center">
          <div className="text-base font-extrabold tracking-tight">{TITLES[modal.type]}</div>
          <button onClick={closeModal} aria-label="Close" className="w-7 h-7 rounded-lg grid place-items-center text-mut cursor-pointer bg-transparent border-none hover:bg-accsoft">
            ✕
          </button>
        </div>
        {modal.type === "exp" && <ExpenseForm prefill={modal.prefill} />}
        {modal.type === "inc" && <IncomeForm />}
        {modal.type === "tr" && <TransferForm />}
        {modal.type === "settle" && <SettleForm prefill={modal.prefill} />}
        {modal.type === "budget" && <BudgetForm />}
        {modal.type === "account" && <AccountForm />}
        {modal.type === "bill" && <BillForm />}
        {modal.type === "friend" && <FriendForm />}
        {modal.type === "group" && <GroupForm />}
        {modal.type === "txDetail" && modal.prefill?.transactionId && <TransactionDetailSheet transactionId={modal.prefill.transactionId} />}
      </div>
    </div>
  );
}

// ─────────── Expense (with split) ───────────

function ExpenseForm({ prefill }: { prefill?: ModalPrefill }) {
  const { refData } = useUI();
  const { createViaOutbox } = useOffline();
  const { run, busy, error } = useSubmit();
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState(refData.accounts[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState(
    () => (refData.expenseCategories.find((c) => c.name === "Food") ?? refData.expenseCategories[0])?.id ?? ""
  );
  const [merchant, setMerchant] = useState("");
  const [date, setDate] = useState(todayYMD());
  const [notes, setNotes] = useState("");
  const [split, setSplit] = useState(!!prefill?.split);
  const [mode, setMode] = useState<"EQUAL" | "EXACT" | "PERCENT" | "RATIO">("EQUAL");
  const [parts, setParts] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(refData.participants.slice(0, 2).map((p) => [p.id, !!prefill?.split]))
  );
  const [exact, setExact] = useState<Record<string, string>>({});
  const [weights, setWeights] = useState<Record<string, string>>({});

  const splitState: SplitEditorState = { split, setSplit, mode, setMode, parts, setParts, exact, setExact, weights, setWeights };
  const selected = refData.participants.filter((p) => parts[p.id]);
  const amtPaise = Math.round((Number(amount) || 0) * 100);

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
              };
              // Phase 1 queues solo creates only (spec §17); a split touches
              // friends' balances and needs the server's validation
              if (split) {
                if (typeof navigator !== "undefined" && !navigator.onLine) {
                  return Promise.resolve({ ok: false as const, error: "Split expenses need internet — try again when you're back online." });
                }
                return addExpenseAction(payload);
              }
              return createViaOutbox("expense.create", payload);
            },
            (r) => (r.queued ? "Saved — will sync when you're back online" : split ? "Split expense added" : "Expense added")
          )
        }
      >
        Add expense
      </SubmitButton>
    </div>
  );
}

// ─────────── Income ───────────

function IncomeForm() {
  const { refData } = useUI();
  const { createViaOutbox } = useOffline();
  const { run, busy, error } = useSubmit();
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState(refData.accounts[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState(
    () => (refData.incomeCategories.find((c) => c.name === "Salary") ?? refData.incomeCategories[0])?.id ?? ""
  );
  const [merchant, setMerchant] = useState("");
  const [date, setDate] = useState(todayYMD());
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
      <ErrorNote error={error} />
      <SubmitButton
        busy={busy}
        color="var(--green)"
        onClick={() =>
          run(
            () => createViaOutbox("income.create", { amount, accountId, categoryId: categoryId || null, merchant, date }),
            (r) => (r.queued ? "Saved — will sync when you're back online" : "Income added")
          )
        }
      >
        Add income
      </SubmitButton>
    </div>
  );
}

// ─────────── Transfer ───────────

function TransferForm() {
  const { refData } = useUI();
  const { createViaOutbox } = useOffline();
  const { run, busy, error } = useSubmit();
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState(refData.accounts[0]?.id ?? "");
  const [to, setTo] = useState(refData.accounts[1]?.id ?? refData.accounts[0]?.id ?? "");
  const [date, setDate] = useState(todayYMD());
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
      <ErrorNote error={error} />
      <SubmitButton
        busy={busy}
        onClick={() =>
          run(
            () => createViaOutbox("transfer.create", { amount, fromAccountId: from, toAccountId: to, date }),
            (r) => (r.queued ? "Saved — will sync when you're back online" : "Transfer recorded")
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
      <ErrorNote error={error} />
      <SubmitButton busy={busy} onClick={() => run(() => createAccountAction({ name, type, openingBalance: opening || 0 }), "Account added")}>
        Add account
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
          <input className="field" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
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
