"use client";

// Custom categories (PRD §4.3): view what's seeded, add your own, rename,
// switch Expense ↔ Income, or delete anything (deletion is blocked
// server-side while still in use).

import { useRouter } from "next/navigation";
import { useState } from "react";
import { changeCategoryKindAction, createCategoryAction, deleteCategoryAction, renameCategoryAction } from "@/app/actions";
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
  const [tab, setTab] = useState<"EXPENSE" | "INCOME">("EXPENSE");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const expense = categories.filter((c) => c.kind === "EXPENSE");
  const income = categories.filter((c) => c.kind === "INCOME");
  const shown = tab === "EXPENSE" ? expense : income;

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await createCategoryAction({ name, kind: tab });
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
      <div className="text-[11.5px] text-mut2">Click a category to rename, switch it between Expense and Income, or delete it.</div>

      <div className="flex gap-1 p-1 rounded-[10px] bg-accsoft self-start">
        {(["EXPENSE", "INCOME"] as const).map((k) => (
          <button
            key={k}
            onClick={() => {
              setTab(k);
              setEditingId(null);
              setAdding(false);
            }}
            className="px-3.5 py-1.5 rounded-[8px] text-[12.5px] font-bold cursor-pointer border-none transition-colors"
            style={{ background: tab === k ? "var(--card)" : "transparent", color: tab === k ? (k === "EXPENSE" ? "var(--acc)" : "var(--green)") : "var(--mut)" }}
          >
            {k === "EXPENSE" ? "💸 Expense" : "💼 Income"} <span className="opacity-60">{k === "EXPENSE" ? expense.length : income.length}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {shown.map((c) => (
          <CategoryChip
            key={c.id}
            category={c}
            bg={tab === "EXPENSE" ? "var(--accSoft)" : "var(--greenSoft)"}
            fg={tab === "EXPENSE" ? "var(--acc)" : "var(--green)"}
            open={editingId === c.id}
            onToggle={() => setEditingId(editingId === c.id ? null : c.id)}
          />
        ))}
        {shown.length === 0 && <div className="text-[12px] text-mut2 py-1">No {tab === "EXPENSE" ? "expense" : "income"} categories yet.</div>}
      </div>

      {adding ? (
        <div className="flex items-center gap-2 flex-wrap">
          <input className="field !w-auto min-w-[160px]" value={name} onChange={(e) => setName(e.target.value)} placeholder="Category name" autoFocus />
          <div className="text-[11.5px] text-mut2">as {tab === "EXPENSE" ? "an expense" : "an income"} category</div>
          <button disabled={busy || !name.trim()} onClick={submit} className="btn-primary disabled:opacity-50">{busy ? "…" : "Add"}</button>
          <button onClick={() => setAdding(false)} className="px-3 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold cursor-pointer">Cancel</button>
          {error && <div className="w-full text-[12px] font-semibold text-red">{error}</div>}
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-acc cursor-pointer self-start hover:bg-accsoft">
          ＋ New {tab === "EXPENSE" ? "expense" : "income"} category
        </button>
      )}
    </div>
  );
}

function CategoryChip({
  category,
  bg,
  fg,
  open,
  onToggle,
}: {
  category: CategoryRow;
  bg: string;
  fg: string;
  open: boolean;
  onToggle: () => void;
}) {
  const { showToast } = useUI();
  const router = useRouter();
  const [name, setName] = useState(category.name);
  const [busy, setBusy] = useState(false);
  const [kindBusy, setKindBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        onClick={onToggle}
        className="px-2.5 py-1 rounded-full text-[12px] font-semibold cursor-pointer border-none"
        style={{ background: bg, color: fg }}
      >
        {category.icon} {category.name}
      </button>
    );
  }

  const otherKind = category.kind === "EXPENSE" ? "INCOME" : "EXPENSE";

  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full flex-wrap" style={{ background: bg }}>
      <input
        className="field !w-auto !py-1 !px-2 min-w-[100px]"
        style={{ background: "var(--card)" }}
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        onKeyDown={(e) => e.key === "Escape" && onToggle()}
      />
      <button
        disabled={busy || !name.trim() || name.trim() === category.name}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const res = await renameCategoryAction({ categoryId: category.id, name });
          setBusy(false);
          if (!res.ok) {
            setError(res.error);
            return;
          }
          showToast("Category renamed");
          onToggle();
          router.refresh();
        }}
        className="px-2 py-1 rounded-lg bg-acc text-white text-[11px] font-bold cursor-pointer border-none disabled:opacity-50"
      >
        {busy ? "…" : "Save"}
      </button>
      <button
        disabled={kindBusy}
        title={`Move to ${otherKind === "EXPENSE" ? "Expense" : "Income"} — for categories created under the wrong type`}
        onClick={async () => {
          setKindBusy(true);
          setError(null);
          const res = await changeCategoryKindAction({ categoryId: category.id, kind: otherKind });
          setKindBusy(false);
          if (!res.ok) {
            setError(res.error);
            return;
          }
          showToast(`Moved to ${otherKind === "EXPENSE" ? "Expense" : "Income"}`);
          onToggle();
          router.refresh();
        }}
        className="px-2 py-1 rounded-lg border border-line2 text-[11px] font-semibold cursor-pointer bg-card disabled:opacity-50 whitespace-nowrap"
      >
        {kindBusy ? "…" : `→ ${otherKind === "EXPENSE" ? "Expense" : "Income"}`}
      </button>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const res = await deleteCategoryAction(category.id);
          setBusy(false);
          if (!res.ok) {
            setError(res.error);
            return;
          }
          showToast("Category deleted");
          router.refresh();
        }}
        className="px-2 py-1 rounded-lg border border-line2 text-[11px] font-semibold text-red cursor-pointer bg-card disabled:opacity-50"
      >
        Delete
      </button>
      <button onClick={onToggle} className="px-1.5 py-1 rounded-lg text-[11px] font-semibold cursor-pointer bg-transparent border-none" style={{ color: fg }}>
        ✕
      </button>
      {error && <div className="w-full text-[11.5px] font-semibold text-red">{error}</div>}
    </div>
  );
}
