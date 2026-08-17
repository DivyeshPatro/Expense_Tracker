"use client";

// v2.1 — the expenses behind a group's total.
//
// The group page showed "Total expenses ₹X" with no way to see what produced
// it: the read model loaded the rows to compute balances and then dropped them,
// so the only route to a shared expense was to hunt for it in Spending. That is
// the disconnect this fixes.
//
// Tapping a row opens the SAME transaction sheet the Spending list opens
// (`openModal("txDetail")`) — one transaction, one edit path, View/Edit/
// Duplicate/Delete already inside it. Nothing here duplicates the transaction
// or defines a second shared-expense model, and no per-row button clutter is
// added: the row is the target, the sheet holds the actions.

import { useState } from "react";
import { friendlyDay } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { EmptyState } from "@/components/shell/empty-state";
import { OpenModalButton } from "@/components/shell/buttons";
import { useUI } from "@/components/shell/ui-context";
import type { GroupExpenseListRow } from "@/server/services/group-dashboard";

const FIRST_PAGE = 8;

export function GroupExpenses({ expenses, groupId }: { expenses: GroupExpenseListRow[]; groupId: string }) {
  const { openModal } = useUI();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? expenses : expenses.slice(0, FIRST_PAGE);
  const hidden = expenses.length - shown.length;

  return (
    <section className="card p-[var(--pad)] flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <h2 className="text-[13.5px] font-bold m-0">
          Expenses{expenses.length > 0 && <span className="text-mut2 font-semibold"> · {expenses.length}</span>}
        </h2>
        <OpenModalButton
          type="exp"
          prefill={{ split: true, dupGroupId: groupId }}
          className="text-[12px] font-semibold text-acc cursor-pointer px-3 min-h-[36px] rounded-[9px] bg-transparent border border-line2 hover:bg-accsoft"
        >
          ＋ Add
        </OpenModalButton>
      </div>

      {expenses.length === 0 ? (
        <EmptyState
          icon="🧾"
          title="No expenses in this group yet"
          detail="Add one and split it — it'll show up here, and everyone's balance updates straight away."
          compact
          action={
            <OpenModalButton type="exp" prefill={{ split: true, dupGroupId: groupId }} className="btn-primary">
              ＋ Add expense
            </OpenModalButton>
          }
        />
      ) : (
        <>
          {shown.map((e) => (
            <button
              key={e.id}
              onClick={() => openModal("txDetail", { transactionId: e.id })}
              className="flex items-center gap-3 py-2 min-h-[52px] w-full text-left bg-transparent border-none border-b border-line last:border-b-0 cursor-pointer px-0 hover:bg-accsoft rounded-lg"
            >
              <span
                className="w-9 h-9 rounded-[11px] grid place-items-center text-[15px] flex-none"
                style={{ background: "var(--accSoft)" }}
                aria-hidden
              >
                {e.icon}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] font-bold truncate text-ink">{e.merchant}</span>
                <span className="block text-[11.5px] text-mut2 truncate">
                  {friendlyDay(e.ymd)} · {e.paidByName === "You" ? "you paid" : `${e.paidByName} paid`} · split {e.splitCount} way
                  {e.splitCount === 1 ? "" : "s"}
                </span>
              </span>
              <span className="text-right flex-none">
                <span className="block text-[13px] font-extrabold tabular-nums text-ink">{formatPaise(e.amount)}</span>
                <span className="block text-[11px] text-mut2 tabular-nums">your share {formatPaise(e.yourShare)}</span>
              </span>
            </button>
          ))}
          {hidden > 0 && (
            <button
              onClick={() => setExpanded(true)}
              className="min-h-[44px] text-[12.5px] font-semibold text-acc bg-transparent border-none cursor-pointer hover:underline mt-1"
            >
              Show all {expenses.length} expenses
            </button>
          )}
        </>
      )}
    </section>
  );
}
