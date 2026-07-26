"use client";

// The app chrome, matching the prototype: desktop sidebar + top bar, mobile
// bottom tab bar + "more" sheet, FAB quick-add, ⌘K palette, toasts, modals.

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { armStuckNavFallback } from "@/lib/resilient-nav";
import { CommandPalette } from "./palette";
import { Modals } from "./modals";
import { OfflineDebug } from "./offline-debug";
import { OfflineProvider, useOffline } from "./offline-context";
import { NotificationBell } from "./notifications";
import { HeaderPeriodPicker } from "./period-picker";
import { UIProvider, useUI, type RefData } from "./ui-context";
import { useFocusTrap } from "./use-focus-trap";

const NAV = [
  { href: "/dashboard", icon: "◧", label: "Dashboard" },
  { href: "/transactions", icon: "⇄", label: "Transactions" },
  { href: "/lending", icon: "🤝", label: "Lending" },
  { href: "/accounts", icon: "▤", label: "Accounts" },
  { href: "/budgets", icon: "◔", label: "Budgets" },
  { href: "/bills", icon: "▦", label: "Bills" },
  { href: "/shared", icon: "◫", label: "Shared" },
  { href: "/activity", icon: "◴", label: "Activity" },
  { href: "/analytics", icon: "◵", label: "Analytics" },
  // Import sits next to Settings rather than up with the money sections: it's a
  // periodic errand, not a daily destination. It was previously reachable only
  // from inside Settings, which is a lot of feature to hide behind one link.
  { href: "/import", icon: "📥", label: "Import" },
  { href: "/settings", icon: "⚙", label: "Settings" },
];

const TX_SUBS = [
  { label: "All", tab: "" },
  { label: "Expenses", tab: "EXPENSE" },
  { label: "Income", tab: "INCOME" },
  { label: "Transfers", tab: "TRANSFER" },
];

const PERIOD_AWARE_ROUTES = ["/dashboard", "/transactions", "/accounts", "/analytics", "/activity", "/lending"];

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

export function AppShell({
  refData,
  badge,
  notifBadge,
  userId,
  children,
}: {
  refData: RefData;
  badge: number;
  notifBadge: number;
  userId: string;
  children: React.ReactNode;
}) {
  return (
    <UIProvider refData={refData}>
      <OfflineProvider userId={userId}>
        <ShellInner badge={badge} notifBadge={notifBadge}>
          {children}
        </ShellInner>
      </OfflineProvider>
    </UIProvider>
  );
}

function ShellInner({ badge, notifBadge, children }: { badge: number; notifBadge: number; children: React.ReactNode }) {
  const { openModal, setPaletteOpen, closeModal, refData } = useUI();
  const pathname = usePathname();
  // /import used to need a special case here because it wasn't in NAV; now that
  // it is, the lookup covers it like every other section.
  const title = NAV.find((n) => pathname.startsWith(n.href))?.label ?? "Ledgerly";

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
    <div className="flex min-h-screen">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-3 focus:py-2 focus:rounded-lg focus:bg-acc focus:text-white focus:text-[13px] focus:font-bold"
      >
        Skip to content
      </a>
      <Sidebar badge={badge} userName={refData.userName} />
      <div className="flex-1 min-w-0 flex flex-col">
        {/* top bar: kept outside the content Suspense boundary so the nav, search,
            and period picker stay immediately interactive while a slower-loading
            page (e.g. Analytics) is still streaming in — see period-picker.tsx */}
        <header className="flex flex-col gap-2 border-b border-line sticky top-0 bg-bg z-30 px-[clamp(14px,2.5vw,28px)] py-3 print:hidden">
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
          <NotificationBell initialUnread={notifBadge} />
          <button
            onClick={() => openModal("exp")}
            className="btn-primary hidden md:block shadow-[0_2px_8px_color-mix(in_oklab,var(--acc)_40%,transparent)]"
          >
            ＋ Add expense
          </button>
        </div>
        <HeaderPeriodPicker />
        </header>
        <AuthExpiredBanner />
        {/* content */}
        <main id="main-content" className="flex-1 box-border w-full max-w-[1180px] mx-auto px-[clamp(14px,2.5vw,28px)] py-[clamp(14px,2.5vw,28px)] pb-[120px]">
          <Suspense fallback={null}>{children}</Suspense>
        </main>
      </div>
      <BottomNav badge={badge} />
      <Fab />
      <Modals />
      <CommandPalette />
      <Toast />
      <OfflineDebug />
    </div>
  );
}

// spec §12 "Session expired at sync time": a banner, not a per-item failure —
// the queue holds untouched (drain() just stops retrying on 401) and nothing
// is lost, so this is purely informational, never blocking.
function AuthExpiredBanner() {
  const { authExpired, pending, needsAttention } = useOffline();
  const count = pending.length + needsAttention.length;
  if (!authExpired || count === 0) return null;
  return (
    <div
      className="flex items-center gap-2.5 px-[clamp(14px,2.5vw,28px)] py-2 text-[12.5px] font-semibold print:hidden"
      style={{ background: "var(--amberSoft)", color: "var(--amber)" }}
    >
      <span className="flex-1">
        Sign in again to sync your {count} change{count === 1 ? "" : "s"}.
      </span>
      <Link href="/sign-in" className="font-bold no-underline whitespace-nowrap" style={{ color: "var(--amber)" }}>
        Sign in
      </Link>
    </div>
  );
}

function Sidebar({ badge, userName }: { badge: number; userName: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams().toString();

  return (
    <aside className="hidden md:flex w-[216px] flex-none border-r border-line bg-side px-3 py-5 flex-col gap-0.5 sticky top-0 h-screen box-border print:hidden">
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
              onClick={() => armStuckNavFallback(withPeriod(n.href, params))}
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

// lending-module-phase1: a genuine 6th primary slot (3 left + FAB + 2 right),
// not tucked into the More sheet — Lending is as prominent as Transactions.
const MOBILE_NAV_LEFT = [
  { href: "/dashboard", icon: "◧", label: "Home" },
  { href: "/transactions", icon: "⇄", label: "Txns" },
  { href: "/lending", icon: "🤝", label: "Lending" },
];
const MOBILE_NAV_RIGHT = [{ href: "/analytics", icon: "◵", label: "Analytics" }];

/** Escape-to-close for the sheet-style overlays below — MoreSheet and QuickAddSheet
 * both own local open/close state (not the global modal/palette in useUI()), so the
 * shell's global keydown handler can't reach them; each sheet arms its own listener. */
function useEscapeToClose(close: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
}

function BottomNav({ badge }: { badge: number }) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const params = useSearchParams().toString();
  const { needsAttention } = useOffline();
  // needs-attention rides the same red-dot convention as the shared-balance
  // badge (spec §7: bottom nav shows nothing for routine pending, but the
  // existing More red-dot for needs-attention)
  const showDot = badge > 0 || needsAttention.length > 0;
  const moreActive = ["/accounts", "/budgets", "/bills", "/settings", "/import", "/shared", "/activity"].some((h) => pathname.startsWith(h));
  return (
    <>
      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-card border-t border-line flex z-40 pb-[env(safe-area-inset-bottom)] print:hidden">
        {MOBILE_NAV_LEFT.map((n) => {
          const active = pathname.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={withPeriod(n.href, params)}
              onClick={() => armStuckNavFallback(withPeriod(n.href, params))}
              className="flex-1 flex flex-col items-center gap-[3px] pt-[9px] pb-[7px] min-h-[44px] box-border no-underline relative"
            >
              <span className="text-[17px]" style={{ color: active ? "var(--acc)" : "var(--mut2)" }}>{n.icon}</span>
              <span className="text-[10px] font-semibold" style={{ color: active ? "var(--acc)" : "var(--mut2)" }}>{n.label}</span>
            </Link>
          );
        })}
        <div className="flex-1 flex flex-col items-center justify-end pb-[7px]">
          <button
            aria-label="Quick add"
            onClick={() => setQuickAddOpen(true)}
            className="w-[52px] h-[52px] -mt-[24px] rounded-full bg-acc text-white text-[26px] grid place-items-center cursor-pointer border-none select-none hover:brightness-108"
            style={{ boxShadow: "0 6px 16px color-mix(in oklab, var(--acc) 50%, transparent)" }}
          >
            ＋
          </button>
        </div>
        {MOBILE_NAV_RIGHT.map((n) => {
          const active = pathname.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={withPeriod(n.href, params)}
              onClick={() => armStuckNavFallback(withPeriod(n.href, params))}
              className="flex-1 flex flex-col items-center gap-[3px] pt-[9px] pb-[7px] min-h-[44px] box-border no-underline relative"
            >
              <span className="text-[17px]" style={{ color: active ? "var(--acc)" : "var(--mut2)" }}>{n.icon}</span>
              <span className="text-[10px] font-semibold" style={{ color: active ? "var(--acc)" : "var(--mut2)" }}>{n.label}</span>
            </Link>
          );
        })}
        <button onClick={() => setMoreOpen(true)} className="flex-1 flex flex-col items-center gap-[3px] pt-[9px] pb-[7px] min-h-[44px] box-border bg-transparent border-none cursor-pointer relative">
          <span className="text-[17px]" style={{ color: moreActive ? "var(--acc)" : "var(--mut2)" }}>⋯</span>
          <span className="text-[10px] font-semibold" style={{ color: moreActive ? "var(--acc)" : "var(--mut2)" }}>More</span>
          {showDot && <span className="absolute top-1 right-[26%] w-2 h-2 rounded-full bg-red" />}
        </button>
      </nav>
      {quickAddOpen && <QuickAddSheet close={() => setQuickAddOpen(false)} />}
      {moreOpen && <MoreSheet close={() => setMoreOpen(false)} params={params} badge={badge} />}
    </>
  );
}

function QuickAddSheet({ close }: { close: () => void }) {
  const { openModal } = useUI();
  const panelRef = useRef<HTMLDivElement>(null);
  useEscapeToClose(close);
  useFocusTrap(panelRef, true);
  useEffect(() => panelRef.current?.focus(), []);
  const items = [
    { icon: "🧾", label: "Expense", act: () => openModal("exp") },
    { icon: "💰", label: "Income", act: () => openModal("inc") },
    { icon: "⇄", label: "Transfer", act: () => openModal("tr") },
    { icon: "👥", label: "Split with friends", act: () => openModal("exp", { split: true }) },
    { icon: "🤝", label: "Lending entry", act: () => openModal("lendingEntry") },
  ];
  return (
    <div onClick={close} className="fixed inset-0 z-[55] flex items-end" style={{ background: "var(--ov)" }}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Quick add"
        onClick={(e) => e.stopPropagation()}
        className="w-full bg-card rounded-t-[18px] px-[18px] pt-[18px] pb-7 box-border flex flex-col gap-1 outline-none"
        style={{ animation: "rise .22s ease", paddingBottom: "calc(28px + env(safe-area-inset-bottom))" }}
      >
        <div className="w-[38px] h-1 rounded-sm bg-line2 mx-auto mb-2.5" />
        {items.map((i) => (
          <button
            key={i.label}
            onClick={() => {
              close();
              i.act();
            }}
            className="flex items-center gap-3 px-2.5 py-[13px] rounded-[10px] text-sm font-semibold text-left cursor-pointer bg-transparent border-none text-ink hover:bg-accsoft w-full min-h-[44px]"
          >
            <span className="w-5 text-center text-[16px]">{i.icon}</span>
            {i.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function MoreSheet({ close, params, badge }: { close: () => void; params: string; badge: number }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { pending, needsAttention } = useOffline();
  useEscapeToClose(close);
  useFocusTrap(panelRef, true);
  useEffect(() => panelRef.current?.focus(), []);
  const items = [
    { href: "/shared", icon: "◫", label: "Shared" },
    { href: "/activity", icon: "◴", label: "Activity" },
    { href: "/accounts", icon: "▤", label: "Accounts" },
    { href: "/budgets", icon: "◔", label: "Budgets" },
    { href: "/bills", icon: "▦", label: "Bills" },
    { href: "/import", icon: "📥", label: "Import" },
    { href: "/settings", icon: "⚙", label: "Settings" },
  ];
  // spec §7 "More sheet / Settings row" — same three-state copy as the Sync Center hero
  const syncLabel =
    needsAttention.length > 0
      ? `Sync — ${needsAttention.length} need${needsAttention.length === 1 ? "s" : ""} attention`
      : pending.length > 0
        ? `Sync — ${pending.length} waiting`
        : "Sync — Up to date ✓";
  return (
    <div onClick={close} className="fixed inset-0 z-[55] flex items-end" style={{ background: "var(--ov)" }}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="More"
        onClick={(e) => e.stopPropagation()}
        className="w-full bg-card rounded-t-[18px] px-[18px] pt-[18px] pb-7 box-border flex flex-col gap-1 outline-none"
        style={{ animation: "rise .22s ease", paddingBottom: "calc(28px + env(safe-area-inset-bottom))" }}
      >
        <div className="w-[38px] h-1 rounded-sm bg-line2 mx-auto mb-2.5" />
        {items.map((i) => (
          <Link
            key={i.href}
            href={withPeriod(i.href, params)}
            onClick={() => {
              close();
              armStuckNavFallback(withPeriod(i.href, params));
            }}
            className="flex items-center gap-3 px-2.5 py-[13px] rounded-[10px] text-sm font-semibold no-underline text-ink hover:bg-accsoft"
          >
            <span className="w-5 text-center">{i.icon}</span>
            <span className="flex-1">{i.label}</span>
            {i.href === "/shared" && badge > 0 && (
              <span className="text-[10.5px] bg-redsoft text-red px-[7px] py-0.5 rounded-full font-bold">{badge}</span>
            )}
          </Link>
        ))}
        <Link
          href="/settings/sync"
          onClick={() => {
            close();
            armStuckNavFallback("/settings/sync");
          }}
          className="flex items-center gap-3 px-2.5 py-[13px] rounded-[10px] text-sm font-semibold no-underline hover:bg-accsoft"
          style={{ color: needsAttention.length > 0 ? "var(--red)" : "var(--ink)" }}
        >
          <span className="w-5 text-center">⟲</span>
          <span className="flex-1">{syncLabel}</span>
          {needsAttention.length > 0 && <span className="w-2 h-2 rounded-full bg-red" />}
        </Link>
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

// Desktop-only quick-add chooser. On mobile this is replaced by the center
// nav button + QuickAddSheet, so the floating corner FAB is hidden there
// rather than duplicating it — see BottomNav above.
function Fab() {
  const { openModal } = useUI();
  const [open, setOpen] = useState(false);
  const items = [
    { icon: "🧾", label: "Expense", act: () => openModal("exp") },
    { icon: "💰", label: "Income", act: () => openModal("inc") },
    { icon: "⇄", label: "Transfer", act: () => openModal("tr") },
    { icon: "👥", label: "Split with friends", act: () => openModal("exp", { split: true }) },
    { icon: "🤝", label: "Lending entry", act: () => openModal("lendingEntry") },
  ];
  return (
    <>
      {open && (
        <div className="hidden md:flex fixed right-5 z-[46] flex-col gap-2 items-end bottom-[90px]" style={{ animation: "pop .18s ease" }}>
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
        aria-label="Quick add (desktop)"
        onClick={() => setOpen((o) => !o)}
        className="hidden md:grid fixed right-5 w-[54px] h-[54px] rounded-full bg-acc text-white text-[25px] place-items-center cursor-pointer z-[47] select-none border-none bottom-6 hover:brightness-108 print:hidden"
        style={{ boxShadow: "0 8px 22px color-mix(in oklab, var(--acc) 45%, transparent)" }}
      >
        {open ? "✕" : "＋"}
      </button>
    </>
  );
}

function Toast() {
  const { toast, dismissToast } = useUI();
  // The aria-live region itself has to be in the DOM *before* its content
  // changes for screen readers to reliably announce it — a live region that
  // only mounts once a toast exists misses that toast's own announcement.
  // So this wrapper is always rendered; only the message inside is conditional.
  return (
    <div aria-live="polite" role="status" className="fixed bottom-[90px] left-1/2 -translate-x-1/2 z-[80]">
      {toast && (
        <div
          className="px-[17px] py-[11px] rounded-[10px] flex items-center gap-3.5 text-[13px] font-semibold whitespace-nowrap"
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
      )}
    </div>
  );
}
