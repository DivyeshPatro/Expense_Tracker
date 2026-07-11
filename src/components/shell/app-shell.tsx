"use client";

// The app chrome, matching the prototype: desktop sidebar + top bar, mobile
// bottom tab bar + "more" sheet, FAB quick-add, ⌘K palette, toasts, modals.

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { CommandPalette } from "./palette";
import { Modals } from "./modals";
import { HeaderPeriodPicker } from "./period-picker";
import { UIProvider, useUI, type RefData } from "./ui-context";

const NAV = [
  { href: "/dashboard", icon: "◧", label: "Dashboard" },
  { href: "/transactions", icon: "⇄", label: "Transactions" },
  { href: "/accounts", icon: "▤", label: "Accounts" },
  { href: "/budgets", icon: "◔", label: "Budgets" },
  { href: "/bills", icon: "▦", label: "Bills" },
  { href: "/shared", icon: "◫", label: "Shared" },
  { href: "/analytics", icon: "◵", label: "Analytics" },
  { href: "/settings", icon: "⚙", label: "Settings" },
];

const TX_SUBS = [
  { label: "All", tab: "" },
  { label: "Expenses", tab: "EXPENSE" },
  { label: "Income", tab: "INCOME" },
  { label: "Transfers", tab: "TRANSFER" },
];

const PERIOD_AWARE_ROUTES = ["/dashboard", "/transactions", "/accounts", "/analytics"];

/** Carries the selected period (?p/&from/&to) along when navigating between period-aware pages, so switching sections doesn't reset back to "this month". */
function withPeriod(href: string, currentSearch: string): string {
  if (!PERIOD_AWARE_ROUTES.some((r) => href.startsWith(r))) return href;
  const cur = new URLSearchParams(currentSearch);
  const keep = new URLSearchParams();
  for (const k of ["p", "from", "to"]) {
    const v = cur.get(k);
    if (v) keep.set(k, v);
  }
  const qs = keep.toString();
  if (!qs) return href;
  return href.includes("?") ? `${href}&${qs}` : `${href}?${qs}`;
}

export function AppShell({ refData, badge, children }: { refData: RefData; badge: number; children: React.ReactNode }) {
  return (
    <UIProvider refData={refData}>
      <ShellInner badge={badge}>{children}</ShellInner>
    </UIProvider>
  );
}

function ShellInner({ badge, children }: { badge: number; children: React.ReactNode }) {
  const { openModal, setPaletteOpen, closeModal, refData } = useUI();
  const pathname = usePathname();
  const title = NAV.find((n) => pathname.startsWith(n.href))?.label ?? (pathname.startsWith("/import") ? "Import data" : "Ledgerly");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
        closeModal();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPaletteOpen, closeModal]);

  return (
    <Suspense fallback={null}>
      <div className="flex min-h-screen">
        <Sidebar badge={badge} userName={refData.userName} />
        <div className="flex-1 min-w-0 flex flex-col">
          {/* top bar */}
          <div className="flex flex-col gap-2 border-b border-line sticky top-0 bg-bg z-30 px-[clamp(14px,2.5vw,28px)] py-3">
          <div className="flex items-center gap-2.5">
            <div className="md:hidden w-[26px] h-[26px] rounded-lg bg-acc grid place-items-center text-white font-extrabold text-[13px]">₹</div>
            <h1 className="text-base font-bold tracking-tight flex-1 m-0">{title}</h1>
            <button
              onClick={() => setPaletteOpen(true)}
              className="hidden md:flex items-center gap-2 px-3 py-[7px] rounded-lg border border-line2 text-[12.5px] font-medium text-mut bg-card cursor-pointer whitespace-nowrap hover:border-acc"
            >
              🔎 Search
              <span className="text-[10.5px] border border-line2 rounded px-[5px] py-px text-mut2">⌘K</span>
            </button>
            <button
              onClick={() => setPaletteOpen(true)}
              aria-label="Search"
              className="md:hidden w-[34px] h-[34px] rounded-[9px] border border-line2 bg-card grid place-items-center text-sm cursor-pointer"
            >
              🔎
            </button>
            <ThemeToggle />
            <button
              onClick={() => openModal("exp")}
              className="btn-primary hidden md:block shadow-[0_2px_8px_color-mix(in_oklab,var(--acc)_40%,transparent)]"
            >
              ＋ Add expense
            </button>
          </div>
          <HeaderPeriodPicker />
          </div>
          {/* content */}
          <div className="flex-1 box-border w-full max-w-[1180px] mx-auto px-[clamp(14px,2.5vw,28px)] py-[clamp(14px,2.5vw,28px)] pb-[120px]">
            {children}
          </div>
        </div>
        <BottomNav badge={badge} />
        <Fab />
        <Modals />
        <CommandPalette />
        <Toast />
      </div>
    </Suspense>
  );
}

function Sidebar({ badge, userName }: { badge: number; userName: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams().toString();

  return (
    <aside className="hidden md:flex w-[216px] flex-none border-r border-line bg-side px-3 py-5 flex-col gap-0.5 sticky top-0 h-screen box-border">
      <div className="flex items-center gap-[9px] px-2 pb-[18px] pt-1">
        <div className="w-7 h-7 rounded-[9px] bg-acc grid place-items-center text-white font-extrabold text-sm">₹</div>
        <div className="font-extrabold text-[15px] tracking-tight">Ledgerly</div>
      </div>
      {NAV.map((n) => {
        const active = pathname.startsWith(n.href);
        return (
          <div key={n.href}>
            <Link
              href={withPeriod(n.href, params)}
              className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] no-underline ${
                active ? "bg-acc text-white font-bold" : "text-mut font-medium hover:bg-accsoft"
              }`}
              style={active ? undefined : { color: "var(--mut)" }}
            >
              <span className="w-4 text-center">{n.icon}</span>
              <span className="flex-1">{n.label}</span>
              {n.href === "/shared" && badge > 0 && !active && (
                <span className="text-[10.5px] bg-redsoft text-red px-[7px] py-0.5 rounded-full font-bold">{badge}</span>
              )}
            </Link>
            {n.href === "/transactions" && active && (
              <div className="flex flex-col gap-px mt-[3px] mb-[5px] ml-[34px]">
                {TX_SUBS.map((s) => {
                  const cur = new URLSearchParams(params).get("tab") ?? "";
                  const on = cur === s.tab;
                  return (
                    <button
                      key={s.label}
                      onClick={() => router.push(withPeriod(s.tab ? `/transactions?tab=${s.tab}` : "/transactions", params))}
                      className={`text-left px-2 py-[5px] rounded-md text-xs cursor-pointer bg-transparent border-none ${
                        on ? "text-acc font-bold" : "text-mut2 font-medium hover:text-ink"
                      }`}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      <div className="flex-1" />
      <div className="flex items-center gap-[9px] px-2.5 py-2 border-t border-line">
        <div className="w-7 h-7 rounded-full bg-accsoft2 grid place-items-center text-[11.5px] font-bold text-acc">
          {userName.charAt(0).toUpperCase()}
        </div>
        <div className="text-[12.5px] font-semibold text-mut flex-1">{userName}</div>
        <button
          onClick={async () => {
            await authClient.signOut();
            window.location.href = "/sign-in";
          }}
          title="Sign out"
          className="text-mut2 hover:text-ink text-[13px] cursor-pointer bg-transparent border-none"
        >
          ⎋
        </button>
      </div>
    </aside>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => setDark(document.documentElement.dataset.theme === "dark"), []);
  return (
    <button
      aria-label="Toggle dark mode"
      onClick={() => {
        const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        document.cookie = `ledgerly-theme=${next};path=/;max-age=31536000`;
        setDark(next === "dark");
      }}
      className="w-[34px] h-[34px] rounded-[9px] border border-line2 bg-card grid place-items-center text-sm cursor-pointer hover:border-acc"
    >
      {dark === null ? "☾" : dark ? "☀" : "☾"}
    </button>
  );
}

const MOBILE_NAV = [
  { href: "/dashboard", icon: "◧", label: "Home" },
  { href: "/transactions", icon: "⇄", label: "Txns" },
  { href: "/shared", icon: "◫", label: "Shared" },
  { href: "/analytics", icon: "◵", label: "Analytics" },
];

function BottomNav({ badge }: { badge: number }) {
  const pathname = usePathname();
  const [sheet, setSheet] = useState(false);
  const params = useSearchParams().toString();
  const moreActive = ["/accounts", "/budgets", "/bills", "/settings", "/import"].some((h) => pathname.startsWith(h));
  return (
    <>
      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-card border-t border-line flex z-40 pb-[env(safe-area-inset-bottom)]">
        {MOBILE_NAV.map((n) => {
          const active = pathname.startsWith(n.href);
          return (
            <Link key={n.href} href={withPeriod(n.href, params)} className="flex-1 flex flex-col items-center gap-[3px] pt-[9px] pb-[7px] min-h-[44px] box-border no-underline relative">
              <span className="text-[17px]" style={{ color: active ? "var(--acc)" : "var(--mut2)" }}>{n.icon}</span>
              <span className="text-[10px] font-semibold" style={{ color: active ? "var(--acc)" : "var(--mut2)" }}>{n.label}</span>
              {n.href === "/shared" && badge > 0 && (
                <span className="absolute top-1 right-[22%] w-2 h-2 rounded-full bg-red" />
              )}
            </Link>
          );
        })}
        <button onClick={() => setSheet(true)} className="flex-1 flex flex-col items-center gap-[3px] pt-[9px] pb-[7px] min-h-[44px] box-border bg-transparent border-none cursor-pointer">
          <span className="text-[17px]" style={{ color: moreActive ? "var(--acc)" : "var(--mut2)" }}>⋯</span>
          <span className="text-[10px] font-semibold" style={{ color: moreActive ? "var(--acc)" : "var(--mut2)" }}>More</span>
        </button>
      </nav>
      {sheet && <MoreSheet close={() => setSheet(false)} params={params} />}
    </>
  );
}

function MoreSheet({ close, params }: { close: () => void; params: string }) {
  const items = [
    { href: "/accounts", icon: "▤", label: "Accounts" },
    { href: "/budgets", icon: "◔", label: "Budgets" },
    { href: "/bills", icon: "▦", label: "Bills" },
    { href: "/settings", icon: "⚙", label: "Settings" },
  ];
  return (
    <div onClick={close} className="fixed inset-0 z-[55] flex items-end" style={{ background: "var(--ov)" }}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full bg-card rounded-t-[18px] px-[18px] pt-[18px] pb-7 box-border flex flex-col gap-1"
        style={{ animation: "rise .22s ease" }}
      >
        <div className="w-[38px] h-1 rounded-sm bg-line2 mx-auto mb-2.5" />
        {items.map((i) => (
          <Link key={i.href} href={withPeriod(i.href, params)} onClick={close} className="flex items-center gap-3 px-2.5 py-[13px] rounded-[10px] text-sm font-semibold no-underline text-ink hover:bg-accsoft">
            <span className="w-5 text-center">{i.icon}</span>
            {i.label}
          </Link>
        ))}
        <ThemeRow close={close} />
      </div>
    </div>
  );
}

function ThemeRow({ close }: { close: () => void }) {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.dataset.theme === "dark"), []);
  return (
    <button
      onClick={() => {
        const next = dark ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        document.cookie = `ledgerly-theme=${next};path=/;max-age=31536000`;
        close();
      }}
      className="flex items-center gap-3 px-2.5 py-[13px] rounded-[10px] text-sm font-semibold cursor-pointer bg-transparent border-none text-ink hover:bg-accsoft w-full"
    >
      <span className="w-5 text-center">{dark ? "☀" : "☾"}</span>
      {dark ? "Light mode" : "Dark mode"}
    </button>
  );
}

function Fab() {
  const { openModal } = useUI();
  const [open, setOpen] = useState(false);
  const items = [
    { icon: "🧾", label: "Expense", act: () => openModal("exp") },
    { icon: "💰", label: "Income", act: () => openModal("inc") },
    { icon: "⇄", label: "Transfer", act: () => openModal("tr") },
    { icon: "👥", label: "Split with friends", act: () => openModal("exp", { split: true }) },
  ];
  return (
    <>
      {open && (
        <div className="fixed right-5 z-[46] flex flex-col gap-2 items-end bottom-[142px] md:bottom-[90px]" style={{ animation: "pop .18s ease" }}>
          {items.map((i) => (
            <button
              key={i.label}
              onClick={() => {
                setOpen(false);
                i.act();
              }}
              className="flex items-center gap-[9px] bg-card border border-line2 px-[15px] py-2.5 rounded-full text-[13px] font-semibold cursor-pointer text-ink"
              style={{ boxShadow: "var(--shLg)" }}
            >
              {i.icon} {i.label}
            </button>
          ))}
        </div>
      )}
      <button
        aria-label="Quick add"
        onClick={() => setOpen((o) => !o)}
        className="fixed right-5 w-[54px] h-[54px] rounded-full bg-acc text-white text-[25px] grid place-items-center cursor-pointer z-[47] select-none border-none bottom-[76px] md:bottom-6 hover:brightness-108"
        style={{ boxShadow: "0 8px 22px color-mix(in oklab, var(--acc) 45%, transparent)" }}
      >
        {open ? "✕" : "＋"}
      </button>
    </>
  );
}

function Toast() {
  const { toast, dismissToast } = useUI();
  if (!toast) return null;
  return (
    <div
      className="fixed bottom-[90px] left-1/2 -translate-x-1/2 px-[17px] py-[11px] rounded-[10px] z-[80] flex items-center gap-3.5 text-[13px] font-semibold whitespace-nowrap"
      style={{ background: "var(--ink)", color: "var(--bg)", boxShadow: "var(--shLg)", animation: "rise .2s ease" }}
    >
      {toast.msg}
      {toast.undo && (
        <button
          onClick={() => {
            toast.undo!();
            dismissToast();
          }}
          className="text-[#7fb0ff] cursor-pointer font-bold bg-transparent border-none text-[13px]"
        >
          Undo
        </button>
      )}
    </div>
  );
}
