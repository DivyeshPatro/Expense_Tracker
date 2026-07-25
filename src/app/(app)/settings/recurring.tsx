"use client";

// Recurring transactions (Settings): the management surface for rules the daily
// cron materializes. Config rather than a daily destination, which is why it
// lives here instead of taking a slot in the sidebar.

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  deleteRecurringRuleAction,
  setRecurringRulePausedAction,
  updateRecurringRuleAction,
} from "@/app/actions";
import { AccountOptions } from "@/components/shell/account-options";
import { AmountInput, ErrorNote, Field } from "@/components/shell/form-primitives";
import { cadenceLabel, RepeatFields, type Cadence } from "@/components/shell/repeat-fields";
import { useUI } from "@/components/shell/ui-context";
import { friendlyDay } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import type { RecurringRuleView } from "@/server/services/recurring";

export function RecurringRules({ rules }: { rules: RecurringRuleView[] }) {
  const [editingId, setEditingId] = useState<string | null>(null);

  if (rules.length === 0) {
    return (
      <div className="text-[12px] text-mut2">
        No recurring transactions yet. Tick &ldquo;Repeat this&rdquo; when adding an expense or income to set one up.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {rules.map((r) =>
        editingId === r.id ? (
          <EditRuleForm key={r.id} rule={r} onDone={() => setEditingId(null)} />
        ) : (
          <RuleRow key={r.id} rule={r} onEdit={() => setEditingId(r.id)} />
        )
      )}
    </div>
  );
}

function RuleRow({ rule, onEdit }: { rule: RecurringRuleView; onEdit: () => void }) {
  const { showToast } = useUI();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    showToast(res.ok ? okMsg : res.error ?? "Something went wrong");
    if (res.ok) router.refresh();
  }

  return (
    <div className="flex items-center gap-3 py-2 border-b border-line last:border-b-0 text-[12.5px]">
      <div className="flex-1 min-w-0">
        <div className="font-semibold truncate flex items-center gap-2">
          <span className={rule.template.type === "INCOME" ? "text-green" : ""}>
            {rule.template.type === "INCOME" ? "+" : "−"}
            {formatPaise(rule.template.amount)}
          </span>
          <span className="text-mut2 font-normal truncate">{rule.template.merchant}</span>
          {rule.isPaused && (
            <span className="text-[10px] font-bold text-amber bg-ambersoft rounded px-1.5 py-0.5 flex-none">PAUSED</span>
          )}
        </div>
        <div className="text-mut2">
          {cadenceLabel(rule.cadence, rule.interval)}
          {rule.accountName ? ` · ${rule.accountName}` : ""}
          {rule.categoryName ? ` · ${rule.categoryName}` : ""}
          {" · "}
          {rule.isPaused ? "Paused" : `Next ${friendlyDay(rule.nextRunYmd)}`}
          {rule.endsYmd ? ` · until ${rule.endsYmd}` : ""}
        </div>
      </div>

      {confirming ? (
        <div className="flex items-center gap-2 flex-none">
          {/* Says what survives: deleting a schedule is not a statement about history. */}
          <span className="text-[11.5px] text-mut2">
            Delete rule?{rule.materializedCount > 0 && ` ${rule.materializedCount} past transaction${rule.materializedCount === 1 ? "" : "s"} stay${rule.materializedCount === 1 ? "s" : ""}.`}
          </span>
          <button
            disabled={busy}
            onClick={() => run(() => deleteRecurringRuleAction(rule.id), "Recurring rule deleted")}
            className="px-2.5 py-1.5 rounded-lg border-none bg-red text-white text-[11.5px] font-semibold cursor-pointer disabled:opacity-60"
          >
            Delete
          </button>
          <button
            onClick={() => setConfirming(false)}
            className="px-2.5 py-1.5 rounded-lg border border-line2 bg-card text-[11.5px] font-semibold cursor-pointer"
          >
            Keep
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-none">
          <RowButton onClick={onEdit} disabled={busy}>Edit</RowButton>
          <RowButton
            disabled={busy}
            onClick={() =>
              run(
                () => setRecurringRulePausedAction(rule.id, !rule.isPaused),
                rule.isPaused ? "Recurring rule resumed" : "Recurring rule paused"
              )
            }
          >
            {rule.isPaused ? "Resume" : "Pause"}
          </RowButton>
          <RowButton onClick={() => setConfirming(true)} disabled={busy}>Delete</RowButton>
        </div>
      )}
    </div>
  );
}

function RowButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-2.5 py-1.5 rounded-lg border border-line2 text-[11.5px] font-semibold text-acc cursor-pointer bg-transparent hover:bg-accsoft disabled:opacity-60"
    >
      {children}
    </button>
  );
}

function EditRuleForm({ rule, onDone }: { rule: RecurringRuleView; onDone: () => void }) {
  const { refData, showToast } = useUI();
  const router = useRouter();
  const [amount, setAmount] = useState(String(rule.template.amount / 100));
  const [merchant, setMerchant] = useState(rule.template.merchant);
  const [accountId, setAccountId] = useState(rule.template.accountId ?? "");
  const [categoryId, setCategoryId] = useState(rule.template.categoryId ?? "");
  const [cadence, setCadence] = useState<Cadence>(rule.cadence);
  const [interval, setInterval] = useState(String(rule.interval));
  const [startDate, setStartDate] = useState(rule.nextRunYmd);
  const [endDate, setEndDate] = useState(rule.endsYmd ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const categories = rule.template.type === "INCOME" ? refData.incomeCategories : refData.expenseCategories;

  async function save() {
    setBusy(true);
    setError(null);
    const res = await updateRecurringRuleAction({
      id: rule.id,
      type: rule.template.type,
      amount,
      accountId: accountId || null,
      categoryId: categoryId || null,
      merchant,
      cadence,
      interval,
      startDate,
      endDate: endDate || null,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    showToast("Recurring rule updated");
    onDone();
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3 py-3 border-b border-line last:border-b-0">
      <div className="text-[12px] text-mut2">
        Changes apply to future occurrences. Transactions already created stay as they are.
      </div>
      <div className="flex gap-2.5 flex-wrap">
        <Field label="AMOUNT (₹)">
          <AmountInput value={amount} onChange={setAmount} />
        </Field>
        <Field label="DESCRIPTION">
          <input className="field" value={merchant} onChange={(e) => setMerchant(e.target.value)} />
        </Field>
      </div>
      <div className="flex gap-2.5 flex-wrap">
        <Field label="ACCOUNT">
          <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Unassigned</option>
            <AccountOptions accounts={refData.accounts} />
          </select>
        </Field>
        <Field label="CATEGORY">
          <select className="field" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Uncategorized</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
            ))}
          </select>
        </Field>
      </div>
      <RepeatFields
        cadence={cadence}
        setCadence={setCadence}
        interval={interval}
        setInterval={setInterval}
        startDate={startDate}
        setStartDate={setStartDate}
        endDate={endDate}
        setEndDate={setEndDate}
        startLabel="NEXT RUN"
      />
      <ErrorNote error={error} />
      <div className="flex gap-2">
        <button disabled={busy} onClick={save} className="btn-primary disabled:opacity-60">
          {busy ? "Saving…" : "Save changes"}
        </button>
        <button onClick={onDone} className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold cursor-pointer">
          Cancel
        </button>
      </div>
    </div>
  );
}
