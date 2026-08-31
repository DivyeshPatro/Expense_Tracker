"use client";

// The full-screen Lending entry experience.
//
// Same shape as the Spending composer — one big amount, a keypad, metadata
// chips, a swipe to commit — and none of its fields. Lending is its own
// domain: a loan has a counterparty, a direction, a due date and, when money
// comes back, an allocation across the loans it pays off. None of that is a
// transaction, and a transaction's category, group and split mean nothing here.
//
// So this is NOT TransactionComposer with a flag. It composes the same shell
// (entry-shell.tsx) and brings Lending's own fields, and every one of those
// fields, control and rule is the classic LendingEntryForm's, moved rather
// than reinvented:
//
//   • the contact picker, including "+ New Contact" via NewContactInline;
//   • LoanAllocationPicker, unmodified, for a GOT entry's auto/custom
//     allocation across open loans;
//   • FUNDING SOURCE, with "Untracked / cash in hand" still a deliberate
//     choice rather than the default (#185);
//   • DUE DATE on a GAVE entry only, with its Clear affordance and its
//     min = the entry's own date;
//   • reason and notes.
//
// The write is byte-identical: createViaOutbox("loan.create", …) with the same
// payload the classic form built, including the display-only participantName
// the outbox uses for its label and the allocations array shaped exactly as
// before. No lending service, action, schema or allocation rule was touched —
// the server still FIFO-allocates when no allocations are sent, and still
// honours them when they are.

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useUI } from "./ui-context";
import type { ModalPrefill } from "./ui-context";
import { useOffline } from "./offline-context";
import { BottomSheet } from "./bottom-sheet";
import { DateField } from "./date-field";
import { AccountOptions } from "./account-options";
import { AmountHero, EntryKeypad, MetaChips, Segmented, SuccessWash, SwipeToConfirm } from "./entry-shell";
import { LoanAllocationPicker, NewContactInline, NEW_CONTACT } from "./modals";
import { useFocusTrap } from "./use-focus-trap";
import { amountToPaise, evaluateAmount, pressAmountKey } from "@/lib/expression";
import { friendlyDay, todayYMD } from "@/lib/dates";

type Kind = "GAVE" | "GOT";
type Picker = null | "contact" | "date" | "due" | "source" | "note" | "allocation";

export function LendingComposer({ prefill }: { prefill?: ModalPrefill } = {}) {
  const { refData, closeModal } = useUI();
  const { createViaOutbox } = useOffline();
  const router = useRouter();

  // Every initial value below is the classic form's, prefill keys included, so
  // the buttons that already pass `loanKind`, `participantId`,
  // `targetLoanEntryId` and the duplicate-from-existing `dup*` fields keep
  // working without learning a new shape.
  const [kind, setKind] = useState<Kind>(prefill?.loanKind ?? "GAVE");
  const [participantId, setParticipantId] = useState(prefill?.participantId ?? refData.participants[0]?.id ?? "");
  const [entry, setEntry] = useState(prefill?.dupAmountRupees ?? prefill?.targetLoanRemainingRupees ?? "");
  // #185: a real account by default. Defaulting to Untracked credited "owed to
  // you" while debiting nothing, so the headline went UP when money went out.
  const [accountId, setAccountId] = useState(prefill?.dupAccountId ?? refData.accounts[0]?.id ?? "");
  const [date, setDate] = useState(todayYMD());
  const [dueDate, setDueDate] = useState(prefill?.dupDueDate ?? "");
  const [reason, setReason] = useState(prefill?.dupMerchant ?? "");
  const [notes, setNotes] = useState(prefill?.dupNotes ?? "");
  // Arriving from "Record Repayment" on one loan starts targeted at that loan
  // rather than at auto — the classic form's rule, unchanged.
  const [allocationMode, setAllocationMode] = useState<"auto" | "custom">(prefill?.targetLoanEntryId ? "custom" : "auto");
  const [allocationAmounts, setAllocationAmounts] = useState<Record<string, string>>(() =>
    prefill?.targetLoanEntryId ? { [prefill.targetLoanEntryId]: prefill.targetLoanRemainingRupees ?? "" } : {}
  );
  // refData is loaded once at layout mount and a server action's
  // revalidatePath does not refresh it in the same client session, so a contact
  // created here is tracked locally and merged into the options.
  const [justCreated, setJustCreated] = useState<{ id: string; name: string }[]>([]);
  const [picker, setPicker] = useState<Picker>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Escape-to-close comes from app-shell's global handler, which this screen
  // shares with every sheet. The trap is the half that has to live here: this
  // covers the app but is not a dialog, so nothing else stops Tab walking out
  // onto the sidebar behind it.
  useFocusTrap(rootRef, true);
  useEffect(() => {
    const el = rootRef.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const submitting = useRef(false);

  const allParticipants = [...refData.participants, ...justCreated];
  const contact = allParticipants.find((p) => p.id === participantId);
  const account = refData.accounts.find((a) => a.id === accountId);
  const paise = amountToPaise(entry || "0");

  useEffect(() => setError(null), [entry, kind, participantId, accountId]);
  // A due date belongs to money going out. Dropping it on the way to GOT keeps
  // the payload the same shape the classic form sent.
  useEffect(() => {
    if (kind === "GOT" && dueDate) setDueDate("");
  }, [kind, dueDate]);

  const press = (key: string) => setEntry((cur) => pressAmountKey(cur, key));

  function validate(): string | null {
    const amount = evaluateAmount(entry);
    if (!amount.ok) return entry.trim() ? amount.error : "Enter an amount first";
    if (!participantId) return "Choose who this is with";
    return null;
  }

  async function commit() {
    if (submitting.current) return false;
    const problem = validate();
    if (problem) {
      setError(problem);
      return false;
    }
    submitting.current = true;
    // The classic form's payload, field for field.
    const res = await createViaOutbox("loan.create", {
      participantId,
      kind,
      amount: entry,
      accountId: accountId || null,
      reason: reason || undefined,
      notes: notes || undefined,
      date,
      dueDate: kind === "GAVE" && dueDate ? dueDate : null,
      participantName: contact?.name ?? "", // display-only, for intentLabel
      allocations:
        kind === "GOT" && allocationMode === "custom"
          ? Object.entries(allocationAmounts)
              .filter(([, v]) => Number(v) > 0)
              .map(([gaveEntryId, v]) => ({ gaveEntryId, amount: v }))
          : undefined,
    });
    if (!res.ok) {
      submitting.current = false;
      setError(res.error ?? "Couldn't save that — try again");
      return false;
    }
    setDone(true);
    if (!("queued" in res && res.queued)) router.refresh();
    window.setTimeout(closeModal, 900);
    return true;
  }

  if (done) return <SuccessWash label={kind === "GAVE" ? "Loan recorded" : "Repayment recorded"} />;

  const allocationLabel =
    allocationMode === "custom"
      ? `Custom · ${Object.values(allocationAmounts).filter((v) => Number(v) > 0).length} loan(s)`
      : "Automatic";

  const chips = [
    { key: "date", icon: "🗓", what: "Date", label: date === todayYMD() ? "Today" : friendlyDay(date), unset: false },
    { key: "source", icon: "💳", what: "Funding source", label: account?.name ?? "Untracked", unset: !account },
    ...(kind === "GAVE"
      ? [{ key: "due", icon: "⏰", what: "Due date", label: dueDate ? friendlyDay(dueDate) : "Due date", unset: !dueDate }]
      : [{ key: "allocation", icon: "🧮", what: "Allocation", label: allocationLabel, unset: false }]),
  ];

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      aria-label="New lending entry"
      className="fixed inset-0 z-[70] bg-bg flex flex-col outline-none"
      style={{ animation: "composerIn .22s ease" }}
    >
      <style>{`
        @keyframes composerIn { from { opacity: 0; transform: translateY(14px) } to { opacity: 1; transform: none } }
        @keyframes washIn { from { opacity: 0 } to { opacity: 1 } }
        @media (prefers-reduced-motion: reduce) { [data-composer], [data-wash] { animation: none !important } }
      `}</style>

      <div data-composer data-lending className="flex flex-col h-full max-w-[520px] w-full mx-auto px-5 pt-3 pb-4 gap-3 overflow-hidden">
        <div className="flex items-center gap-2 flex-none">
          <button
            onClick={closeModal}
            aria-label="Close"
            className="w-11 h-11 -ml-2 rounded-full grid place-items-center text-mut bg-transparent border-none cursor-pointer hover:bg-accsoft hover:text-ink text-[17px]"
          >
            ✕
          </button>
          <div className="flex-1 flex justify-center">
            <Segmented
              label="Gave or got"
              options={[
                { value: "GAVE", label: "You gave", glyph: "↗" },
                { value: "GOT", label: "You got", glyph: "↙" },
              ]}
              value={kind}
              onChange={(v) => setKind(v as Kind)}
              tint={kind === "GAVE" ? "var(--acc)" : "var(--green)"}
            />
          </div>
          <span className="w-11" aria-hidden />
        </div>

        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-1">
          <AmountHero
            entry={entry}
            sign={kind === "GAVE" ? "−" : "+"}
            tint={kind === "GAVE" ? "var(--acc)" : "var(--green)"}
          />
          <button
            onClick={() => setPicker("contact")}
            aria-label={contact ? `Contact: ${contact.name}` : "Choose a contact"}
            className="bg-transparent border-none cursor-pointer text-[13px] text-mut2 hover:text-ink min-h-[44px] px-3"
          >
            {contact ? `${kind === "GAVE" ? "To" : "From"} ${contact.name}` : "Who is this with?"}
          </button>
          <button
            onClick={() => setPicker("note")}
            aria-label="Reason and notes"
            className="bg-transparent border-none cursor-pointer text-[12.5px] text-mut2 hover:text-ink min-h-[36px] px-3"
          >
            {reason || notes ? [reason, notes].filter(Boolean).join(" · ") : "What was it for?"}
          </button>
          {error && (
            <div role="alert" className="text-[12.5px] font-semibold px-3 py-1.5 rounded-lg" style={{ background: "var(--redSoft)", color: "var(--red)" }}>
              {error}
            </div>
          )}
        </div>

        <MetaChips chips={chips} onPick={(k) => setPicker(k as Picker)} />
        <EntryKeypad press={press} />
        <SwipeToConfirm onComplete={commit} label={kind === "GAVE" ? "Swipe to record you gave" : "Swipe to record you got"} />
      </div>

      {picker && (
        <LendingSheet
          picker={picker}
          close={() => setPicker(null)}
          kind={kind}
          participantId={participantId}
          setParticipantId={setParticipantId}
          allParticipants={allParticipants}
          onCreatedContact={(p) => {
            setJustCreated((list) => [...list, p]);
            setParticipantId(p.id);
          }}
          accounts={refData.accounts}
          accountId={accountId}
          setAccountId={setAccountId}
          date={date}
          setDate={setDate}
          dueDate={dueDate}
          setDueDate={setDueDate}
          reason={reason}
          setReason={setReason}
          notes={notes}
          setNotes={setNotes}
          entry={entry}
          allocationMode={allocationMode}
          setAllocationMode={setAllocationMode}
          allocationAmounts={allocationAmounts}
          setAllocationAmounts={setAllocationAmounts}
          paise={paise}
        />
      )}
    </div>
  );
}

/** One sheet per chip, the shape the app already uses everywhere else. */
function LendingSheet(p: {
  picker: Exclude<Picker, null>;
  close: () => void;
  kind: Kind;
  participantId: string;
  setParticipantId: (id: string) => void;
  allParticipants: { id: string; name: string }[];
  onCreatedContact: (c: { id: string; name: string }) => void;
  /** Passed straight to AccountOptions, so it takes that component's shape. */
  accounts: React.ComponentProps<typeof AccountOptions>["accounts"];
  accountId: string;
  setAccountId: (id: string) => void;
  date: string;
  setDate: (d: string) => void;
  dueDate: string;
  setDueDate: (d: string) => void;
  reason: string;
  setReason: (v: string) => void;
  notes: string;
  setNotes: (v: string) => void;
  entry: string;
  allocationMode: "auto" | "custom";
  setAllocationMode: (m: "auto" | "custom") => void;
  allocationAmounts: Record<string, string>;
  setAllocationAmounts: (fn: (prev: Record<string, string>) => Record<string, string>) => void;
  paise: number;
}) {
  const title = {
    contact: "Contact",
    date: "Date",
    due: "Due date",
    source: "Funding source",
    note: "What was it for?",
    allocation: "Allocation",
  }[p.picker];

  return (
    <BottomSheet onClose={p.close} label={title} z={90}>
      {p.picker === "contact" && (
        <>
          {p.participantId === NEW_CONTACT ? (
            <NewContactInline
              existingContacts={p.allParticipants}
              onCreated={(c) => {
                p.onCreatedContact(c);
                p.close();
              }}
              onCancel={() => p.setParticipantId(p.allParticipants[0]?.id ?? "")}
            />
          ) : (
            <>
              {p.allParticipants.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    p.setParticipantId(c.id);
                    p.close();
                  }}
                  className="flex items-center gap-2 px-3 min-h-[44px] rounded-[10px] text-left text-[13px] font-semibold bg-transparent border-none cursor-pointer text-ink hover:bg-accsoft w-full"
                  style={p.participantId === c.id ? { background: "var(--accSoft)", color: "var(--acc)" } : undefined}
                >
                  {c.name}
                </button>
              ))}
              <button
                onClick={() => p.setParticipantId(NEW_CONTACT)}
                className="flex items-center gap-2 px-3 min-h-[44px] rounded-[10px] text-left text-[13px] font-bold bg-transparent border-none cursor-pointer text-acc hover:bg-accsoft w-full"
              >
                + New contact
              </button>
            </>
          )}
        </>
      )}

      {p.picker === "date" && (
        <div className="px-1 py-1 flex flex-col gap-2">
          <DateField value={p.date} onChange={p.setDate} />
          <button onClick={p.close} className="btn-primary min-h-[44px] text-[13px] font-bold cursor-pointer">Done</button>
        </div>
      )}

      {p.picker === "due" && (
        <div className="px-1 py-1 flex flex-col gap-2">
          {/* GAVE only, min = the entry's own date, and clearable — the
              classic form's rules. */}
          <DateField value={p.dueDate} onChange={p.setDueDate} min={p.date} />
          <div className="flex gap-2">
            {p.dueDate && (
              <button
                onClick={() => p.setDueDate("")}
                className="flex-1 min-h-[44px] rounded-[10px] text-[13px] font-semibold cursor-pointer border border-line2 bg-card text-mut2"
              >
                Clear
              </button>
            )}
            <button onClick={p.close} className="btn-primary flex-[2] min-h-[44px] text-[13px] font-bold cursor-pointer">Done</button>
          </div>
        </div>
      )}

      {p.picker === "source" && (
        <>
          <select
            className="field"
            aria-label="Funding source"
            value={p.accountId}
            onChange={(e) => {
              p.setAccountId(e.target.value);
              p.close();
            }}
          >
            <AccountOptions accounts={p.accounts} />
            <option value="">Untracked / cash in hand</option>
          </select>
        </>
      )}

      {p.picker === "allocation" && (
        <div className="px-1 py-1 flex flex-col gap-2">
          {/* The classic form's own picker, unmodified: it loads the contact's
              open loans and owns auto vs custom. Nothing here recomputes an
              allocation — "auto" sends none and the server FIFO-allocates. */}
          <LoanAllocationPicker
            participantId={p.participantId}
            mode={p.allocationMode}
            setMode={p.setAllocationMode}
            amounts={p.allocationAmounts}
            setAmounts={p.setAllocationAmounts}
            repaymentAmountRupees={String(p.paise / 100)}
          />
          <button onClick={p.close} className="btn-primary min-h-[44px] text-[13px] font-bold cursor-pointer">Done</button>
        </div>
      )}

      {p.picker === "note" && (
        <div className="px-1 py-1 flex flex-col gap-3">
          <label className="block">
            <div className="label-caps">REASON</div>
            <input className="field" value={p.reason} onChange={(e) => p.setReason(e.target.value)} placeholder="e.g. Dinner, rent help" />
          </label>
          <label className="block">
            <div className="label-caps">NOTES</div>
            <input className="field" value={p.notes} onChange={(e) => p.setNotes(e.target.value)} placeholder="Optional" />
          </label>
          <button onClick={p.close} className="btn-primary min-h-[44px] text-[13px] font-bold cursor-pointer">Done</button>
        </div>
      )}
    </BottomSheet>
  );
}
