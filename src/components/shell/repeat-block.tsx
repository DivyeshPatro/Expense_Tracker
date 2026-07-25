"use client";

// "Repeat this" on the expense/income forms: schedules future occurrences of the
// transaction being added, without making the user go and describe it a second
// time somewhere else.

import { useState } from "react";
import { createRecurringRuleAction } from "@/app/actions";
import { advance } from "@/lib/dates";
import { RepeatFields, type Cadence } from "./repeat-fields";

export interface RepeatState {
  on: boolean;
  setOn: (v: boolean) => void;
  cadence: Cadence;
  setCadence: (v: Cadence) => void;
  interval: string;
  setInterval: (v: string) => void;
  endDate: string;
  setEndDate: (v: string) => void;
}

export function useRepeat(): RepeatState {
  const [on, setOn] = useState(false);
  const [cadence, setCadence] = useState<Cadence>("MONTHLY");
  const [interval, setInterval] = useState("1");
  const [endDate, setEndDate] = useState("");
  return { on, setOn, cadence, setCadence, interval, setInterval, endDate, setEndDate };
}

/**
 * The transaction being submitted covers the first occurrence, so the schedule
 * starts one step later — otherwise tonight's cron would immediately duplicate
 * what the user just added.
 */
export function firstFutureRun(state: RepeatState, transactionYmd: string): string {
  const anchor = state.cadence === "DAILY" || state.cadence === "WEEKLY" ? null : Number(transactionYmd.slice(8, 10));
  return advance(transactionYmd, state.cadence, Math.max(1, Number(state.interval) || 1), anchor);
}

/**
 * Creates the rule for a transaction that was just added. Returns an error
 * string when the schedule couldn't be saved — the caller must NOT treat that as
 * the whole submission failing: the transaction is already committed, and
 * reporting failure would invite a duplicate on resubmit.
 */
export async function createRuleFor(
  state: RepeatState,
  tx: { type: "EXPENSE" | "INCOME"; amount: string; accountId: string | null; categoryId: string | null; merchant: string; date: string }
): Promise<string | null> {
  const res = await createRecurringRuleAction({
    type: tx.type,
    amount: tx.amount,
    accountId: tx.accountId,
    categoryId: tx.categoryId,
    merchant: tx.merchant,
    cadence: state.cadence,
    interval: state.interval,
    startDate: firstFutureRun(state, tx.date),
    endDate: state.endDate || null,
  });
  return res.ok ? null : res.error;
}

export function RepeatBlock({ state, transactionYmd }: { state: RepeatState; transactionYmd: string }) {
  return (
    <div className="flex flex-col gap-2.5">
      <label className="flex items-center gap-2 text-[12.5px] font-semibold cursor-pointer select-none">
        <input type="checkbox" checked={state.on} onChange={(e) => state.setOn(e.target.checked)} className="cursor-pointer" />
        Repeat this
      </label>
      {state.on && (
        <>
          <RepeatFields
            cadence={state.cadence}
            setCadence={state.setCadence}
            interval={state.interval}
            setInterval={state.setInterval}
            // The start is derived, not chosen: it's always the step after this
            // transaction. Shown read-only below so it isn't a surprise.
            startDate={transactionYmd}
            setStartDate={() => {}}
            endDate={state.endDate}
            setEndDate={state.setEndDate}
            hideStart
          />
          <div className="text-[11.5px] text-mut2">
            This one is added now; the next is scheduled for{" "}
            <b className="text-ink">{firstFutureRun(state, transactionYmd)}</b>. Manage it later in Settings → Recurring transactions.
          </div>
        </>
      )}
    </div>
  );
}
