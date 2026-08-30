"use client";

// The full-screen transaction composer.
//
// Replaces the Add expense / Add income modal forms as the way a transaction is
// created. The amount is the screen — everything else is a chip or a line that
// supports it — and the entry is committed by dragging a handle rather than
// pressing Save, so the last thing you do is deliberate.
//
// It owns NO business logic. Credit is the existing income path and Debit the
// existing expense path, both through createViaOutbox() exactly as the old
// forms did, so offline queueing, intents, validation, categorisation and the
// dashboard's own recalculation are all untouched. What changed is the surface.
//
// Three things about the existing model shape the layout:
//   • income REQUIRES an account and expense does not (incomeSchema's
//     accountId is min(1)), so Payment is mandatory for Credit only;
//   • categories are two separate lists, so switching type has to swap them and
//     drop a selection that no longer exists;
//   • merchant is optional and the server names a blank one "Expense"/"Income".

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useUI } from "./ui-context";
import { useOffline } from "./offline-context";
import { BottomSheet } from "./bottom-sheet";
import { MerchantInput } from "./merchant-input";
import { DateField } from "./date-field";
import {
  SplitBreakdown,
  SplitEditor,
  buildSplitPayload,
  participantsForGroup,
  splitInputProblem,
  useSplitPreview,
  type SplitEditorState,
} from "./split-editor";
import { addExpenseAction, listGroupCategoriesAction, updateExpenseAction } from "@/app/actions";
import type { TransactionDetail } from "@/server/services/transactions";
import { ensureDeviceId, getDeviceName } from "@/lib/offline/db";
import { friendlyDay, todayYMD } from "@/lib/dates";
import { amountToPaise, evaluateAmount, looksLikeExpression, partialAmount, pressAmountKey } from "@/lib/expression";
import { GRID } from "./amount-keypad";

type Kind = "INCOME" | "EXPENSE";
type Picker = null | "group" | "date" | "category" | "payment" | "note" | "split";

/**
 * The digits under the ₹, for an entry that may be an expression.
 *
 * Formatting the raw string stopped working the moment the keypad grew
 * operators — "500+250" has no integer part to group. The display now shows
 * what the entry EVALUATES to, which is also what the reader asked for: tap
 * 500 + 250 and the amount reads ₹750. The expression itself is shown on its
 * own line above, so nothing is hidden.
 *
 * A trailing decimal point is kept verbatim ("12." stays "12.") — dropping it
 * makes the point look like it was not registered.
 */
function displayDigits(raw: string): string {
  if (!raw) return "0";
  const rupees = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(partialAmount(raw) / 100);
  // A plain number keeps its trailing point while it is being typed — "12."
  // collapsing back to "12" reads as the tap not registering.
  return !looksLikeExpression(raw) && raw.endsWith(".") ? `${rupees}.` : rupees;
}

/**
 * Create and edit are the same screen.
 *
 * `edit` switches the mode: every control, the keypad, the arithmetic, the
 * split editor and the breakdown are shared, and only the persistence call at
 * the end differs. Nothing about how a transaction is written was moved or
 * reimplemented — an edit goes through exactly the calls EditExpenseForm and
 * EditIncomeForm already made.
 *
 * NOT every edit comes here. The routing lives in TransactionDetail and is
 * deliberately narrow: a non-owner's edit, a transfer, and any row with a
 * pending unsynced change all stay on the classic forms, because those depend
 * on machinery this screen does not carry (a narrower field set with the
 * account locked, transfer's two accounts, and prefilling from the queued
 * payload respectively).
 */
export function TransactionComposer({ edit, onCancel }: { edit?: TransactionDetail; onCancel?: () => void } = {}) {
  const { refData, closeModal, showToast } = useUI();
  const { createViaOutbox, enqueueMutation } = useOffline();
  const router = useRouter();
  const isEdit = !!edit;

  // Debit first and selected: most entries are money going out, so the common
  // case should need no tap. Credit is still the existing income path. An edit
  // opens on whatever the row already is, and cannot change it — the data layer
  // has no Debit↔Credit conversion (separate services, separate schemas), so
  // offering one would be inventing a mutation nothing implements.
  const [kind, setKind] = useState<Kind>(edit?.type === "INCOME" ? "INCOME" : "EXPENSE");
  const [groupId, setGroupId] = useState(edit?.groupId ?? "");
  // The amount starts as the stored figure in plain rupees, so the keypad can
  // extend it: "1000" is already a valid expression, and tapping + 250 makes
  // it "1000+250" without any special case.
  const [entry, setEntry] = useState(edit ? String(edit.amount / 100) : "");
  const [notes, setNotes] = useState(edit?.notes ?? "");
  const [merchant, setMerchant] = useState(edit?.merchant ?? "");
  const [date, setDate] = useState(edit?.ymd ?? todayYMD());
  // No category until the reader picks one. `expenseCategories` is ordered by
  // name, so seeding index 0 meant every new expense arrived pre-labelled with
  // whatever sorts first in that person's list — "Bike" on a real account,
  // "Education" on the demo one. It looked like a choice, saved like a choice,
  // and was nobody's. Both schemas take `categoryId: z.string().nullable()`,
  // and addExpense() fills a blank one from the merchant rule when it can, so
  // empty is a value the write path already understands.
  // An edit shows what is actually stored, including nothing at all.
  const [categoryId, setCategoryId] = useState(edit?.categoryId ?? "");

  // group-expenses-sprint §10: categories are namespaced — Category.userId for
  // personal, Category.groupId for a group — and a group expense is labelled
  // from the group's own list, never a member's personal one. The classic form
  // has always done this through GroupCategorySelect; this reads the same
  // action so there is one loader, not two.
  //
  // Group INCOME deliberately stays on the personal list: a group's namespace
  // is EXPENSE-only (GROUP_DEFAULT_CATEGORIES), and a Credit filed against a
  // group is a tag, exactly as it is in the classic income form.
  const [groupCategories, setGroupCategories] = useState<{ id: string; name: string; icon: string }[]>([]);
  const inGroupExpense = kind === "EXPENSE" && !!groupId;
  // Whether the list for the CURRENT scope has actually arrived. Without this,
  // editing a group expense wiped its category: the group's list is fetched, so
  // for a frame or two `categories` is empty, and the "clear what does not
  // belong" effect below would fire against a list that had simply not loaded.
  const [groupCatsFor, setGroupCatsFor] = useState<string | null>(null);
  useEffect(() => {
    if (!inGroupExpense) {
      setGroupCategories([]);
      setGroupCatsFor(null);
      return;
    }
    let cancelled = false;
    void listGroupCategoriesAction(groupId).then((cats) => {
      if (cancelled) return;
      setGroupCategories(cats.filter((c) => c.kind === "EXPENSE").map((c) => ({ id: c.id, name: c.name, icon: c.icon ?? "📦" })));
      setGroupCatsFor(groupId);
    });
    return () => {
      cancelled = true;
    };
  }, [groupId, inGroupExpense]);
  const catsReady = !inGroupExpense || groupCatsFor === groupId;

  const categories = kind === "INCOME" ? refData.incomeCategories : inGroupExpense ? groupCategories : refData.expenseCategories;

  // The classic form's split state, unchanged in shape, so SplitEditor and
  // buildSplitPayload work here exactly as they do there. Nothing about how a
  // split is computed or stored is reimplemented.
  //
  // Hydrated from the stored rows exactly as EditExpenseForm does it, including
  // the OWNER's row under "me" — dropping that is what used to hand the owner's
  // share to the payer on a save that changed nothing.
  //
  // PERCENT/RATIO keep only the resulting paise, not the weights that produced
  // them, so a split created either way reopens as EXACT with today's amounts.
  // That is the existing, deliberate behaviour: accurate, rather than guessing
  // at weights that would be wrong unless re-entered.
  const [split, setSplit] = useState((edit?.splits.length ?? 0) > 0);
  const [mode, setMode] = useState<"EQUAL" | "EXACT" | "PERCENT" | "RATIO">(
    edit && edit.splits.length > 0 ? (edit.splits[0].method === "EQUAL" ? "EQUAL" : "EXACT") : "EQUAL"
  );
  const [parts, setParts] = useState<Record<string, boolean>>(() =>
    Object.fromEntries((edit?.splits ?? []).filter((s) => s.participantId).map((s) => [s.participantId as string, true]))
  );
  const [exact, setExact] = useState<Record<string, string>>(() =>
    Object.fromEntries((edit?.splits ?? []).map((s) => [s.participantId ?? "me", String(s.owedAmount / 100)]))
  );
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [payerId, setPayerId] = useState<string | null>(edit?.paidByParticipantId ?? null);
  const [accountId, setAccountId] = useState(edit?.accountId ?? refData.accounts[0]?.id ?? "");
  const [picker, setPicker] = useState<Picker>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // Not state: the guard has to hold synchronously, because a swipe that lands
  // twice in one tick would otherwise queue the transaction twice.
  const submitting = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // An edit is opened FROM the transaction sheet, which is itself a dialog. Left
  // as a child of it, this screen would be a dialog inside a dialog: it covers
  // the sheet visually, but the sheet's own controls stay in the accessibility
  // tree and reachable by keyboard behind it. So an edit portals to the body and
  // marks every other open dialog inert while it is up — the sheet is still
  // there, untouched, when this closes.
  const [portalReady, setPortalReady] = useState(false);
  useEffect(() => setPortalReady(true), []);
  useEffect(() => {
    if (!isEdit || !portalReady) return;
    const others = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(
      (d) => !d.contains(rootRef.current) && !d.hasAttribute("inert")
    );
    others.forEach((d) => d.setAttribute("inert", ""));
    return () => others.forEach((d) => d.removeAttribute("inert"));
  }, [isEdit, portalReady]);

  const paise = amountToPaise(entry || "0");
  // While a group's list is in flight, an edit still names the category it was
  // saved with — resolved server-side on the detail, so it is correct even for
  // a namespace this reader has no copy of.
  const category =
    categories.find((c) => c.id === categoryId) ??
    (edit && categoryId && categoryId === edit.categoryId && edit.categoryName
      ? { id: edit.categoryId, name: edit.categoryName, icon: edit.categoryIcon ?? "📦" }
      : undefined);
  const account = refData.accounts.find((a) => a.id === accountId);
  const group = refData.groups.find((g) => g.id === groupId);

  const splitState: SplitEditorState = { split, setSplit, mode, setMode, parts, setParts, exact, setExact, weights, setWeights, payerId, setPayerId };
  // A group expense can only be split among that group's members — the same
  // narrowing the classic form applies, from the same helper.
  const pickerParticipants = participantsForGroup(refData.participants, groupId, refData.groups, parts);
  const selectedIds = refData.participants.filter((p) => parts[p.id]).map((p) => p.id);
  // The engine's own preview: the arithmetic here is the arithmetic that gets
  // stored, because both go through computeShares.
  const preview = useSplitPreview(paise, splitState, selectedIds);

  // Switching type — or moving between Personal and a group — swaps the
  // category list, so a selection from the other one would be silently invalid:
  // a personal category on a group expense classifies it in a namespace the
  // group cannot see, and the group's own page then reports spending under a
  // category none of its members have. Land on the new list's first entry.
  // Clears rather than re-picks: a category from the other namespace is
  // invalid, but the replacement is the reader's to choose, not ours. Landing
  // on the new list's first entry would put a category they never selected on
  // the transaction — the same bug as seeding one, arrived at sideways.
  useEffect(() => {
    if (!catsReady) return; // the group's list is still on its way
    if (categoryId && !categories.some((c) => c.id === categoryId)) setCategoryId("");
  }, [categories, categoryId, catsReady]);

  // Any edit clears a complaint about the previous attempt.
  useEffect(() => setError(null), [entry, kind, groupId, accountId, split, mode, parts]);

  // Turning a Debit into a Credit drops any split arranged under it — income
  // has no split to carry, and leaving the state armed would show a context
  // line for something that will not be saved.
  useEffect(() => {
    if (kind === "INCOME" && split) {
      setSplit(false);
      setParts({});
      setPayerId(null);
    }
  }, [kind, split]);

  // The editing rules live in lib/expression alongside the parser that reads
  // the result, so the keypad and the evaluator can never disagree about what
  // a valid amount string looks like.
  const press = useCallback((key: string) => setEntry((cur) => pressAmountKey(cur, key)), []);

  /** Everything the existing schemas require, in the shape they already take. */
  function validate(): string | null {
    // The parser's own message, not a generic one: it names division by zero,
    // an unfinished sum, a stray decimal point, a negative result and an
    // absurd figure, each of which the reader can actually act on. Every one
    // of those rules already existed — this just stops swallowing them.
    const amount = evaluateAmount(entry);
    if (!amount.ok) return entry.trim() ? amount.error : "Enter an amount first";
    // incomeSchema requires accountId; expenseSchema allows null.
    if (kind === "INCOME" && !accountId) return "Choose where the money landed";
    if (split) {
      if (selectedIds.length === 0) return "Pick who this is split with";
      // computeSplitPreview is the same engine the writer uses, so if it says
      // the shares do not add up, saving would store a split that does not.
      if (preview?.error) return preview.error;
      if (preview && !preview.balances) return "The shares don't add up to the amount yet";
      // The preview is content with a zero weight and the schema is not, so
      // this is the one rule it cannot answer for. Said here rather than as a
      // server rejection nobody can act on.
      const inputProblem = splitInputProblem(splitState, selectedIds);
      if (inputProblem) return inputProblem;
    }
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
    const shared = {
      amount: entry,
      categoryId: categoryId || null,
      merchant,
      date,
      notes: notes || undefined,
      groupId: groupId || null,
    };
    let res;
    if (edit) {
      // Exactly the calls the classic edit forms make, in the same order and
      // with the same guards — only the surface collecting the values changed.
      //
      // `amount` goes as the raw entry string on purpose: paiseFromRupees in
      // the schema resolves it through the same parser, so an expression typed
      // here is evaluated once, server-side, into the one paise representation
      // that already exists. Nothing stores the expression.
      if (kind === "INCOME") {
        res = await enqueueMutation(
          "income.update",
          edit.id,
          { amount: entry, accountId, categoryId: categoryId || null, merchant, date, notes: notes || undefined },
          edit.version
        );
      } else if (split) {
        // A split touches other participants' balances, so it needs the
        // server's validation — the same restriction creating one has.
        if (typeof navigator !== "undefined" && !navigator.onLine) {
          submitting.current = false;
          setError("Split expenses need internet — try again when you're back online.");
          return false;
        }
        const deviceId = await ensureDeviceId().catch(() => crypto.randomUUID());
        const deviceName = await getDeviceName().catch(() => undefined);
        res = await updateExpenseAction({
          id: edit.id,
          ...shared,
          accountId: accountId || null,
          split: buildSplitPayload(splitState, selectedIds),
          // baseVersion is what lets checkOverride see this edit at all.
          intent: { intentId: crypto.randomUUID(), deviceId, deviceName, clientTs: new Date().toISOString(), baseVersion: edit.version },
        });
      } else {
        // Through the outbox, which is where conflict detection, override
        // reporting and offline queueing live — so they are preserved here by
        // using the same path, not by reimplementing any of it.
        res = await enqueueMutation("expense.update", edit.id, { ...shared, accountId: accountId || null, split: buildSplitPayload(splitState, selectedIds) }, edit.version);
      }
    } else if (kind === "INCOME") {
      // incomeSchema has no split — a group credit is tagged to the group, as
      // it is in the classic income form.
      res = await createViaOutbox("income.create", { ...shared, accountId });
    } else if (split) {
      // Phase 1 queues solo creates only: a split touches other people's
      // balances and needs the server's validation, so it takes the direct
      // action with an intent — the same path and the same reason as the
      // classic form.
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        submitting.current = false;
        setError("Split expenses need internet — try again when you're back online.");
        return false;
      }
      const deviceId = await ensureDeviceId().catch(() => crypto.randomUUID());
      const deviceName = await getDeviceName().catch(() => undefined);
      res = await addExpenseAction({
        ...shared,
        accountId: accountId || null,
        split: buildSplitPayload(splitState, selectedIds),
        intent: { intentId: crypto.randomUUID(), deviceId, deviceName, clientTs: new Date().toISOString() },
      });
    } else {
      res = await createViaOutbox("expense.create", { ...shared, accountId: accountId || null });
    }
    if (!res.ok) {
      submitting.current = false;
      setError(res.error ?? "Couldn't save that — try again");
      return false;
    }
    setDone(true);
    // An edit says so in a toast the way the classic form did, rather than
    // relying on a wash that reads as "added".
    if (edit) showToast("Transaction updated");
    // Long enough to read, short enough not to be in the way. The dashboard is
    // refreshed underneath while the wash is up, so it has the new row by the
    // time it is visible again.
    //
    // A queued (offline) save changed nothing server-side yet, so refreshing
    // would fire a doomed RSC fetch — the same rule useSubmit follows.
    if (!("queued" in res && res.queued)) router.refresh();
    window.setTimeout(closeModal, 900);
    return true;
  }

  if (done) return <SuccessWash kind={kind} />;

  // `what` is the accessible name: the icon is decorative and the visible text
  // is only the value, so a screen reader would otherwise hear "Education"
  // without being told it is the category.
  // `unset` chips read as an invitation rather than a value: the label is the
  // field's own name, muted, and the accessible name says so instead of the
  // nonsense "Category: Category".
  const chips = [
    { key: "date" as const, icon: "🗓", what: "Date", label: date === todayYMD() ? "Today" : friendlyDay(date), unset: false },
    { key: "category" as const, icon: "🏷", what: "Category", label: category?.name ?? "Category", unset: !category },
    { key: "payment" as const, icon: "💳", what: "Payment method", label: account?.name ?? "Payment", unset: !account },
  ];

  const screen = (
    // Deliberately NOT role="dialog": this is a screen, the modal layer
    // already owns that role, and claiming it here would make every existing
    // `getByRole("dialog")` in the app and its suites ambiguous. The focus
    // problem an edit really has is solved by the portal and inert above.
    <div ref={rootRef} aria-label={isEdit ? "Edit transaction" : "New transaction"} className="fixed inset-0 z-[70] bg-bg flex flex-col" style={{ animation: "composerIn .22s ease" }}>
      <style>{`
        @keyframes composerIn { from { opacity: 0; transform: translateY(14px) } to { opacity: 1; transform: none } }
        @keyframes washIn { from { opacity: 0 } to { opacity: 1 } }
        @media (prefers-reduced-motion: reduce) {
          [data-composer] , [data-wash] { animation: none !important }
        }
      `}</style>

      <div data-composer className="flex flex-col h-full max-w-[520px] w-full mx-auto px-5 pt-3 pb-4 gap-3 overflow-hidden">
        {/* ── close + type ─────────────────────────────────────────────── */}
        <div className="flex items-center gap-2 flex-none">
          <button
            onClick={() => (onCancel ? onCancel() : closeModal())}
            aria-label={isEdit ? "Cancel" : "Close"}
            className="w-11 h-11 -ml-2 rounded-full grid place-items-center text-mut bg-transparent border-none cursor-pointer hover:bg-accsoft hover:text-ink text-[17px]"
          >
            ✕
          </button>
          <div className="flex-1 flex justify-center">
            <Segmented
              options={[
                { value: "EXPENSE", label: "Debit", glyph: "↗" },
                { value: "INCOME", label: "Credit", glyph: "↙" },
              ]}
              value={kind}
              // An edit cannot change the type. updateExpense and updateIncome
              // are separate services over separate schemas, with different
              // account rules and no split on the income side — there is no
              // conversion in the data layer, so offering one here would be a
              // control that either lies or corrupts.
              onChange={isEdit ? undefined : (v) => setKind(v as Kind)}
              tint={kind === "INCOME" ? "var(--green)" : "var(--red)"}
            />
          </div>
          <span className="w-11" aria-hidden />
        </div>

        {/* ── personal / group ─────────────────────────────────────────── */}
        <div className="flex justify-center flex-none">
          <Segmented
            small
            options={[
              { value: "personal", label: "Personal" },
              { value: "group", label: group ? group.name : "Group" },
            ]}
            value={groupId ? "group" : "personal"}
            onChange={(v) => {
              if (v === "personal") {
                // Back to a plain personal entry: the split comes off with the
                // group, or the row would carry members it is no longer for.
                setGroupId("");
                setSplit(false);
                setParts({});
                setPayerId(null);
              } else setPicker("group");
            }}
          />
        </div>

        {/* ── the amount, and who it's for ─────────────────────────────── */}
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-1">
          {/* The working, above the total — the way a paper sum is laid out.
              Only while there IS a sum: a plain number needs no second line. */}
          {looksLikeExpression(entry) && (
            <div className="text-[15px] font-semibold text-mut2 tabular-nums select-none" aria-hidden>
              {entry}
            </div>
          )}
          <div className="flex items-baseline justify-center gap-1 select-none" aria-live="polite">
            <span className="text-[30px] font-bold leading-none" style={{ color: kind === "INCOME" ? "var(--green)" : "var(--red)" }}>
              {kind === "INCOME" ? "+" : "−"}
            </span>
            <span className="text-[30px] font-semibold leading-none text-mut2">₹</span>
            <span className="text-[54px] font-extrabold leading-none tabular-nums tracking-tight">{displayDigits(entry)}</span>
          </div>
          <button
            onClick={() => setPicker("note")}
            aria-label="Merchant and notes"
            className="bg-transparent border-none cursor-pointer text-[13px] text-mut2 hover:text-ink min-h-[44px] px-3"
          >
            {notes || merchant ? [merchant, notes].filter(Boolean).join(" · ") : "Who's it for?"}
          </button>
          {/* Group context: one line, not a panel. Members and the split method
              live behind it so the composer stays the reference's single
              screen instead of turning into the classic form again. */}
          {groupId && kind === "EXPENSE" && (
            <button
              onClick={() => setPicker("split")}
              className="inline-flex items-center gap-1.5 px-3 min-h-[36px] rounded-full border bg-transparent text-[12px] font-semibold cursor-pointer"
              style={{ borderColor: "var(--acc)", color: "var(--acc)" }}
            >
              {selectedIds.length === 0
                ? "Choose who's splitting"
                : `${selectedIds.length + 1} people · ${
                    { EQUAL: "Split equally", PERCENT: "By percentage", EXACT: "Custom amounts", RATIO: "By ratio" }[mode]
                  }`}
            </button>
          )}
          {error && (
            <div role="alert" className="text-[12.5px] font-semibold px-3 py-1.5 rounded-lg" style={{ background: "var(--redSoft)", color: "var(--red)" }}>
              {error}
            </div>
          )}
        </div>

        {/* ── metadata chips ───────────────────────────────────────────── */}
        <div className="flex items-center justify-center gap-2 flex-wrap flex-none">
          {chips.map((c) => (
            <button
              key={c.key}
              onClick={() => setPicker(c.key)}
              aria-label={c.unset ? `Choose a ${c.what.toLowerCase()}` : `${c.what}: ${c.label}`}
              data-unset={c.unset ? "" : undefined}
              className={`inline-flex items-center gap-1.5 px-3 min-h-[36px] rounded-full border border-line2 bg-transparent text-[12px] font-semibold cursor-pointer hover:bg-accsoft max-w-[46vw] ${c.unset ? "text-mut2" : "text-ink"}`}
            >
              <span aria-hidden className="text-[12px] opacity-70">{c.icon}</span>
              <span className="truncate">{c.label}</span>
            </button>
          ))}
        </div>

        {/* ── keypad ───────────────────────────────────────────────────── */}
        {/* Four columns: the digit block plus the operator rail, exactly the
            keys lib/expression can read. The composer was the only amount
            surface in the app WITHOUT arithmetic — the classic form has had it
            since AmountKeypad shipped — so this is the same capability
            arriving here, not a second calculator. */}
        {/* Clear and backspace sit above the grid, the way AmountKeypad's own
            utility strip does, so all sixteen calculator keys keep their places
            and nothing had to be dropped to make room for them. */}
        <div className="flex justify-end gap-2 flex-none">
          <button
            onClick={() => press("clear")}
            aria-label="Clear amount"
            className="min-h-[38px] px-4 rounded-[12px] bg-side border-none text-[13px] font-bold text-mut2 cursor-pointer active:brightness-125 select-none"
          >
            C
          </button>
          <button
            onClick={() => press("back")}
            aria-label="Backspace"
            className="min-h-[38px] px-4 rounded-[12px] bg-side border-none text-[15px] font-semibold text-mut2 cursor-pointer active:brightness-125 select-none"
          >
            ⌫
          </button>
        </div>

        <div className="grid grid-cols-4 gap-2 flex-none">
          {GRID.map((k) => (
            <button
              key={k.label}
              onClick={() => press(k.insert ?? "")}
              aria-label={k.aria}
              className={`min-h-[52px] rounded-[18px] border-none text-[20px] font-semibold cursor-pointer active:brightness-125 select-none grid place-items-center ${
                k.kind === "operator" ? "bg-accsoft text-acc" : "bg-side text-ink"
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>

        <SwipeToConfirm onComplete={commit} label={isEdit ? "Swipe to save changes" : `Swipe to add ${kind === "INCOME" ? "credit" : "debit"}`} />
      </div>

      {picker && (
        <PickerSheet
          picker={picker}
          close={() => setPicker(null)}
          state={{ groupId, setGroupId, date, setDate, categoryId, setCategoryId, accountId, setAccountId, notes, setNotes, merchant, setMerchant }}
          categories={categories}
          splitState={splitState}
          participants={pickerParticipants}
          preview={preview}
          amountPaise={paise}
          onPickGroup={(id) => {
            setGroupId(id);
            // Same rule the classic form applies when a group is chosen: its
            // members become the split, so the expense starts out shared with
            // the right people instead of whoever sorts first.
            // Only a Debit can be split: incomeSchema carries no split, so for
            // a Credit the group is a tag and nothing more. Opening the editor
            // there showed a sheet whose every setting was discarded on save.
            if (kind !== "EXPENSE") {
              setSplit(false);
              setParts({});
              setPayerId(null);
              setPicker(null);
              return;
            }
            const g = refData.groups.find((x) => x.id === id);
            const memberIds = (g?.memberIds ?? []).filter((mid) => refData.participants.some((pp) => pp.id === mid));
            setParts(Object.fromEntries(memberIds.map((mid) => [mid, true])));
            setSplit(memberIds.length > 0);
            setPicker(memberIds.length > 0 ? "split" : null);
          }}
        />
      )}
    </div>
  );

  // A create already renders at the top of the modal layer; only an edit has a
  // sheet underneath it to get out of.
  return isEdit && portalReady ? createPortal(screen, document.body) : screen;
}

/** Pill selector — the shape both the type and the personal/group choice take. */
function Segmented({
  options,
  value,
  onChange,
  tint,
  small,
}: {
  options: { value: string; label: string; glyph?: string }[];
  value: string;
  /** Omitted when the choice is fixed — the buttons then read as a statement
   *  of what this transaction IS, rather than a control that does nothing. */
  onChange?: (v: string) => void;
  tint?: string;
  small?: boolean;
}) {
  return (
    <div className={`inline-flex gap-1 rounded-full bg-side border border-line2 ${small ? "p-0.5" : "p-1"}`} role="group">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange?.(o.value)}
            aria-pressed={on}
            disabled={!onChange}
            title={!onChange && !on ? "A saved transaction can't change between Debit and Credit" : undefined}
            className={`inline-flex items-center gap-1.5 rounded-full border-none font-bold transition-colors ${
              onChange ? "cursor-pointer" : "cursor-default"
            } ${!onChange && !on ? "opacity-40" : ""} ${
              small ? "px-3 min-h-[32px] text-[11.5px]" : "px-4 min-h-[38px] text-[13px]"
            }`}
            style={{ background: on ? "var(--card)" : "transparent", color: on ? "var(--ink)" : "var(--mut2)" }}
          >
            {o.glyph && <span aria-hidden style={{ color: on ? tint : "inherit" }}>{o.glyph}</span>}
            <span className="truncate max-w-[38vw]">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Drag the handle to commit. A real pointer gesture, not a button wearing a
 *  track: releasing short of the threshold animates back and saves nothing. */
function SwipeToConfirm({ onComplete, label }: { onComplete: () => Promise<boolean>; label: string }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [locked, setLocked] = useState(false);
  const travel = useRef(1);

  const span = () => {
    const t = trackRef.current;
    travel.current = t ? Math.max(1, t.clientWidth - 62) : 1;
    return travel.current;
  };

  function move(clientX: number) {
    const t = trackRef.current;
    if (!t) return;
    const left = t.getBoundingClientRect().left;
    setX(Math.min(span(), Math.max(0, clientX - left - 31)));
  }

  async function release() {
    setDragging(false);
    if (x >= span() * 0.85) {
      setLocked(true);
      setX(span());
      const ok = await onComplete();
      if (!ok) {
        // Rejected — hand the control back rather than stranding it at the end.
        setLocked(false);
        setX(0);
      }
      return;
    }
    setX(0);
  }

  const pct = Math.round((x / travel.current) * 100);

  return (
    <div
      ref={trackRef}
      className="relative flex-none h-[58px] rounded-full bg-side border border-line2 overflow-hidden select-none touch-none"
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      tabIndex={0}
      onKeyDown={async (e) => {
        // Keyboard equivalent: the gesture cannot be the only way in.
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (!locked) {
            setLocked(true);
            const ok = await onComplete();
            if (!ok) setLocked(false);
          }
        }
      }}
      onPointerDown={(e) => {
        if (locked) return;
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        setDragging(true);
        move(e.clientX);
      }}
      onPointerMove={(e) => dragging && move(e.clientX)}
      onPointerUp={release}
      onPointerCancel={release}
    >
      {/* Filled portion, growing behind the handle. */}
      <div
        className="absolute inset-y-0 left-0"
        style={{
          // Starts at nothing: at rest the track is dark and only the handle's
          // glow is green, as in the reference. A fill that already had width
          // before the drag began read as a stub of progress that was not there.
          width: x,
          background: "var(--green)",
          opacity: 0.35 + (x / travel.current) * 0.45,
          transition: dragging ? "none" : "width .22s ease, opacity .22s ease",
        }}
      />
      <span className="absolute inset-0 grid place-items-center text-[13px] font-bold text-ink pointer-events-none px-14 text-center">
        {label}
      </span>
      <div
        className="absolute top-[4px] left-0 w-[50px] h-[50px] rounded-full bg-white grid place-items-center text-[17px] text-[#111] cursor-grab active:cursor-grabbing"
        style={{
          transform: `translateX(${x + 4}px)`,
          transition: dragging ? "none" : "transform .22s ease",
          boxShadow: "0 4px 14px rgba(0,0,0,.35), 0 0 18px 4px color-mix(in oklab, var(--green) 55%, transparent)",
        }}
      >
        →
      </div>
    </div>
  );
}

/** The success state: the whole screen, briefly. */
function SuccessWash({ kind }: { kind: Kind }) {
  return (
    <div
      data-wash
      className="fixed inset-0 z-[80] grid place-items-center"
      style={{ background: "radial-gradient(120% 90% at 50% 38%, #12a06a 0%, #0b6b47 45%, #052e21 100%)", animation: "washIn .18s ease" }}
      role="status"
    >
      <div className="flex items-center gap-2 -mt-16 text-white">
        <span className="w-5 h-5 rounded-full bg-white/90 grid place-items-center text-[12px] text-[#0f7a52] font-black" aria-hidden>✓</span>
        <span className="text-[15px] font-semibold">{kind === "INCOME" ? "Credit" : "Debit"} added</span>
      </div>
    </div>
  );
}

/** One sheet, reused for every chip — the app already has this shape. */
function PickerSheet({
  picker,
  close,
  state,
  categories,
  splitState,
  participants,
  preview,
  onPickGroup,
  amountPaise,
}: {
  picker: Exclude<Picker, null>;
  close: () => void;
  splitState: SplitEditorState;
  participants: { id: string; name: string; initial: string; color: string; isLending?: boolean }[];
  preview: ReturnType<typeof useSplitPreview>;
  onPickGroup: (id: string) => void;
  amountPaise: number;
  state: {
    groupId: string; setGroupId: (v: string) => void;
    date: string; setDate: (v: string) => void;
    categoryId: string; setCategoryId: (v: string) => void;
    accountId: string; setAccountId: (v: string) => void;
    notes: string; setNotes: (v: string) => void;
    merchant: string; setMerchant: (v: string) => void;
  };
  categories: { id: string; name: string; icon: string }[];
}) {
  const { refData } = useUI();
  const title = { group: "Group", date: "Date", category: "Category", payment: "Payment method", note: "Who's it for?", split: "Split" }[picker];

  const Row = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button
      onClick={() => { onClick(); close(); }}
      className="flex items-center gap-2 px-3 min-h-[44px] rounded-[10px] text-left text-[13px] font-semibold bg-transparent border-none cursor-pointer text-ink hover:bg-accsoft w-full"
      style={{ background: on ? "var(--accSoft)" : undefined, color: on ? "var(--acc)" : undefined }}
    >
      {children}
    </button>
  );

  return (
    <BottomSheet onClose={close} label={title} z={90}>
      {picker === "group" && (
        <>
          <Row on={!state.groupId} onClick={() => state.setGroupId("")}>Personal</Row>
          {refData.groups.map((g) => (
            <button
              key={g.id}
              onClick={() => onPickGroup(g.id)}
              className="flex items-center gap-2 px-3 min-h-[44px] rounded-[10px] text-left text-[13px] font-semibold bg-transparent border-none cursor-pointer text-ink hover:bg-accsoft w-full"
              style={state.groupId === g.id ? { background: "var(--accSoft)", color: "var(--acc)" } : undefined}
            >
              🏠 {g.name}
            </button>
          ))}
          {refData.groups.length === 0 && <div className="text-[12.5px] text-mut2 px-3 py-2">No groups yet — this stays personal.</div>}
        </>
      )}

      {picker === "date" && (
        <div className="px-1 py-1 flex flex-col gap-2">
          <DateField value={state.date} onChange={state.setDate} />
          <button onClick={close} className="btn-primary min-h-[44px] text-[13px] font-bold cursor-pointer">Done</button>
        </div>
      )}

      {picker === "category" && categories.map((c) => (
        <Row key={c.id} on={state.categoryId === c.id} onClick={() => state.setCategoryId(c.id)}>{c.icon} {c.name}</Row>
      ))}

      {picker === "payment" && (
        <>
          {refData.accounts.map((a) => (
            <Row key={a.id} on={state.accountId === a.id} onClick={() => state.setAccountId(a.id)}>{a.name}</Row>
          ))}
        </>
      )}

      {picker === "split" && (
        <div className="flex flex-col gap-3">
          {/* The classic form's own editor: members with search, the mode
              picker (Equal / Percentage / Custom / Ratio), per-person inputs,
              Paid by, and the breakdown — all of it, unmodified. */}
          <SplitEditor state={splitState} participants={participants} amountPaise={amountPaise} />
          {/* What those controls actually produce, from the SAME preview the
              swipe is gated on and the writer stores — never a second sum.
              Without it the composer was the one create surface where a share
              could be wrong and nothing on screen would say so: the classic
              form has shown this table since a ₹2,530 dinner saved ₹843.33
              against somebody with no figure anywhere on the page. */}
          {splitState.split && (
            <SplitBreakdown
              preview={preview}
              names={participants.filter((p) => splitState.parts[p.id]).map((p) => ({ id: p.id, name: p.name }))}
            />
          )}
          {preview && !preview.balances && !preview.error && (
            <div role="alert" className="text-[12px] font-semibold px-3 py-2 rounded-lg" style={{ background: "var(--redSoft)", color: "var(--red)" }}>
              These shares don&apos;t add up to the amount yet.
            </div>
          )}
          {preview?.error && (
            <div role="alert" className="text-[12px] font-semibold px-3 py-2 rounded-lg" style={{ background: "var(--redSoft)", color: "var(--red)" }}>
              {preview.error}
            </div>
          )}
          <button onClick={close} className="btn-primary min-h-[44px] text-[13px] font-bold cursor-pointer">Done</button>
        </div>
      )}

      {picker === "note" && (
        <div className="px-1 py-1 flex flex-col gap-3">
          <label className="block">
            <div className="label-caps">MERCHANT</div>
            <MerchantInput value={state.merchant} onChange={state.setMerchant} onRecognized={(s) => { if (s.categoryId) state.setCategoryId(s.categoryId); if (s.accountId) state.setAccountId(s.accountId); }} />
          </label>
          <label className="block">
            <div className="label-caps">NOTES</div>
            <input className="field" value={state.notes} onChange={(e) => state.setNotes(e.target.value)} placeholder="Optional" />
          </label>
          <button onClick={close} className="btn-primary min-h-[44px] text-[13px] font-bold cursor-pointer">Done</button>
        </div>
      )}
    </BottomSheet>
  );
}
