"use client";

// ⌘K unified search (Phase 2.5) — one bar, categorized results across every
// module: the deterministic "Ask Ledgerly" answer, contacts (with lending/
// shared context), transactions (merchant hits), accounts, bills, groups,
// plus the pre-existing quick actions. Keyboard: ↑/↓ move, Enter runs the
// highlighted result, Escape closes (handled in app-shell).

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { unifiedSearchAction } from "@/app/actions";
import { formatPaise } from "@/lib/money";
import type { UnifiedResults } from "@/server/services/search";
import { useUI } from "./ui-context";

interface PaletteItem {
  icon: string;
  label: string;
  hint: string;
  run: () => void;
}

interface Section {
  title: string | null; // null ⇒ no header (the ✦ answer row)
  items: PaletteItem[];
}

const EMPTY: UnifiedResults = { contacts: [], accounts: [], bills: [], groups: [], merchants: [], nl: null };

export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, openModal } = useUI();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [res, setRes] = useState<UnifiedResults>(EMPTY);
  const [active, setActive] = useState(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (paletteOpen) {
      setQ("");
      setRes(EMPTY);
      setActive(0);
    }
  }, [paletteOpen]);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!q.trim()) {
      setRes(EMPTY);
      setActive(0);
      return;
    }
    debounce.current = setTimeout(async () => {
      setRes(await unifiedSearchAction(q));
      setActive(0);
    }, 220);
  }, [q]);

  if (!paletteOpen) return null;

  const close = () => setPaletteOpen(false);
  const go = (href: string) => {
    router.push(href);
    close();
  };
  const goTx = (filter: { q: string; tab: string; monthKey: string | null }) => {
    const params = new URLSearchParams();
    if (filter.q) params.set("q", filter.q);
    if (filter.tab) params.set("tab", filter.tab);
    if (filter.monthKey) params.set("month", filter.monthKey);
    go(`/transactions?${params.toString()}`);
  };

  const actions: PaletteItem[] = [
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
    ...["Dashboard", "Transactions", "Accounts", "Cards", "Budgets", "Bills", "Shared", "Lending", "Analytics", "Activity"].map((l) => ({
      icon: "→",
      label: `Go to ${l}`,
      hint: "",
      run: () => go(`/${l.toLowerCase()}`),
    })),
  ];

  const ql = q.trim().toLowerCase();
  const sections: Section[] = [];

  if (ql && res.nl) {
    const nl = res.nl;
    sections.push({ title: null, items: [{ icon: "✦", label: nl.answer, hint: "Ask Ledgerly", run: () => goTx(nl.filter) }] });
  }
  if (res.contacts.length > 0) {
    sections.push({
      title: "Contacts",
      items: res.contacts.map((c) => ({
        icon: "👤",
        label: c.name,
        hint: [
          c.lendingNet > 0 ? `owes you ${formatPaise(c.lendingNet)}` : c.lendingNet < 0 ? `you owe ${formatPaise(-c.lendingNet)}` : "",
          c.hasShared ? "shared" : "",
        ]
          .filter(Boolean)
          .join(" · "),
        run: () => go(`/lending?contact=${c.id}`),
      })),
    });
  }
  if (ql && res.merchants.length > 0) {
    sections.push({
      title: "Transactions",
      items: res.merchants.slice(0, 3).map((m) => ({
        icon: "🔎",
        label: `Search “${m}” in transactions`,
        hint: "",
        run: () => goTx({ q: m, tab: "", monthKey: null }),
      })),
    });
  }
  if (res.accounts.length > 0) {
    sections.push({
      title: "Accounts",
      items: res.accounts.map((a) => ({
        icon: a.icon,
        label: a.name,
        hint: `${a.balance < 0 ? "−" : ""}${formatPaise(a.balance)}`,
        run: () => go("/accounts"),
      })),
    });
  }
  if (res.bills.length > 0) {
    sections.push({
      title: "Bills",
      items: res.bills.map((b) => ({
        icon: "🧾",
        label: b.name,
        hint: `${formatPaise(b.amount)} · ${b.dueLabel.toLowerCase()}`,
        run: () => go("/bills"),
      })),
    });
  }
  if (res.groups.length > 0) {
    sections.push({
      title: "Groups",
      items: res.groups.map((g) => ({
        icon: "👥",
        label: g.name,
        hint: `${g.memberCount} member${g.memberCount === 1 ? "" : "s"}`,
        run: () => go("/shared"),
      })),
    });
  }
  const matchingActions = actions.filter((a) => !ql || a.label.toLowerCase().includes(ql));
  if (matchingActions.length > 0) {
    sections.push({ title: ql ? "Actions" : null, items: matchingActions });
  }

  // flatten for keyboard navigation; cap total rows to keep the list scannable
  const flat: PaletteItem[] = [];
  const capped: Section[] = [];
  for (const s of sections) {
    if (flat.length >= 12) break;
    const items = s.items.slice(0, 12 - flat.length);
    flat.push(...items);
    capped.push({ title: s.title, items });
  }
  const activeIdx = Math.min(active, Math.max(0, flat.length - 1));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((v) => Math.min(v + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((v) => Math.max(v - 1, 0));
    } else if (e.key === "Enter" && flat[activeIdx]) {
      flat[activeIdx].run();
    }
  };

  let rendered = -1;
  return (
    <div onClick={close} className="fixed inset-0 z-[70] flex items-start justify-center pt-[8vh] md:pt-[12vh] px-2.5 md:px-4" style={{ background: "var(--ov)" }}>
      <div onClick={(e) => e.stopPropagation()} className="w-[min(560px,100%)] bg-card rounded-[14px] overflow-hidden" style={{ boxShadow: "var(--shLg)", animation: "pop .18s ease" }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
          onKeyDown={onKeyDown}
          aria-label="Search everything"
          placeholder="Search contacts, bills, accounts — or ask ‘swiggy in march’…"
          className="w-full box-border px-[18px] py-4 border-0 border-b border-line bg-card text-ink text-[15px] outline-none"
        />
        <div ref={listRef} className="max-h-[360px] overflow-auto p-[7px]" role="listbox" aria-label="Search results">
          {capped.map((s, si) => (
            <div key={si}>
              {s.title && (
                <div className="text-[10px] font-bold text-mut2 tracking-[.06em] uppercase px-3 pt-2 pb-1">{s.title}</div>
              )}
              {s.items.map((r) => {
                rendered++;
                const idx = rendered;
                const isActive = idx === activeIdx;
                return (
                  <button
                    key={`${si}-${r.label}`}
                    onClick={r.run}
                    onMouseEnter={() => setActive(idx)}
                    role="option"
                    aria-selected={isActive}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-[9px] cursor-pointer border-none text-left"
                    style={{ background: isActive ? "var(--accSoft)" : "transparent" }}
                  >
                    <span className="w-5 text-center text-sm">{r.icon}</span>
                    <span className="flex-1 text-[13.5px] font-semibold text-ink truncate">{r.label}</span>
                    <span className="text-[11px] text-mut2 flex-none">{r.hint}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {flat.length === 0 && <div className="px-3 py-6 text-center text-[12.5px] text-mut2">No matches — try a different search.</div>}
        </div>
      </div>
    </div>
  );
}
