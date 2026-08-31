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
import { addExpenseAction, createGroupCategoryAction, listGroupCategoriesAction, updateExpenseAction } from "@/app/actions";
import { inferGroupForMembers, needsExplicitGroupChoice } from "@/lib/group-inference";
import type { TransactionDetail } from "@/server/services/transactions";
import type { ModalPrefill } from "./ui-context";
import { ensureDeviceId, getDeviceName } from "@/lib/offline/db";
import { friendlyDay, todayYMD } from "@/lib/dates";
import { amountToPaise, evaluateAmount, pressAmountKey } from "@/lib/expression";
import {
  AmountHero,
  EntryKeypad,
  MetaChips,
  Segmented,
  SuccessWash,
  SwipeToConfirm,
} from "./entry-shell";
import { createRuleFor, RepeatBlock, useRepeat, type RepeatState } from "./repeat-block";
import { useFocusTrap } from "./use-focus-trap";

type Kind = "INCOME" | "EXPENSE";

/** What the chip reads once a rule is armed. Cadences are RepeatState's own. */
const REPEAT_LABEL: Record<string, string> = { DAILY: "Daily", WEEKLY: "Weekly", MONTHLY: "Monthly", YEARLY: "Yearly" };
type Picker = null | "group" | "date" | "category" | "payment" | "note" | "split" | "repeat";

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
export function TransactionComposer({ edit, onCancel, prefill }: { edit?: TransactionDetail; onCancel?: () => void; prefill?: ModalPrefill } = {}) {
  const { refData, closeModal, showToast } = useUI();
  const { createViaOutbox, enqueueMutation } = useOffline();
  const router = useRouter();
  const isEdit = !!edit;

  // Debit first and selected: most entries are money going out, so the common
  // case should need no tap. Credit is still the existing income path. An edit
  // opens on whatever the row already is, and cannot change it — the data layer
  // has no Debit↔Credit conversion (separate services, separate schemas), so
  // offering one would be inventing a mutation nothing implements.
  const [kind, setKind] = useState<Kind>(
    edit ? (edit.type === "INCOME" ? "INCOME" : "EXPENSE") : (prefill?.composeKind ?? "EXPENSE")
  );
  // A Shared entry point opens straight into its group. `dupGroupId` is the
  // shape the classic form already accepted from those buttons, so the callers
  // did not have to learn a new one.
  const [groupId, setGroupId] = useState(edit?.groupId ?? prefill?.dupGroupId ?? "");
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

  /**
   * Create a category in the group's own namespace and select it.
   *
   * GroupCategorySelect has offered this since group categories existed, and
   * it is the only way to add one while recording the expense that needs it —
   * Settings > Categories manages the PERSONAL list, so without this a group
   * expense could only be filed under a name somebody had thought of earlier.
   * Same action, same namespace, same auto-select as the classic form.
   */
  async function addGroupCategory(name: string): Promise<string | null> {
    const res = await createGroupCategoryAction(groupId, name.trim());
    if (!res.ok) return res.error;
    if (res.category) {
      const c = { id: res.category.id, name: res.category.name, icon: res.category.icon ?? "📦" };
      setGroupCategories((cs) => [...cs.filter((x) => x.id !== c.id), c].sort((a, b) => a.name.localeCompare(b.name)));
      setCategoryId(c.id);
    }
    return null;
  }

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
  // A group arriving by prefill has to be set up the same way picking one is —
  // its members become the split — or the Shared buttons would land on a group
  // with nobody in it. Same rule, same source (refData.groups memberIds), just
  // applied at mount instead of on tap.
  const preGroup = !edit && prefill?.dupGroupId ? refData.groups.find((g) => g.id === prefill.dupGroupId) : undefined;
  const preMembers = (preGroup?.memberIds ?? []).filter((mid) => refData.participants.some((p) => p.id === mid));
  const [split, setSplit] = useState((edit?.splits.length ?? 0) > 0 || preMembers.length > 0 || (!edit && !!prefill?.split));
  const [mode, setMode] = useState<"EQUAL" | "EXACT" | "PERCENT" | "RATIO">(
    edit && edit.splits.length > 0 ? (edit.splits[0].method === "EQUAL" ? "EQUAL" : "EXACT") : "EQUAL"
  );
  const [parts, setParts] = useState<Record<string, boolean>>(() => {
    if (edit) return Object.fromEntries(edit.splits.filter((s) => s.participantId).map((s) => [s.participantId as string, true]));
    if (preMembers.length) return Object.fromEntries(preMembers.map((mid) => [mid, true]));
    // A split asked for with no group — the Shared FAB's shape. The classic
    // form seeded the first two contacts here so the editor opened on
    // something rather than on nobody; same roster, same reason.
    if (prefill?.split) return Object.fromEntries(refData.participants.slice(0, 2).map((p) => [p.id, true]));
    return {};
  });
  const [exact, setExact] = useState<Record<string, string>>(() =>
    Object.fromEntries((edit?.splits ?? []).map((s) => [s.participantId ?? "me", String(s.owedAmount / 100)]))
  );
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [payerId, setPayerId] = useState<string | null>(edit?.paidByParticipantId ?? null);
  const [accountId, setAccountId] = useState(edit?.accountId ?? refData.accounts[0]?.id ?? "");
  // Recurrence, from the same hook, block and action the classic forms use.
  // The composer schedules nothing itself — createRuleFor owns that.
  const repeat = useRepeat();
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

  // Escape-to-close comes from app-shell's global handler, which this screen
  // shares with every sheet. The trap is the half that has to live here: the
  // composer covers the app but is not a dialog, so nothing else stops Tab
  // walking out onto the sidebar behind it.
  useFocusTrap(rootRef, true);
  useEffect(() => {
    const el = rootRef.current;
    // Only when focus is still outside — the amount is a keypad, so there is
    // no field autoFocusing, and taking focus from a sheet opened on top of
    // this screen would fight it.
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, []);

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

  // The conditions are the old forms' own, not new ones: the expense form
  // renders RepeatBlock when `!split && !groupId`, the income form when
  // `!groupId`. A rule carries no split and no group, so a repeating group or
  // split entry would schedule something different from what is on screen.
  //
  // Editing offers no repeat because neither classic edit form does: a rule is
  // a separate row, created alongside the transaction, and is edited in
  // Settings rather than through the transaction it came from.
  const repeatAvailable = !isEdit && (kind === "INCOME" ? !groupId : !split && !groupId);
  const splitState: SplitEditorState = { split, setSplit, mode, setMode, parts, setParts, exact, setExact, weights, setWeights, payerId, setPayerId };
  // A group expense can only be split among that group's members — the same
  // narrowing the classic form applies, from the same helper.
  const pickerParticipants = participantsForGroup(refData.participants, groupId, refData.groups, parts);
  const selectedIds = refData.participants.filter((p) => parts[p.id]).map((p) => p.id);
  // The engine's own preview: the arithmetic here is the arithmetic that gets
  // stored, because both go through computeShares.
  const preview = useSplitPreview(paise, splitState, selectedIds);

  // v2.1 split ↔ group coupling, unchanged in substance from the classic form.
  //
  // "Split with friends" and "Group" were once independent controls, and an
  // expense split among a group's members saved with groupId = null — the
  // group dashboard filters on groupId, so it simply never saw it. Four of
  // five expenses on one real trip went missing that way.
  //
  // The rule is asymmetric about certainty: choosing a group applies its
  // roster (a fact — that is what onPickGroup below does), while choosing
  // people only implies a group (a guess), so it applies ONLY when exactly
  // one group holds everyone, and otherwise asks instead of picking.
  //
  // A composer that dropped this would reintroduce the original bug, so it is
  // ported whole rather than approximated: same inference, same "ask, do not
  // guess" block on saving.
  const groupTouched = useRef(!!(edit?.groupId ?? prefill?.dupGroupId));
  const inference = inferGroupForMembers(selectedIds, refData.groups);
  // Collapsed to a primitive so the effect runs on a real change of outcome,
  // not on every render's freshly-allocated object.
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

  /** Several groups fit, or one nearly fits, and nobody has said which. */
  const mustChooseGroup = needsExplicitGroupChoice(inference, groupTouched.current);

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

  // Turning a personal expense into a group or split one withdraws the offer,
  // so the pending choice goes with it — otherwise a rule would be scheduled
  // for a transaction whose own form no longer offers to repeat it.
  useEffect(() => {
    if (!repeatAvailable && repeat.on) repeat.setOn(false);
  }, [repeatAvailable, repeat]);

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
      // Ask rather than guess. Quietly saving as Personal is the original bug.
      if (mustChooseGroup) {
        return inference.kind === "conflict"
          ? `Most of these people are in ${inference.candidates.map((c) => c.name).join(" and ")}, but not all of them — choose the group, or Personal.`
          : `These people are in ${
              inference.kind === "ambiguous" ? inference.candidates.map((c) => c.name).join(" and ") : "more than one group"
            } — choose which one this belongs to, or Personal.`;
      }
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
    // Scheduled AFTER the transaction lands, and a failure here must not fail
    // the submission: the transaction is already committed, and reporting
    // failure would invite a duplicate on resubmit. Surfaced in the success
    // line instead — the same trade the classic forms make, with the same copy.
    let scheduleError: string | null = null;
    if (repeatAvailable && repeat.on) {
      scheduleError = await createRuleFor(repeat, {
        type: kind,
        amount: entry,
        accountId: accountId || null,
        categoryId: categoryId || null,
        merchant,
        date,
      });
    }
    setDone(true);
    // An edit says so in a toast the way the classic form did, rather than
    // relying on a wash that reads as "added".
    if (edit) showToast("Transaction updated");
    else if (scheduleError) showToast(`${kind === "INCOME" ? "Income" : "Expense"} added — but the repeat wasn't saved: ${scheduleError}`);
    else if (repeatAvailable && repeat.on) showToast(`${kind === "INCOME" ? "Income" : "Expense"} added and scheduled to repeat`);
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

  if (done) return <SuccessWash label={`${kind === "INCOME" ? "Credit" : "Debit"} added`} />;

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
    // Offered on exactly the entries the classic forms offer it on, so the chip
    // appearing and disappearing tracks a rule that already existed.
    ...(repeatAvailable
      ? [{
          key: "repeat" as const,
          icon: "🔁",
          what: "Repeat",
          label: repeat.on ? REPEAT_LABEL[repeat.cadence] ?? "Repeating" : "Repeat",
          unset: !repeat.on,
        }]
      : []),
  ];

  const screen = (
    // Deliberately NOT role="dialog": this is a screen, the modal layer
    // already owns that role, and claiming it here would make every existing
    // `getByRole("dialog")` in the app and its suites ambiguous. The focus
    // problem an edit really has is solved by the portal and inert above.
    <div
      ref={rootRef}
      tabIndex={-1}
      aria-label={isEdit ? "Edit transaction" : "New transaction"}
      className="fixed inset-0 z-[70] bg-bg flex flex-col outline-none"
      style={{ animation: "composerIn .22s ease" }}
    >
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
              label="Debit or credit"
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
            label="Personal or group"
            options={[
              { value: "personal", label: "Personal" },
              { value: "group", label: group ? group.name : "Group" },
            ]}
            value={groupId ? "group" : "personal"}
            onChange={(v) => {
              if (v === "personal") {
                // An explicit answer, including to the "which group?" question
                // — so the inference must not quietly put one back.
                groupTouched.current = true;
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
          <AmountHero
            entry={entry}
            sign={kind === "INCOME" ? "+" : "−"}
            tint={kind === "INCOME" ? "var(--green)" : "var(--red)"}
          />
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
          {/* Every expense, not only a group one. Splitting has never required
              a group — the classic form offered "Split with friends" on any
              expense, the Shared entry point asks for a split with no group
              chosen, and v2.1's repair path exists precisely because a split
              can be saved outside one. Gating this line on a group would take
              that away, and would strand an already-made split with no way
              back to its editor. Reads as an invitation until there is one. */}
          {kind === "EXPENSE" && (
            <button
              onClick={() => setPicker("split")}
              className="inline-flex items-center gap-1.5 px-3 min-h-[36px] rounded-full border bg-transparent text-[12px] font-semibold cursor-pointer"
              style={
                selectedIds.length === 0
                  ? { borderColor: "var(--line2)", color: "var(--mut2)" }
                  : { borderColor: "var(--acc)", color: "var(--acc)" }
              }
            >
              {selectedIds.length === 0
                ? split || groupId
                  ? "Choose who's splitting"
                  : "Split with someone"
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
        <MetaChips chips={chips} onPick={(k) => setPicker(k as Picker)} />

        {/* ── keypad ───────────────────────────────────────────────────── */}
        {/* Four columns: the digit block plus the operator rail, exactly the
            keys lib/expression can read. The composer was the only amount
            surface in the app WITHOUT arithmetic — the classic form has had it
            since AmountKeypad shipped — so this is the same capability
            arriving here, not a second calculator. */}
        {/* Clear and backspace sit above the grid, the way AmountKeypad's own
            utility strip does, so all sixteen calculator keys keep their places
            and nothing had to be dropped to make room for them. */}
        {/* Clear, backspace and the sixteen calculator keys — the shell owns
            the markup so Spending and Lending cannot drift apart. */}
        <EntryKeypad press={press} />

        <SwipeToConfirm onComplete={commit} label={isEdit ? "Swipe to save changes" : `Swipe to add ${kind === "INCOME" ? "credit" : "debit"}`} />
      </div>

      {picker && (
        <PickerSheet
          picker={picker}
          close={() => setPicker(null)}
          state={{ groupId, setGroupId, date, setDate, categoryId, setCategoryId, accountId, setAccountId, notes, setNotes, merchant, setMerchant }}
          categories={categories}
          onCreateCategory={inGroupExpense ? addGroupCategory : undefined}
          splitState={splitState}
          repeatState={repeat}
          participants={pickerParticipants}
          preview={preview}
          amountPaise={paise}
          onPickGroup={(id) => {
            // A deliberate choice, so the inference stops second-guessing it.
            groupTouched.current = true;
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
            // Personal: the group comes off, the split stays. A split with
            // no group is a real shape (dinner with a friend who is in none of
            // your groups), and clearing it here would throw away the roster
            // the user just picked.
            if (!id) {
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

/**
 * "＋ New category", and the little form it turns into.
 *
 * Deliberately the last row rather than a separate control: it is the same
 * place GroupCategorySelect kept it, at the bottom of the list you have just
 * failed to find what you wanted in.
 */
function NewCategoryRow({ onCreate, done }: { onCreate: (name: string) => Promise<string | null>; done: () => void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    const err = await onCreate(trimmed);
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    setAdding(false);
    setName("");
    // Picking any other category closes the sheet; creating one selects it, so
    // it closes too rather than leaving the screen mid-air.
    done();
  }

  if (!adding) {
    return (
      <button
        onClick={() => setAdding(true)}
        className="flex items-center gap-2 px-3 min-h-[44px] rounded-[10px] text-left text-[13px] font-bold bg-transparent border-none cursor-pointer text-acc hover:bg-accsoft w-full"
      >
        ＋ New category
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1 px-1 py-1">
      <div className="flex gap-1.5">
        <input
          className="field flex-1"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New category name"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
            if (e.key === "Escape") {
              setAdding(false);
              setName("");
              setError(null);
            }
          }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy || !name.trim()}
          className="px-3 rounded-[10px] text-[12.5px] font-bold text-white border-none cursor-pointer disabled:opacity-60"
          style={{ background: "var(--acc)" }}
        >
          {busy ? "…" : "Add"}
        </button>
        <button
          type="button"
          onClick={() => { setAdding(false); setName(""); setError(null); }}
          aria-label="Cancel"
          className="px-3 rounded-[10px] text-[12.5px] font-semibold border border-line2 bg-card cursor-pointer"
        >
          ✕
        </button>
      </div>
      {error && <div className="text-[11.5px] font-semibold text-red">{error}</div>}
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
  repeatState,
  participants,
  preview,
  onPickGroup,
  amountPaise,
  onCreateCategory,
}: {
  picker: Exclude<Picker, null>;
  close: () => void;
  splitState: SplitEditorState;
  repeatState: RepeatState;
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
  /** Present only where a new category can be made — a group expense. */
  onCreateCategory?: (name: string) => Promise<string | null>;
}) {
  const { refData } = useUI();
  const title = { group: "Group", date: "Date", category: "Category", payment: "Payment method", note: "Who's it for?", split: "Split", repeat: "Repeat" }[picker];

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
          {/* "Personal" is an answer to "which group?", not an absence of one
              — the classic form's "Personal (not in a group)" option. Saying
              so is what stops the inference from quietly putting a group back
              on a split somebody deliberately kept personal. */}
          <Row on={!state.groupId} onClick={() => onPickGroup("")}>Personal</Row>
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

      {picker === "category" && (
        <>
          {categories.map((c) => (
            <Row key={c.id} on={state.categoryId === c.id} onClick={() => state.setCategoryId(c.id)}>{c.icon} {c.name}</Row>
          ))}
          {onCreateCategory && <NewCategoryRow onCreate={onCreateCategory} done={close} />}
        </>
      )}

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

      {picker === "repeat" && (
        <div className="px-1 py-1 flex flex-col gap-2">
          {/* The classic forms' own block, unmodified — cadence, interval and
              end date all come from it, and createRuleFor reads the same state
              object on save. */}
          <RepeatBlock state={repeatState} transactionYmd={state.date} />
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
