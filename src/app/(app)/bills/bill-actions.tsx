"use client";

// Edit / delete for a bill, plus the settled one-off list.
//
// The delete confirmation is the important part: a bill is a reminder, its
// payment is financial history, and users reasonably fear that removing one
// removes the other. When a payment exists the dialog says explicitly that it
// stays.

import { useRouter } from "next/navigation";
import { useState } from "react";
import { deleteBillAction, payBillAction, updateBillAction } from "@/app/actions";
import { BottomSheet } from "@/components/shell/bottom-sheet";
import { DateField } from "@/components/shell/date-field";
import { AmountInput, ErrorNote, Field } from "@/components/shell/form-primitives";
import { useUI } from "@/components/shell/ui-context";
import { formatPaise } from "@/lib/money";
import { soft } from "@/lib/tx-display";
import { billUrgencyBackground, billUrgencyColor } from "@/lib/urgency";
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

// ── Mobile: tappable bill cards that open an action sheet ─────────────────
// Desktop keeps the inline Mark-paid / Edit / Delete buttons (BillActions).
// On a phone those three equal-weight controls per row read like a CRUD
// table, so mobile collapses them: the row shows only what matters (icon,
// name, cadence, due, amount) and a tap opens a bottom sheet where Mark paid
// is the clear primary action and Edit / Delete sit below it.

export function MobileBills({ bills }: { bills: BillView[] }) {
  if (bills.length === 0) return null;
  return (
    <div className="md:hidden flex flex-col gap-2.5">
      {bills.map((b) => (
        <MobileBillRow key={b.id} bill={b} />
      ))}
    </div>
  );
}

function MobileBillRow({ bill }: { bill: BillView }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-3 p-3 rounded-2xl bg-card border border-line text-left w-full active:scale-[.99] transition-transform cursor-pointer"
      >
        <span className="w-[42px] h-[42px] rounded-xl grid place-items-center text-[17px] flex-none" style={{ background: soft(bill.color) }}>{bill.icon}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-[13.5px] font-bold truncate">{bill.name}</span>
          <span className="flex items-center gap-1.5 mt-1">
            <span className="text-[11px] text-mut2">{bill.cadence ? `🔁 ${bill.cadence}` : "One-off"}</span>
            <span className="px-2 py-[2px] rounded-full text-[10.5px] font-bold" style={{ background: billUrgencyBackground(bill.urgency), color: billUrgencyColor(bill.urgency) }}>{bill.dueLabel}</span>
          </span>
        </span>
        <span className="flex flex-col items-end flex-none gap-0.5">
          <span className="text-[14px] font-extrabold tabular-nums">{formatPaise(bill.amount)}</span>
          <span className="text-mut2 text-[16px] leading-none" aria-hidden>›</span>
        </span>
      </button>
      {open && <BillSheet bill={bill} close={() => setOpen(false)} />}
    </>
  );
}

function BillSheet({ bill, close }: { bill: BillView; close: () => void }) {
  const [view, setView] = useState<"actions" | "edit" | "confirm">("actions");
  const { busy, run } = useBillAction();

  return (
    <BottomSheet onClose={close} label={`${bill.name} options`}>
      {/* Header — the bill at a glance, shared across every view. */}
      <div className="flex items-center gap-3 pb-3">
        <span className="w-[44px] h-[44px] rounded-xl grid place-items-center text-[18px] flex-none" style={{ background: soft(bill.color) }}>{bill.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-bold truncate">{bill.name}</div>
          <div className="text-[11.5px] text-mut2">{bill.cadence ? `🔁 ${bill.cadence}` : "One-off"} · due {bill.dueLabel.toLowerCase()}</div>
        </div>
        <div className="text-[16px] font-extrabold tabular-nums flex-none">{formatPaise(bill.amount)}</div>
      </div>

      {view === "actions" && (
        <div className="flex flex-col gap-2">
          <button
            disabled={busy}
            onClick={async () => {
              if (await run(() => payBillAction(bill.id), `${bill.name} paid · ${formatPaise(bill.amount)}`)) close();
            }}
            className="h-12 rounded-[13px] text-[14px] font-bold text-white border-none cursor-pointer bg-acc hover:brightness-108 disabled:opacity-60 flex items-center justify-center gap-2"
          >
            {busy ? "Marking…" : "✓ Mark paid"}
          </button>
          <button onClick={() => setView("edit")} className="h-12 rounded-[13px] text-[13.5px] font-semibold cursor-pointer border border-line2 bg-card text-ink hover:bg-accsoft flex items-center justify-center gap-2">
            ✎ Edit details
          </button>
          <button onClick={() => setView("confirm")} className="h-12 rounded-[13px] text-[13.5px] font-semibold cursor-pointer border-none bg-transparent flex items-center justify-center gap-2" style={{ color: "var(--red)" }}>
            🗑 Delete bill
          </button>
        </div>
      )}

      {view === "edit" && (
        <div>
          <BackBar label="Edit bill" onBack={() => setView("actions")} />
          <EditBillForm bill={bill} onDone={close} />
        </div>
      )}

      {view === "confirm" && (
        <div>
          <BackBar label="Delete bill" onBack={() => setView("actions")} />
          <p className="text-[12.5px] text-mut px-1 pb-3">
            {bill.hasPayment
              ? "Delete this reminder? The payment you already recorded stays in your transactions."
              : "This removes the bill and its reminder. This can’t be undone."}
          </p>
          <div className="flex gap-2">
            <button onClick={() => setView("actions")} className="flex-1 h-11 rounded-[12px] text-[13.5px] font-semibold cursor-pointer border border-line2 bg-card text-ink">Keep</button>
            <button
              disabled={busy}
              onClick={async () => {
                if (await run(() => deleteBillAction(bill.id), "Bill deleted")) close();
              }}
              className="flex-1 h-11 rounded-[12px] text-[13.5px] font-bold cursor-pointer border-none bg-red text-white disabled:opacity-60"
            >
              {busy ? "Deleting…" : "Delete bill"}
            </button>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}

function BackBar({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-1.5 pb-2">
      <button onClick={onBack} aria-label="Back" className="w-8 h-8 -ml-1 rounded-lg grid place-items-center text-mut cursor-pointer bg-transparent border-none hover:bg-accsoft flex-none">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <h2 className="text-[14px] font-bold text-ink m-0">{label}</h2>
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
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} aria-label="Bill name" />
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
