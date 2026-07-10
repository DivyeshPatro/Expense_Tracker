"use client";

// ⌘K command palette with "Ask Ledgerly" — the deterministic phrase parser
// answers inline (total + count); clicking opens the filtered transaction list.

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { askLedgerlyAction } from "@/app/actions";
import { useUI } from "./ui-context";

interface PaletteItem {
  icon: string;
  label: string;
  hint: string;
  run: () => void;
}

export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, openModal, refData } = useUI();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [nl, setNl] = useState<{ answer: string; filter: { q: string; tab: string; monthKey: string | null } } | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (paletteOpen) {
      setQ("");
      setNl(null);
    }
  }, [paletteOpen]);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!q.trim()) {
      setNl(null);
      return;
    }
    debounce.current = setTimeout(async () => {
      const res = await askLedgerlyAction(q);
      setNl(res);
    }, 220);
  }, [q]);

  if (!paletteOpen) return null;

  const close = () => setPaletteOpen(false);
  const goTx = (filter: { q: string; tab: string; monthKey: string | null }) => {
    const params = new URLSearchParams();
    if (filter.q) params.set("q", filter.q);
    if (filter.tab) params.set("tab", filter.tab);
    if (filter.monthKey) params.set("month", filter.monthKey);
    router.push(`/transactions?${params.toString()}`);
    close();
  };

  const actions: PaletteItem[] = [
    { icon: "−", label: "Add expense", hint: "", run: () => openModal("exp") },
    { icon: "👥", label: "Add split expense", hint: "", run: () => openModal("exp", { split: true }) },
    { icon: "＋", label: "Add income", hint: "", run: () => openModal("inc") },
    { icon: "⇄", label: "Transfer money", hint: "", run: () => openModal("tr") },
    { icon: "◔", label: "Create budget", hint: "", run: () => openModal("budget") },
    {
      icon: "☾",
      label: "Toggle dark mode",
      hint: "",
      run: () => {
        const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        document.cookie = `ledgerly-theme=${next};path=/;max-age=31536000`;
        close();
      },
    },
    ...["Dashboard", "Transactions", "Accounts", "Budgets", "Bills", "Shared", "Analytics"].map((l) => ({
      icon: "→",
      label: `Go to ${l}`,
      hint: "",
      run: () => {
        router.push(`/${l.toLowerCase()}`);
        close();
      },
    })),
  ];

  const ql = q.trim().toLowerCase();
  let results: PaletteItem[] = actions.filter((a) => !ql || a.label.toLowerCase().includes(ql));
  if (ql) {
    const merchantHits = refData.merchants.filter((m) => m.toLowerCase().includes(ql)).slice(0, 3);
    results = [
      ...merchantHits.map((m) => ({
        icon: "🔎",
        label: `Search “${m}” in transactions`,
        hint: "transactions",
        run: () => goTx({ q: m, tab: "", monthKey: null }),
      })),
      ...results,
    ];
    if (nl) {
      results = [{ icon: "✦", label: nl.answer, hint: "Ask Ledgerly", run: () => goTx(nl.filter) }, ...results];
    }
  }
  results = results.slice(0, 9);

  return (
    <div onClick={close} className="fixed inset-0 z-[70] flex items-start justify-center pt-[8vh] md:pt-[12vh] px-2.5 md:px-4" style={{ background: "var(--ov)" }}>
      <div onClick={(e) => e.stopPropagation()} className="w-[min(560px,100%)] bg-card rounded-[14px] overflow-hidden" style={{ boxShadow: "var(--shLg)", animation: "pop .18s ease" }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && results[0]) results[0].run();
          }}
          placeholder="Ask anything — try ‘swiggy in march’ or ‘upi expenses’…"
          className="w-full box-border px-[18px] py-4 border-0 border-b border-line bg-card text-ink text-[15px] outline-none"
        />
        <div className="max-h-[320px] overflow-auto p-[7px]">
          {results.map((r, i) => (
            <button
              key={i}
              onClick={r.run}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-[9px] cursor-pointer bg-transparent border-none text-left hover:bg-accsoft"
            >
              <span className="w-5 text-center text-sm">{r.icon}</span>
              <span className="flex-1 text-[13.5px] font-semibold text-ink">{r.label}</span>
              <span className="text-[11px] text-mut2">{r.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
