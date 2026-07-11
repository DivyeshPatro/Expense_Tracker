"use client";

// Custom categories (PRD §4.3): view what's seeded, add your own, rename or
// delete anything (deletion is blocked server-side while still in use).

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createCategoryAction, deleteCategoryAction, renameCategoryAction } from "@/app/actions";
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
  const [editingId, setEditingId] = useState<string | null>(null);

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
      <div className="text-[11.5px] text-mut2">Click a category to rename or delete it.</div>
      <div className="flex flex-wrap gap-1.5">
        {expense.map((c) => (
          <CategoryChip key={c.id} category={c} bg="var(--accSoft)" fg="var(--acc)" open={editingId === c.id} onToggle={() => setEditingId(editingId === c.id ? null : c.id)} />
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {income.map((c) => (
          <CategoryChip key={c.id} category={c} bg="var(--greenSoft)" fg="var(--green)" open={editingId === c.id} onToggle={() => setEditingId(editingId === c.id ? null : c.id)} />
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
