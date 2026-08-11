"use client";

// Expense basis preference. Presentation only: it decides which of the two
// expense figures is the large one on the dashboard and the transaction
// summary. Both figures stay visible either way, and budgets, alerts, savings
// rate and exports are deliberately unaffected — two users with different
// preferences still get identical budget warnings and identical exported data.
//
// Persisted in a cookie (not localStorage) because the surfaces that read it
// are server components, so the correct figure is the large one on first paint
// with no flash. Same mechanism as the theme — see lib/theme.ts.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BASIS_PREF, type ExpenseBasisPref } from "@/lib/expense-basis";
import { writePref } from "@/lib/preferences";
import { basisPref as basisPrefDef } from "@/lib/prefs-registry";

export function BasisPreference({ initial }: { initial: ExpenseBasisPref }) {
  const [pref, setPref] = useState<ExpenseBasisPref>(initial);
  const router = useRouter();

  function choose(next: ExpenseBasisPref) {
    setPref(next);
    writePref(basisPrefDef, next);
    // The figures are server-rendered, so the open page needs re-rendering to
    // pick the new headline up.
    router.refresh();
  }

  return (
    <div role="radiogroup" aria-label="Expense basis" className="flex flex-col gap-2">
      {(Object.keys(BASIS_PREF) as ExpenseBasisPref[]).map((id) => {
        const meta = BASIS_PREF[id];
        const active = pref === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => choose(id)}
            className="text-left rounded-xl px-3.5 py-3 border transition-colors"
            style={{
              borderColor: active ? "var(--acc)" : "var(--line2)",
              background: active ? "var(--accSoft)" : "var(--card)",
            }}
          >
            <div className="text-[13px] font-bold flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block w-3 h-3 rounded-full border-2"
                style={{ borderColor: active ? "var(--acc)" : "var(--line2)", background: active ? "var(--acc)" : "transparent" }}
              />
              {meta.label}
            </div>
            <div className="text-[12px] text-mut mt-1 ml-5">{meta.description}</div>
          </button>
        );
      })}
      <p className="text-[11.5px] text-mut2 mt-1">
        This only changes which figure is shown larger. Both are always visible, and your budgets, alerts and exports are unaffected.
      </p>
    </div>
  );
}
