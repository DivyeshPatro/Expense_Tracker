"use client";

// Custom categories (PRD §4.3): view what's seeded, add your own.

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createCategoryAction } from "@/app/actions";
import { useUI } from "@/components/shell/ui-context";

export interface CategoryRow {
  id: string;
  name: string;
  icon: string;
  kind: "EXPENSE" | "INCOME";
}

export function Categories({ categories }: { categories: CategoryRow[] }) {
  const { showToast } = useUI();
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"EXPENSE" | "INCOME">("EXPENSE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expense = categories.filter((c) => c.kind === "EXPENSE");
  const income = categories.filter((c) => c.kind === "INCOME");

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await createCategoryAction({ name, kind });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setName("");
    setAdding(false);
    showToast("Category added");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {expense.map((c) => (
          <span key={c.id} className="px-2.5 py-1 rounded-full bg-accsoft text-acc text-[12px] font-semibold">{c.icon} {c.name}</span>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {income.map((c) => (
          <span key={c.id} className="px-2.5 py-1 rounded-full bg-greensoft text-green text-[12px] font-semibold">{c.icon} {c.name}</span>
        ))}
      </div>
      {adding ? (
        <div className="flex items-center gap-2 flex-wrap">
          <input className="field !w-auto min-w-[160px]" value={name} onChange={(e) => setName(e.target.value)} placeholder="Category name" autoFocus />
          <div className="flex gap-1">
            {(["EXPENSE", "INCOME"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className="px-2.5 py-1.5 rounded-lg text-[11.5px] font-semibold cursor-pointer border-none"
                style={{ background: kind === k ? "var(--acc)" : "var(--accSoft)", color: kind === k ? "#fff" : "var(--acc)" }}
              >
                {k === "EXPENSE" ? "Expense" : "Income"}
              </button>
            ))}
          </div>
          <button disabled={busy || !name.trim()} onClick={submit} className="btn-primary disabled:opacity-50">{busy ? "…" : "Add"}</button>
          <button onClick={() => setAdding(false)} className="px-3 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold cursor-pointer">Cancel</button>
          {error && <div className="w-full text-[12px] font-semibold text-red">{error}</div>}
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-acc cursor-pointer self-start hover:bg-accsoft">
          ＋ New category
        </button>
      )}
    </div>
  );
}
