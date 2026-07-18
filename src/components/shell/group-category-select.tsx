"use client";

// group-expenses-sprint: the category picker for a group-tagged expense —
// group-expenses-sprint/rfc §10: a group's own category namespace, never a
// member's personal list. Shared by the create form and both edit forms
// (owner and non-owner) since all three need the identical fetch + "+
// Create New Category" inline-add behavior.

import { useEffect, useState } from "react";
import { createGroupCategoryAction, listGroupCategoriesAction } from "@/app/actions";

const NEW_VALUE = "__new__";

export function GroupCategorySelect({
  groupId,
  value,
  onChange,
}: {
  groupId: string;
  value: string;
  onChange: (categoryId: string) => void;
}) {
  const [categories, setCategories] = useState<{ id: string; name: string; icon: string | null }[]>([]);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listGroupCategoriesAction(groupId).then((cats) => {
      // EXPENSE-only (group-expenses-sprint scope — group income
      // categorization is deliberately out of scope, see GROUP_DEFAULT_CATEGORIES)
      if (!cancelled) setCategories(cats.filter((c) => c.kind === "EXPENSE"));
    });
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  async function handleAdd() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    const res = await createGroupCategoryAction(groupId, trimmed);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (res.category) {
      const created = res.category;
      setCategories((cs) => [...cs.filter((c) => c.id !== created.id), created].sort((a, b) => a.name.localeCompare(b.name)));
      onChange(created.id);
    }
    setAdding(false);
    setNewName("");
  }

  if (adding) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex gap-1.5">
          <input
            className="field flex-1"
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New category name"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleAdd();
              }
              if (e.key === "Escape") {
                setAdding(false);
                setNewName("");
              }
            }}
          />
          <button
            type="button"
            onClick={handleAdd}
            disabled={busy || !newName.trim()}
            className="px-3 rounded-[10px] text-[12.5px] font-bold text-white border-none cursor-pointer disabled:opacity-60"
            style={{ background: "var(--acc)" }}
          >
            {busy ? "…" : "Add"}
          </button>
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setNewName("");
              setError(null);
            }}
            aria-label="Cancel"
            className="px-3 rounded-[10px] text-[12.5px] font-semibold border border-line2 bg-card cursor-pointer"
          >
            ✕
          </button>
        </div>
        {error && <div className="text-[11.5px] font-semibold text-red">{error}</div>}
      </div>
    );
  }

  return (
    <select
      className="field"
      value={value}
      onChange={(e) => (e.target.value === NEW_VALUE ? setAdding(true) : onChange(e.target.value))}
    >
      <option value="">Uncategorized</option>
      {categories.map((c) => (
        <option key={c.id} value={c.id}>
          {c.icon ?? "📦"} {c.name}
        </option>
      ))}
      <option disabled>──────────</option>
      <option value={NEW_VALUE}>+ Create New Category</option>
    </select>
  );
}
