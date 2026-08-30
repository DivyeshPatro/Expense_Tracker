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
import { useRouter } from "next/navigation";
import { useUI } from "./ui-context";
import { useOffline } from "./offline-context";
import { BottomSheet } from "./bottom-sheet";
import { MerchantInput } from "./merchant-input";
import { DateField } from "./date-field";
import { SplitEditor, buildSplitPayload, participantsForGroup, useSplitPreview, type SplitEditorState } from "./split-editor";
import { addExpenseAction } from "@/app/actions";
import { ensureDeviceId, getDeviceName } from "@/lib/offline/db";
import { friendlyDay, todayYMD } from "@/lib/dates";
import { amountToPaise } from "@/lib/expression";

type Kind = "INCOME" | "EXPENSE";
type Picker = null | "group" | "date" | "category" | "payment" | "note" | "split";

/** Digits the amount accepts before it would stop fitting the display. */
const MAX_INT_DIGITS = 9;

/** Grouped for reading, without imposing a currency symbol — the symbol is its
 *  own element so it can be styled apart from the digits. */
function formatEntry(raw: string): string {
  if (!raw) return "0";
  const [int, dec] = raw.split(".");
  const grouped = new Intl.NumberFormat("en-IN").format(Number(int || "0"));
  return dec === undefined ? grouped : `${grouped}.${dec}`;
}

export function TransactionComposer() {
  const { refData, closeModal } = useUI();
  const { createViaOutbox } = useOffline();
  const router = useRouter();

  // Debit first and selected: most entries are money going out, so the common
  // case should need no tap. Credit is still the existing income path.
  const [kind, setKind] = useState<Kind>("EXPENSE");
  const [groupId, setGroupId] = useState("");
  const [entry, setEntry] = useState("");
  const [notes, setNotes] = useState("");
  const [merchant, setMerchant] = useState("");
  const [date, setDate] = useState(todayYMD());
  const categories = kind === "INCOME" ? refData.incomeCategories : refData.expenseCategories;
  const [categoryId, setCategoryId] = useState(() => refData.expenseCategories[0]?.id ?? "");

  // The classic form's split state, unchanged in shape, so SplitEditor and
  // buildSplitPayload work here exactly as they do there. Nothing about how a
  // split is computed or stored is reimplemented.
  const [split, setSplit] = useState(false);
  const [mode, setMode] = useState<"EQUAL" | "EXACT" | "PERCENT" | "RATIO">("EQUAL");
  const [parts, setParts] = useState<Record<string, boolean>>({});
  const [exact, setExact] = useState<Record<string, string>>({});
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [payerId, setPayerId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState(() => refData.accounts[0]?.id ?? "");
  const [picker, setPicker] = useState<Picker>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // Not state: the guard has to hold synchronously, because a swipe that lands
  // twice in one tick would otherwise queue the transaction twice.
  const submitting = useRef(false);

  const paise = amountToPaise(entry || "0");
  const category = categories.find((c) => c.id === categoryId);
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

  // Switching type swaps the category list, so a selection from the other list
  // would be silently invalid. Land on the new list's first entry instead.
  useEffect(() => {
    if (!categories.some((c) => c.id === categoryId)) setCategoryId(categories[0]?.id ?? "");
  }, [categories, categoryId]);

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

  const press = useCallback((key: string) => {
    setEntry((cur) => {
      if (key === "back") return cur.slice(0, -1);
      if (key === ".") return cur.includes(".") ? cur : (cur || "0") + ".";
      const [int = "", dec] = cur.split(".");
      if (dec !== undefined) return dec.length >= 2 ? cur : cur + key;
      if (int === "0") return key; // no leading zeros
      return int.length >= MAX_INT_DIGITS ? cur : cur + key;
    });
  }, []);

  /** Everything the existing schemas require, in the shape they already take. */
  function validate(): string | null {
    if (paise <= 0) return "Enter an amount first";
    // incomeSchema requires accountId; expenseSchema allows null.
    if (kind === "INCOME" && !accountId) return "Choose where the money landed";
    if (split) {
      if (selectedIds.length === 0) return "Pick who this is split with";
      // computeSplitPreview is the same engine the writer uses, so if it says
      // the shares do not add up, saving would store a split that does not.
      if (preview?.error) return preview.error;
      if (preview && !preview.balances) return "The shares don't add up to the amount yet";
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
    if (kind === "INCOME") {
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
    // Long enough to read, short enough not to be in the way. The dashboard is
    // refreshed underneath while the wash is up, so it has the new row by the
    // time it is visible again.
    router.refresh();
    window.setTimeout(closeModal, 900);
    return true;
  }

  if (done) return <SuccessWash kind={kind} />;

  // `what` is the accessible name: the icon is decorative and the visible text
  // is only the value, so a screen reader would otherwise hear "Education"
  // without being told it is the category.
  const chips = [
    { key: "date" as const, icon: "🗓", what: "Date", label: date === todayYMD() ? "Today" : friendlyDay(date) },
    { key: "category" as const, icon: "🏷", what: "Category", label: category?.name ?? "Category" },
    { key: "payment" as const, icon: "💳", what: "Payment method", label: account?.name ?? "Payment" },
  ];

  return (
    <div className="fixed inset-0 z-[70] bg-bg flex flex-col" style={{ animation: "composerIn .22s ease" }}>
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
            onClick={closeModal}
            aria-label="Close"
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
              onChange={(v) => setKind(v as Kind)}
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
          <div className="flex items-baseline justify-center gap-1 select-none" aria-live="polite">
            <span className="text-[30px] font-bold leading-none" style={{ color: kind === "INCOME" ? "var(--green)" : "var(--red)" }}>
              {kind === "INCOME" ? "+" : "−"}
            </span>
            <span className="text-[30px] font-semibold leading-none text-mut2">₹</span>
            <span className="text-[54px] font-extrabold leading-none tabular-nums tracking-tight">{formatEntry(entry)}</span>
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
              aria-label={`${c.what}: ${c.label}`}
              className="inline-flex items-center gap-1.5 px-3 min-h-[36px] rounded-full border border-line2 bg-transparent text-[12px] font-semibold text-ink cursor-pointer hover:bg-accsoft max-w-[46vw]"
            >
              <span aria-hidden className="text-[12px] opacity-70">{c.icon}</span>
              <span className="truncate">{c.label}</span>
            </button>
          ))}
        </div>

        {/* ── keypad ───────────────────────────────────────────────────── */}
        <div className="grid grid-cols-3 gap-2.5 flex-none">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "back"].map((k) => (
            <button
              key={k}
              onClick={() => press(k)}
              aria-label={k === "back" ? "Backspace" : k === "." ? "Decimal point" : k}
              className="min-h-[54px] rounded-[18px] bg-side border-none text-[20px] font-semibold text-ink cursor-pointer active:brightness-125 select-none grid place-items-center"
            >
              {k === "back" ? "⌫" : k}
            </button>
          ))}
        </div>

        <SwipeToConfirm onComplete={commit} label={`Swipe to add ${kind === "INCOME" ? "credit" : "debit"}`} />
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
  onChange: (v: string) => void;
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
            onClick={() => onChange(o.value)}
            aria-pressed={on}
            className={`inline-flex items-center gap-1.5 rounded-full border-none cursor-pointer font-bold transition-colors ${
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
