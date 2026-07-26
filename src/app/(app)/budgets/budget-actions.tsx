"use client";

// Edit / delete for a budget row.
//
// Editing reuses the existing upsert: a budget is keyed on its category, so
// saving a new limit for the same category updates the row in place rather than
// creating a second one. Only the limit is editable — changing the category
// would be a different budget, which is what "New budget" is for.

import { useRouter } from "next/navigation";
import { useState } from "react";
import { deleteBudgetAction, saveBudgetAction } from "@/app/actions";
import { AmountInput, ErrorNote, Field } from "@/components/shell/form-primitives";
import { useUI } from "@/components/shell/ui-context";
import type { BudgetView } from "@/server/services/budgets";

export function BudgetActions({ budget }: { budget: BudgetView }) {
  const { showToast } = useUI();
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "edit" | "confirm">("idle");
  const [limit, setLimit] = useState(String(budget.limit / 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, fallback: string) {
    setBusy(true);
    setError(null);
    const res = await fn();
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Something went wrong");
      return false;
    }
    showToast(res.message ?? fallback);
    router.refresh();
    return true;
  }

  if (mode === "edit") {
    return (
      <div className="flex flex-col gap-2.5 mt-3 pt-3 border-t border-line">
        <div className="text-[11.5px] text-mut2">
          Changing the limit keeps this month&apos;s spending; alerts are re-evaluated against the new figure.
        </div>
        <div className="flex items-end gap-2 flex-wrap">
          <Field label="MONTHLY LIMIT (₹)">
            <AmountInput value={limit} onChange={setLimit} ariaLabel={`Monthly limit for ${budget.category}`} />
          </Field>
          <button
            disabled={busy}
            className="btn-primary disabled:opacity-60"
            onClick={async () => {
              const ok = await run(
                () => saveBudgetAction({ categoryId: budget.categoryId, limit }),
                "Budget updated"
              );
              if (ok) setMode("idle");
            }}
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            onClick={() => { setLimit(String(budget.limit / 100)); setMode("idle"); }}
            className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold cursor-pointer"
          >
            Cancel
          </button>
        </div>
        <ErrorNote error={error} />
      </div>
    );
  }

  if (mode === "confirm") {
    return (
      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-line flex-wrap">
        {/* The fear here is that removing a budget removes the spending it tracked. */}
        <span className="text-[11.5px] text-mut2 flex-1 min-w-[200px]">
          Delete this budget? Your transactions and spending history stay exactly as they are — only the limit and its
          alerts are removed.
        </span>
        <TinyButton
          tone="danger"
          disabled={busy}
          onClick={async () => {
            if (await run(() => deleteBudgetAction(budget.id), "Budget deleted")) setMode("idle");
          }}
        >
          Delete
        </TinyButton>
        <TinyButton onClick={() => setMode("idle")}>Keep</TinyButton>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 mt-3 pt-3 border-t border-line">
      <TinyButton onClick={() => setMode("edit")}>Edit limit</TinyButton>
      <TinyButton onClick={() => setMode("confirm")}>Delete</TinyButton>
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
