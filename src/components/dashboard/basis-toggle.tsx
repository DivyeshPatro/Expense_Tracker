"use client";

// Inline Cash/Personal switch for the Expense card, so changing basis doesn't
// require a trip to Settings. Writes the same cookie the Settings radio group
// writes, so the two stay in sync and every server-rendered screen respects it.
//
// Presentation only — it changes which figure is large, never any arithmetic.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BASIS_PREF, type ExpenseBasisPref } from "@/lib/expense-basis";
import { writePref } from "@/lib/preferences";
import { basisPref as basisPrefDef } from "@/lib/prefs-registry";
const OPTIONS: ExpenseBasisPref[] = ["cash", "personal"];

export function BasisToggle({ value }: { value: ExpenseBasisPref }) {
  // Optimistic local state: the figures are server-rendered, so without this
  // the pressed state would lag behind the tap by a whole refresh.
  const [pref, setPref] = useState(value);
  const [, startTransition] = useTransition();
  const router = useRouter();

  function choose(next: ExpenseBasisPref) {
    if (next === pref) return;
    setPref(next);
    writePref(basisPrefDef, next);
    startTransition(() => router.refresh());
  }

  return (
    <div role="radiogroup" aria-label="Expense basis" className="flex gap-0.5 rounded-lg p-0.5" style={{ background: "var(--bg)" }}>
      {OPTIONS.map((id) => {
        const active = pref === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            // The visible text is "Cash"/"Personal"; the accessible name carries
            // the full meaning so it isn't ambiguous out of context.
            aria-label={BASIS_PREF[id].label}
            title={BASIS_PREF[id].description}
            onClick={() => choose(id)}
            // min-h-6 keeps the hit area at the WCAG 2.5.8 24px floor even
            // though the control is visually small.
            className="text-[9.5px] font-bold uppercase tracking-[.06em] rounded-md px-2 min-h-6 transition-colors"
            style={{
              background: active ? "var(--acc)" : "transparent",
              color: active ? "#fff" : "var(--mut2)",
            }}
          >
            {id === "cash" ? "Cash" : "Personal"}
          </button>
        );
      })}
    </div>
  );
}
