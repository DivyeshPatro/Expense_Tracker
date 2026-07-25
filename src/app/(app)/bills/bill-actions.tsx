"use client";

// Edit / delete for a bill, plus the settled one-off list.
//
// The delete confirmation is the important part: a bill is a reminder, its
// payment is financial history, and users reasonably fear that removing one
// removes the other. When a payment exists the dialog says explicitly that it
// stays.

import { useRouter } from "next/navigation";
import { useState } from "react";
import { deleteBillAction, updateBillAction } from "@/app/actions";
import { DateField } from "@/components/shell/date-field";
import { AmountInput, ErrorNote, Field } from "@/components/shell/form-primitives";
import { useUI } from "@/components/shell/ui-context";
import { formatPaise } from "@/lib/money";
import type { BillView, PaidBillView } from "@/server/services/bills";

const CADENCES = [
  { value: "", label: "One-off" },
  { value: "DAILY", label: "Daily" },
  { value: "WEEKLY", label: "Weekly" },
  { value: "MONTHLY", label: "Monthly" },
  { value: "QUARTERLY", label: "Quarterly" },
  { value: "YEARLY", label: "Yearly" },
] as const;

function useBillAction() {
  const { showToast } = useUI();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, fallback: string) {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    showToast(res.ok ? res.message ?? fallback : res.error ?? "Something went wrong");
    if (res.ok) router.refresh();
    return res.ok;
  }
  return { busy, run };
}

export function BillActions({ bill }: { bill: BillView }) {
  const [mode, setMode] = useState<"idle" | "edit" | "confirm">("idle");

  if (mode === "edit") return <EditBillForm bill={bill} onDone={() => setMode("idle")} />;
  if (mode === "confirm") return <ConfirmDelete bill={bill} onDone={() => setMode("idle")} />;

  return (
    <div className="flex items-center gap-2 flex-none">
      <TinyButton onClick={() => setMode("edit")}>Edit</TinyButton>
      <TinyButton onClick={() => setMode("confirm")}>Delete</TinyButton>
    </div>
  );
}

function ConfirmDelete({ bill, onDone }: { bill: BillView; onDone: () => void }) {
  const { busy, run } = useBillAction();
  return (
    <div className="flex items-center gap-2 flex-none flex-wrap justify-end">
      <span className="text-[11.5px] text-mut2 max-w-[300px]">
        {bill.hasPayment
          ? "Delete this reminder? The payment you already recorded stays in your transactions."
          : "Delete this bill?"}
      </span>
      <TinyButton
        tone="danger"
        disabled={busy}
        onClick={async () => {
          if (await run(() => deleteBillAction(bill.id), "Bill deleted")) onDone();
        }}
      >
        Delete
      </TinyButton>
      <TinyButton onClick={onDone}>Keep</TinyButton>
    </div>
  );
}

function EditBillForm({ bill, onDone }: { bill: BillView; onDone: () => void }) {
  const { refData } = useUI();
  const { busy, run } = useBillAction();
  const [name, setName] = useState(bill.name);
  const [amount, setAmount] = useState(String(bill.amount / 100));
  const [categoryId, setCategoryId] = useState(bill.categoryId ?? "");
  const [dueDate, setDueDate] = useState(bill.dueYMD);
  const [cadence, setCadence] = useState<string>(bill.cadenceValue ?? "");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3 w-full py-2">
      {bill.hasPayment && (
        <div className="text-[11.5px] text-mut2">
          Changes apply from here on — payments already recorded aren&apos;t altered.
        </div>
      )}
      <div className="flex gap-2.5 flex-wrap">
        <Field label="NAME">
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="AMOUNT (₹)">
          <AmountInput value={amount} onChange={setAmount} />
        </Field>
      </div>
      <div className="flex gap-2.5 flex-wrap">
        <Field label="CATEGORY">
          <select className="field" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Uncategorized</option>
            {refData.expenseCategories.map((c) => (
              <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
            ))}
          </select>
        </Field>
        <Field label="DUE DATE">
          <DateField value={dueDate} onChange={setDueDate} />
        </Field>
        <Field label="REPEATS">
          <select className="field" value={cadence} onChange={(e) => setCadence(e.target.value)}>
            {CADENCES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </Field>
      </div>
      <ErrorNote error={error} />
      <div className="flex gap-2">
        <button
          disabled={busy}
          className="btn-primary disabled:opacity-60"
          onClick={async () => {
            setError(null);
            const ok = await run(
              () =>
                updateBillAction({
                  id: bill.id,
                  name,
                  amount,
                  categoryId: categoryId || null,
                  dueDate,
                  cadence: cadence || null,
                }),
              "Bill updated"
            );
            if (ok) onDone();
          }}
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
        <button onClick={onDone} className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold cursor-pointer">
          Cancel
        </button>
      </div>
    </div>
  );
}

export function PaidBills({ bills }: { bills: PaidBillView[] }) {
  const [open, setOpen] = useState(false);
  if (bills.length === 0) return null;

  return (
    <div className="card p-[var(--pad)]">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex justify-between items-center w-full bg-transparent border-none p-0 cursor-pointer text-left"
      >
        <h2 className="text-[13.5px] font-bold m-0">Settled bills</h2>
        <span className="text-[11.5px] text-mut2 font-semibold">
          {bills.length} paid {open ? "▲" : "▼"}
        </span>
      </button>
      {open && (
        <div className="mt-3 flex flex-col gap-1">
          <div className="text-[11.5px] text-mut2 mb-1">
            One-off bills you&apos;ve already paid. Deleting one removes the reminder only — the payment stays in your
            transactions.
          </div>
          {bills.map((b) => (
            <PaidRow key={b.id} bill={b} />
          ))}
        </div>
      )}
    </div>
  );
}

function PaidRow({ bill }: { bill: PaidBillView }) {
  const { busy, run } = useBillAction();
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex items-center gap-3 py-2 border-b border-line last:border-b-0 text-[12.5px]">
      <div className="flex-1 min-w-0">
        <div className="font-semibold truncate">{bill.name}</div>
        <div className="text-mut2">
          {formatPaise(bill.amount)}
          {bill.paidYMD ? ` · paid ${bill.paidYMD}` : ""}
        </div>
      </div>
      {confirming ? (
        <div className="flex items-center gap-2 flex-none">
          <span className="text-[11.5px] text-mut2">Payment stays in your transactions.</span>
          <TinyButton tone="danger" disabled={busy} onClick={() => run(() => deleteBillAction(bill.id), "Bill deleted")}>
            Delete
          </TinyButton>
          <TinyButton onClick={() => setConfirming(false)}>Keep</TinyButton>
        </div>
      ) : (
        <TinyButton onClick={() => setConfirming(true)}>Delete</TinyButton>
      )}
    </div>
  );
}

function TinyButton({
  children,
  onClick,
  disabled,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "danger";
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        tone === "danger"
          ? "px-2.5 py-1.5 rounded-lg border-none bg-red text-white text-[11px] font-semibold cursor-pointer disabled:opacity-60"
          : "px-2.5 py-1.5 rounded-lg border border-line2 text-[11px] font-semibold text-acc cursor-pointer bg-transparent hover:bg-accsoft disabled:opacity-60"
      }
    >
      {children}
    </button>
  );
}
