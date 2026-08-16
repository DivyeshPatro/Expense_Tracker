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
import { amountToPaise } from "@/lib/expression";
import { findDuplicateContacts } from "@/lib/duplicate-contact";
import { inferGroupForMembers, needsExplicitGroupChoice, type GroupInference } from "@/lib/group-inference";
import { formatPaise } from "@/lib/money";
import { ensureDeviceId, getDeviceName } from "@/lib/offline/db";
import type { OpenLoanRow } from "@/server/services/lending";
import { AccountOptions } from "./account-options";
import { DateField } from "./date-field";
import { createRuleFor, RepeatBlock, useRepeat } from "./repeat-block";
import { AdvancedFields, AmountInput, ErrorNote, Field, SubmitButton, useSubmit } from "./form-primitives";
import { MerchantInput } from "./merchant-input";
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
  // Did this gesture start on the backdrop? See the overlay's onClick.
  const backdropDown = useRef(false);
  const { inset, height } = useKeyboardInset();
  useFocusTrap(panelRef, !!modal);
  // #196: this used to be `panelRef.current?.focus()`, which ran after mount
  // and stole focus back from the amount field's autoFocus — measured in
  // production as `amountFocused: false, activeElement: DIV`. The keyboard
  // never opened, so the advertised two-tap flow really cost three.
  //
  // Focus the first real control instead, falling back to the panel only when
  // a sheet has none (e.g. a read-only detail view), so the trap keeps an
  // anchor either way.
  useEffect(() => {
    if (!modal) return;
    const panel = panelRef.current;
    if (!panel) return;
    // rAF so the element exists and the sheet's entrance has begun; iOS will
    // not raise the keyboard for a focus() that happens before paint.
    const id = requestAnimationFrame(() => {
      const first = panel.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])'
      );
      (first ?? panel).focus({ preventScroll: true });
      if (first instanceof HTMLInputElement) first.select();
    });
    return () => cancelAnimationFrame(id);
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
      // Close only when the gesture BEGAN on the backdrop as well as ending
      // there. A bare onClick closes on any click that happens to land on the
      // backdrop — including one that started on a control inside the sheet and
      // ended on the backdrop because the layout moved underneath the finger.
      //
      // That was not hypothetical: tapping Merchant blurred the amount field,
      // which unmounted the keypad, which removed --keypad-h, which dropped the
      // sheet ~293px mid-gesture. The tap landed on backdrop and closed the
      // whole form, stranding the merchant datalist on screen. The same class
      // of bug bites text selection dragged from inside a dialog to outside it.
      onPointerDown={(e) => {
        backdropDown.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && backdropDown.current) closeModal();
        backdropDown.current = false;
      }}
      className="fixed inset-0 z-[60] flex items-end md:items-center justify-center p-0 md:p-4"
      // The OS keyboard shrinks visualViewport, so `inset` covers it. Ledgerly's
      // own keypad doesn't — it publishes its height instead, and the sheet
      // reserves that space so Save is never underneath it.
      style={{
        background: "var(--ov)",
        paddingBottom: inset > 0 ? inset : "var(--keypad-h, 0px)",
      }}
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
        style={{
          boxShadow: "var(--shLg)",
          animation: "rise .22s ease",
          maxHeight: inset > 0 && height ? `${height - 12}px` : "calc(92dvh - var(--keypad-h, 0px))",
        }}
      >
        <div className="flex justify-between items-center flex-none px-[22px] pt-[18px] pb-2">
          <div className="text-base font-extrabold tracking-tight">{TITLES[modal.type]}</div>
          <button onClick={closeModal} aria-label="Close" className="w-11 h-11 -mr-2 rounded-lg grid place-items-center text-mut cursor-pointer bg-transparent border-none hover:bg-accsoft">
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

// ─────────── Group field (shared by Add and Edit expense) ───────────

/** The GROUP selector as it appears for a shared expense: always visible, never
 *  silently defaulted, and explicit about which of the three states it is in —
 *  auto-filled from the people picked, awaiting an answer because the people
 *  imply more than one group, or plainly personal. */
function GroupField({
  groupId,
  groups,
  onSelect,
  inference,
  mustChoose,
  autoApplied,
}: {
  groupId: string;
  groups: { id: string; name: string }[];
  onSelect: (id: string) => void;
  inference: GroupInference;
  mustChoose: boolean;
  autoApplied: boolean;
}) {
  const chosen = groups.find((g) => g.id === groupId);
  return (
    <Field label="GROUP">
      <select
        className="field"
        aria-label="Group"
        aria-invalid={mustChoose || undefined}
        value={groupId}
        onChange={(e) => onSelect(e.target.value)}
        style={mustChoose ? { borderColor: "var(--amber)" } : undefined}
      >
        <option value="">Personal (not in a group)</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>🏠 {g.name}</option>
        ))}
      </select>
      {mustChoose && (
        <div className="text-[11.5px] font-semibold mt-1.5 rounded-lg px-2.5 py-2" style={{ color: "var(--amber)", background: "var(--amberSoft, var(--accSoft))" }}>
          These people are in{" "}
          {inference.kind === "ambiguous" ? inference.candidates.map((c) => c.name).join(" and ") : "more than one group"} — pick which
          one this expense belongs to, or choose Personal.
        </div>
      )}
      {!mustChoose && autoApplied && chosen && (
        <div className="text-[11.5px] font-semibold text-mut mt-1.5">
          Added to <span className="text-acc">{chosen.name}</span> because everyone you picked is in it. Change it above if that&apos;s wrong.
        </div>
      )}
    </Field>
  );
}

// ─────────── Expense (with split) ───────────

function ExpenseForm({ prefill }: { prefill?: ModalPrefill }) {
  const { refData } = useUI();
  // #69 used to hide Lending-only contacts (imported khatas) from this picker.
  // v2.1 reverses that: it was the direct cause of a duplicate person. An
  // imported contact was unreachable here, so the owner created a second
  // record under the same name and the one human accumulated two separate
  // balances. A Lending contact is a real person you can genuinely split with;
  // they are now listed, marked with a "Lending" badge (same treatment the
  // group member picker already gave them) rather than withheld.
  const sharedParticipants = refData.participants;
  const { createViaOutbox } = useOffline();
  const { run, busy, error } = useSubmit();
  const [amount, setAmount] = useState(prefill?.dupAmountRupees ?? "");
  const [accountId, setAccountId] = useState(prefill?.dupAccountId ?? refData.accounts[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState(
    () => prefill?.dupCategoryId ?? (refData.expenseCategories.find((c) => c.name === "Food") ?? refData.expenseCategories[0])?.id ?? ""
  );
  const [merchant, setMerchant] = useState(prefill?.dupMerchant ?? "");
  // Merchant recall may set the account, but only until the user picks one
  // themselves — after that their choice stands for the rest of the form.
  // A ref, not state: it must not cause a re-render, and the recall callback
  // needs the current value rather than a closed-over one.
  const touchedAccount = useRef(!!prefill?.dupAccountId);
  const touchedCategory = useRef(!!prefill?.dupCategoryId);
  const [date, setDate] = useState(todayYMD());
  const [notes, setNotes] = useState(prefill?.dupNotes ?? "");
  const [groupId, setGroupId] = useState(prefill?.dupGroupId ?? ""); // "" = personal — collaboration-architecture-rfc §2/§4 (migration step 4)
  // v2.1: has the user answered the group question themselves? Set by picking
  // anything in the GROUP select (including "Personal"), and pre-set when the
  // caller already decided — the group-first Add Expense button, or duplicating
  // a row that had a group. Until then, inference is free to fill it in; after,
  // a deliberate choice is never overridden by a guess.
  const groupTouched = useRef(!!prefill?.dupGroupId);
  const [split, setSplit] = useState(!!prefill?.split);
  const [mode, setMode] = useState<"EQUAL" | "EXACT" | "PERCENT" | "RATIO">("EQUAL");
  const [parts, setParts] = useState<Record<string, boolean>>(() => {
    // #66 group-first, completed in v2.1. Picking a group IN the form calls
    // selectGroup(), which pre-selects that group's members — but arriving with
    // the group already chosen (the group page's "Add expense" button, or
    // duplicating a group expense) skipped that entirely and fell through to
    // "the first two contacts alphabetically". A group expense would then split
    // with whoever happened to sort first unless the user noticed and fixed it
    // by hand. Same roster either way now.
    const g = prefill?.dupGroupId ? refData.groups.find((gr) => gr.id === prefill.dupGroupId) : undefined;
    if (g) {
      const memberIds = g.memberIds.filter((mid) => sharedParticipants.some((p) => p.id === mid));
      if (memberIds.length) return Object.fromEntries(memberIds.map((mid) => [mid, true]));
    }
    return Object.fromEntries(sharedParticipants.slice(0, 2).map((p) => [p.id, !!prefill?.split]));
  });
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
  // shown on the Advanced summary so the collapsed state still says where the
  // money is coming from — the one hidden field a user might actually check
  const accountName = refData.accounts.find((a) => a.id === accountId)?.name;
  const selected = sharedParticipants.filter((p) => parts[p.id]);
  // Expression-aware, so the submitted value never depends on whether blur
  // fired before the tap on Save — see amountToPaise.
  const amtPaise = amountToPaise(amount);

  // v2.1 members -> group. A guess, so it only lands when exactly one group
  // contains everyone picked, and it never overrides a deliberate choice.
  // When the people no longer imply the inferred group we clear it rather than
  // leaving a stale tag on the row — but only if the user never chose it.
  const selectedIds = selected.map((p) => p.id);
  const inference = inferGroupForMembers(selectedIds, refData.groups);
  // Collapses the inference to a primitive so the effect runs on a real change
  // of outcome, not on every render's freshly-allocated object.
  const inferenceKey = `${split}|${inference.kind}|${inference.kind === "one" ? inference.groupId : ""}`;
  useEffect(() => {
    if (groupTouched.current || !split) return;
    const next = inference.kind === "one" ? inference.groupId : "";
    if (next === groupId) return;
    setGroupId(next);
    setCategoryId(""); // group and personal categories are separate namespaces
    // groupId is deliberately not a dependency: this reacts to the inference
    // changing, never to the value it just wrote.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inferenceKey]);

  // Several groups contain everyone picked and the user hasn't said which —
  // requirement 6: do not guess, ask. Saving is blocked until they answer,
  // because the alternative (quietly saving as Personal) is the original bug.
  const mustChooseGroup = needsExplicitGroupChoice(inference, groupTouched.current);

  function selectGroup(id: string) {
    groupTouched.current = true;
    setGroupId(id);
    // group-expenses-sprint: a category id from the wrong namespace (personal,
    // or a different group) must never silently ride along across a group switch
    setCategoryId("");
    // #66 group-first: picking a group splits among its members by default —
    // turn split on and pre-select the group's (Shared) members, which the
    // user can still adjust before saving.
    if (id) {
      const g = refData.groups.find((gr) => gr.id === id);
      const memberIds = (g?.memberIds ?? []).filter((mid) => sharedParticipants.some((p) => p.id === mid));
      if (memberIds.length) {
        setSplit(true);
        setParts(Object.fromEntries(memberIds.map((mid) => [mid, true])));
      }
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* #197: Amount, then Category. Everything else is real but secondary. */}
      <Field label="AMOUNT (₹)">
        <AmountInput value={amount} onChange={setAmount} autoFocus />
      </Field>
      {/* #197 promoted Amount and Category; MERCHANT now joins them, because it
          was the field that made the rest unnecessary and nobody could see it.
          The server already auto-categorises from MerchantRule and upserts that
          rule whenever a category is picked explicitly — but only when a
          merchant is supplied, and it was buried in "More details", so the
          self-improving path almost never ran. Typing "Swiggy" now fills the
          category and account from last time, which is the whole two-field
          entry flow: amount, merchant, save. */}
      <Field label="MERCHANT">
        <MerchantInput
          value={merchant}
          onChange={setMerchant}
          onRecognized={(s) => {
            // Only overwrite values the user hasn't chosen themselves. Note
            // this is "untouched", not "empty": category is pre-seeded to Food
            // and account to the first account, so an emptiness check would
            // never fire — which is exactly what happened the first time.
            // A standing default is a guess and should yield to recall; a
            // deliberate pick must not.
            if (s.categoryId && !groupId && !touchedCategory.current) setCategoryId(s.categoryId);
            if (s.accountId && !touchedAccount.current) setAccountId(s.accountId);
          }}
        />
      </Field>
      <Field label="CATEGORY">
        {groupId ? (
          <GroupCategorySelect
            groupId={groupId}
            value={categoryId}
            onChange={(id) => {
              touchedCategory.current = true;
              setCategoryId(id);
            }}
          />
        ) : (
          <CategoryPicker
            categories={refData.expenseCategories}
            value={categoryId}
            onChange={(id) => {
              touchedCategory.current = true;
              setCategoryId(id);
            }}
            recentKey="ledgerly-recent-cat-expense"
          />
        )}
      </Field>

      {/* v2.1 requirement 3: once this is a shared expense, GROUP is a primary
          decision and must be visible. It used to live collapsed inside
          Advanced defaulting to Personal, which is how four expenses split
          among a group's members were saved as personal and vanished from the
          group dashboard. When Split is off this stays in Advanced, so a plain
          personal expense is exactly as uncluttered as before. */}
      {split && refData.groups.length > 0 && (
        <GroupField
          groupId={groupId}
          groups={refData.groups}
          onSelect={selectGroup}
          inference={inference}
          mustChoose={mustChooseGroup}
          autoApplied={!groupTouched.current && !!groupId}
        />
      )}

      <AdvancedFields
        hint={accountName}
        // opened when the caller pre-filled something in here (duplicate, or a
        // split started from Shared) — hiding a value they set would confuse
        defaultOpen={!!(prefill?.dupMerchant || prefill?.dupNotes || prefill?.dupGroupId || prefill?.split)}
      >
        <div className="flex gap-2.5 flex-wrap">
          <Field label="ACCOUNT">
            <select
              className="field"
              value={accountId}
              onChange={(e) => {
                // Once chosen by hand, merchant recall must stop overriding it.
                touchedAccount.current = true;
                setAccountId(e.target.value);
              }}
            >
              <AccountOptions accounts={refData.accounts} />
            </select>
          </Field>
          <Field label="DATE">
            <DateField value={date} onChange={setDate} />
          </Field>
        </div>
        <Field label="NOTES">
          <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </Field>
        {/* Only when Split is off — otherwise it is rendered above, outside
            Advanced, and showing it twice would let the two disagree. */}
        {!split && refData.groups.length > 0 && (
          <Field label="GROUP">
            <select className="field" value={groupId} onChange={(e) => selectGroup(e.target.value)}>
              <option value="">Personal (not in a group)</option>
              {refData.groups.map((g) => (
                <option key={g.id} value={g.id}>🏠 {g.name}</option>
              ))}
            </select>
          </Field>
        )}

        <SplitEditor state={splitState} amtPaise={amtPaise} participants={sharedParticipants} />

        {/* A rule's template carries neither splits nor a group, so repeating is
            offered only for a plain personal expense rather than silently
            scheduling something different from what's on screen. */}
        {!split && !groupId && <RepeatBlock state={repeat} transactionYmd={date} />}
      </AdvancedFields>

      <ErrorNote error={error} />
      <SubmitButton
        busy={busy}
        // Requirement 6: an ambiguous group is asked, never guessed — and
        // requirement 4: it must not quietly fall through to Personal either,
        // so saving waits for the answer.
        disabled={mustChooseGroup}
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
                split: buildSplitPayload(splitState, selectedIds),
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
      {/* #198: same shape as Add expense — amount, then the one field that
          classifies it; the rest behind More details. */}
      <Field label="AMOUNT (₹)">
        <AmountInput value={amount} onChange={setAmount} autoFocus />
      </Field>
      <Field label="SOURCE">
        <CategoryPicker categories={refData.incomeCategories} value={categoryId} onChange={setCategoryId} recentKey="ledgerly-recent-cat-income" label="Choose a source" />
      </Field>

      <AdvancedFields
        hint={refData.accounts.find((a) => a.id === accountId)?.name}
        defaultOpen={!!(prefill?.dupMerchant || prefill?.dupGroupId)}
      >
        <div className="flex gap-2.5 flex-wrap">
          <Field label="INTO ACCOUNT">
            <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <AccountOptions accounts={refData.accounts} />
            </select>
          </Field>
          <Field label="DATE">
            <DateField value={date} onChange={setDate} />
          </Field>
        </div>
        <Field label="DESCRIPTION">
          <input className="field" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="e.g. Salary · Acme Corp" />
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
        {!groupId && <RepeatBlock state={repeat} transactionYmd={date} />}
      </AdvancedFields>
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
  // #198: no longer editable here — kept as a pass-through so duplicating a
  // transfer that belonged to a group still lands in that group.
  const groupId = prefill?.dupGroupId ?? "";
  return (
    <div className="flex flex-col gap-3">
      {/* #198: amount first here too — it was third, below two selects, so the
          keyboard could not open on open. Group is gone entirely: moving money
          between your own accounts has no group, and the field appeared for
          anyone who had ever created one. */}
      <Field label="AMOUNT (₹)">
        <AmountInput value={amount} onChange={setAmount} autoFocus />
      </Field>
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
      <AdvancedFields>
        <Field label="DATE">
          <DateField value={date} onChange={setDate} />
        </Field>
      </AdvancedFields>
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
  const [note, setNote] = useState("");
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
      {prefill?.settleNetPaise !== undefined && (
        <SettlePreview netPaise={prefill.settleNetPaise} amountRupees={amount} direction={direction} name={name} />
      )}
      <Field label="METHOD">
        <div className="flex gap-1.5">
          {(["UPI", "CASH", "BANK"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMethod(m)}
              aria-pressed={method === m}
              className="px-[15px] py-[7px] rounded-lg text-[12.5px] font-semibold cursor-pointer border-none"
              style={{ background: method === m ? "var(--acc)" : "var(--accSoft)", color: method === m ? "#fff" : "var(--acc)" }}
            >
              {m === "UPI" ? "UPI" : m === "CASH" ? "Cash" : "Bank"}
            </button>
          ))}
        </div>
      </Field>
      <Field label="NOTE (OPTIONAL)">
        <input className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. UPI ref, cash in hand" />
      </Field>
      <ErrorNote error={error} />
      <SubmitButton
        busy={busy}
        color="var(--green)"
        onClick={() => run(() => settleAction({ participantId: prefill?.participantId, direction, amount, method, note: note.trim() || undefined, groupId: prefill?.settleGroupId }), "Payment recorded")}
      >
        Record payment
      </SubmitButton>
    </div>
  );
}

/** Live before/after balance for the settle form (v2.0 P3). Recomputes as the
 * amount is typed: current balance → this payment → projected balance → status.
 * Convention matches recordSettlement: TO_OWNER (they pay you) reduces net,
 * FROM_OWNER (you pay them) raises it toward zero. */
function SettlePreview({
  netPaise,
  amountRupees,
  direction,
  name,
}: {
  netPaise: number;
  amountRupees: string;
  direction: "TO_OWNER" | "FROM_OWNER";
  name: string;
}) {
  const THRESHOLD = 100;
  const pay = Math.round((parseFloat(amountRupees) || 0) * 100);
  const projected = direction === "TO_OWNER" ? netPaise - pay : netPaise + pay;
  const label = (n: number) => {
    if (Math.abs(n) <= THRESHOLD) return { text: "All settled", tone: "var(--mut2)" };
    if (n > 0) return { text: `${name} will pay you ${formatPaise(n)}`, tone: "var(--green)" };
    return { text: `You'll pay ${name} ${formatPaise(-n)}`, tone: "var(--red)" };
  };
  const cur = label(netPaise);
  const proj = label(projected);
  const settledNow = Math.abs(projected) <= THRESHOLD;
  const overshoot = Math.sign(projected) !== 0 && Math.sign(projected) !== Math.sign(netPaise) && !settledNow;
  const Arrow = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--mut2)" strokeWidth="2.5" strokeLinecap="round" aria-hidden className="mx-auto">
      <path d="M12 5v14M6 13l6 6 6-6" />
    </svg>
  );
  return (
    <div className="rounded-[10px] border border-line2 bg-side px-3 py-2.5 flex flex-col gap-1.5" aria-live="polite">
      <Line label="Current" value={cur.text} tone={cur.tone} />
      <Arrow />
      <Line label={direction === "TO_OWNER" ? "Receive" : "Pay"} value={pay > 0 ? formatPaise(pay) : "—"} tone="var(--ink)" />
      <Arrow />
      <Line
        label={settledNow ? "Status" : "Remaining"}
        value={settledNow ? "Settled ✅" : overshoot ? `${proj.text} (overpaid)` : proj.text}
        tone={settledNow ? "var(--green)" : proj.tone}
        strong
      />
    </div>
  );
}

function Line({ label, value, tone, strong }: { label: string; value: string; tone: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11px] font-bold uppercase tracking-wide text-mut2">{label}</span>
      <span className={`text-[12.5px] ${strong ? "font-extrabold" : "font-semibold"} tabular-nums text-right`} style={{ color: tone }}>
        {value}
      </span>
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
  // #185: default to a real account, not "Untracked" — see FUNDING SOURCE below.
  const [accountId, setAccountId] = useState(prefill?.dupAccountId ?? refData.accounts[0]?.id ?? "");
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
        existingContacts={allParticipants}
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
          {/* #185: this used to default to "Untracked", so a loan credited
              "owed to you" while debiting nothing — the headline went UP when
              you gave money away. Defaulting to a real account keeps the books
              balanced; untracked cash stays available as a deliberate choice. */}
          <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <AccountOptions accounts={refData.accounts} />
            <option value="">Untracked / cash in hand</option>
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
/** v2.1: the duplicate guard for every "create a person" field.
 *
 *  Warns that the typed name already exists and offers those contacts by ID,
 *  so picking one reuses the real record instead of minting a second identity
 *  for the same human. Creating anyway stays available — two people really can
 *  share a name — but it becomes a deliberate act rather than the default.
 *  Nothing is merged, renamed or blocked here. */
function DuplicateContactWarning({
  name,
  contacts,
  onUseExisting,
}: {
  name: string;
  contacts: { id: string; name: string }[];
  onUseExisting?: (p: { id: string; name: string }) => void;
}) {
  const matches = findDuplicateContacts(name, contacts);
  if (matches.length === 0) return null;
  const exact = matches.some((m) => m.kind === "exact");
  return (
    <div className="rounded-lg px-3 py-2.5 flex flex-col gap-2" style={{ background: "var(--accSoft)" }}>
      <div className="text-[12px] font-semibold" style={{ color: "var(--acc)" }}>
        {exact ? `You already have a contact called "${matches[0].name}".` : "You already have someone with a very similar name."}{" "}
        {onUseExisting ? "Use them instead of creating a second record?" : "Check before adding a second one."}
      </div>
      {onUseExisting && (
        <div className="flex gap-1.5 flex-wrap">
          {matches.slice(0, 4).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onUseExisting({ id: m.id, name: m.name })}
              className="px-2.5 py-1.5 rounded-full text-[12px] font-semibold cursor-pointer border bg-card"
              style={{ borderColor: "var(--acc)", color: "var(--acc)" }}
            >
              Use {m.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NewContactInline({
  onCreated,
  onCancel,
  existingContacts = [],
}: {
  onCreated: (p: { id: string; name: string }) => void;
  onCancel: () => void;
  /** Every contact the user already has, for the duplicate check. */
  existingContacts?: { id: string; name: string }[];
}) {
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
      {/* Selecting an existing contact hands back that contact's real ID, so
          the caller links the person it already has instead of duplicating. */}
      <DuplicateContactWarning name={name} contacts={existingContacts} onUseExisting={onCreated} />
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
        {findDuplicateContacts(name, existingContacts).length > 0 ? "Create a separate contact anyway" : "Create & continue"}
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
  const { refData } = useUI();
  const { run, busy, error } = useSubmit();
  const [name, setName] = useState("");
  const duplicates = findDuplicateContacts(name, refData.participants);
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[12.5px] text-mut">
        Friends don&apos;t need an account — you can split with them right away, and link them to a real user later via invitation.
      </div>
      <Field label="NAME">
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rohan" autoFocus />
      </Field>
      {/* No "use this one" action here: this form's only job is creating a
          contact, and there is no caller waiting on an id. The warning alone
          is what stops a second Blake. */}
      <DuplicateContactWarning name={name} contacts={refData.participants} />
      <ErrorNote error={error} />
      <SubmitButton busy={busy} onClick={() => run(() => addParticipantAction({ displayName: name }), "Friend added")}>
        {duplicates.length > 0 ? "Add as a separate person" : "Add friend"}
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
  // #68: create a new member without leaving the group flow. As in the lending
  // form, refData isn't refreshed by a server action mid-session, so a contact
  // created here is tracked locally and merged into the member chips (and
  // auto-selected) — the group create just needs the participant id.
  const [justCreated, setJustCreated] = useState<{ id: string; name: string }[]>([]);
  const [addingMember, setAddingMember] = useState(false);

  // Offer every contact — Shared and Lending alike — since a Lending contact is
  // a real person you can intentionally add to a group (v2.0). A "Lending" badge
  // marks them; anyone created inline is merged in. If a revalidate has folded
  // the new contact into refData, drop the local copy so it isn't listed twice.
  const shared = refData.participants;
  const members = [
    ...shared,
    ...justCreated
      .filter((p) => !shared.some((s) => s.id === p.id))
      .map((p) => ({ id: p.id, name: p.name, initial: p.name.charAt(0).toUpperCase(), color: "var(--acc)", lendingOnly: false, isLending: false })),
  ];
  const selected = members.filter((p) => parts[p.id]);

  if (addingMember) {
    return (
      <NewContactInline
        existingContacts={members}
        onCreated={(p) => {
          setJustCreated((list) => [...list, p]);
          setParts((s) => ({ ...s, [p.id]: true }));
          setAddingMember(false);
        }}
        onCancel={() => setAddingMember(false)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Field label="GROUP NAME">
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Flat 402" autoFocus />
      </Field>
      <Field label="MEMBERS">
        <div className="flex gap-2 flex-wrap mt-1.5">
          {members.map((p) => {
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
                {p.isLending && (
                  <span className="text-[8.5px] font-bold uppercase tracking-wide rounded px-1 py-0.5" style={{ color: "var(--acc)", background: "var(--accSoft)" }}>
                    Lending
                  </span>
                )}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setAddingMember(true)}
            className="flex items-center gap-[6px] px-3 py-[7px] rounded-full text-[12.5px] font-semibold cursor-pointer border border-dashed"
            style={{ borderColor: "var(--line2)", color: "var(--mut)", background: "transparent" }}
          >
            <span className="text-[14px] leading-none">＋</span> New member
          </button>
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
