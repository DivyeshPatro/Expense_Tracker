"use client";

// The app chrome, matching the prototype: desktop sidebar + top bar, mobile
// bottom tab bar + "more" sheet, FAB quick-add, ⌘K palette, toasts, modals.

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { armStuckNavFallback } from "@/lib/resilient-nav";
import { applyAppearance, DEFAULT_SKIN, isSkin } from "@/lib/theme";
import { BrandMark } from "./brand-mark";
import { CommandPalette } from "./palette";
import { Modals } from "./modals";
import { OfflineDebug } from "./offline-debug";
import { OfflineProvider, useOffline } from "./offline-context";
import { NotificationBell } from "./notifications";
import { HeaderPeriodPicker } from "./period-picker";
import { UIProvider, useUI, type ModalPrefill, type ModalType, type RefData } from "./ui-context";
import { useNavPrefs } from "./use-nav-prefs";
import { NavGlyph } from "./nav-glyph";
import { bottomNav, sidebarItems, NAV_ITEMS, TIER_LABEL } from "@/lib/nav-prefs";
import { BottomSheet } from "./bottom-sheet";
import { NavProgressProvider, useStartNavProgress } from "./nav-progress";

// #201: the shell used to carry its own parallel catalogue here, with its own
// labels and its own emoji icon set — which is how four routes ended up with
// two names each ("Khata" in the tab bar, "Lending" in the header directly
// above it). NAV_ITEMS is now the only catalogue, and NavGlyph the only icon
// set, so the two surfaces cannot disagree again.

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
        <NavProgressProvider>
          <ShellInner badge={badge} notifBadge={notifBadge}>
            {children}
          </ShellInner>
        </NavProgressProvider>
      </OfflineProvider>
    </UIProvider>
  );
}

function ShellInner({ badge, notifBadge, children }: { badge: number; notifBadge: number; children: React.ReactNode }) {
  const { openModal, setPaletteOpen, closeModal, refData } = useUI();
  const pathname = usePathname();
  // #201: one catalogue, so the header title and the tab label are the same string
  const title = NAV_ITEMS.find((n) => pathname.startsWith(n.id))?.label ?? "Ledgerly";

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
          <BrandMark size={26} className="md:hidden" />
          <span className="sr-only md:hidden">Ledgerly</span>
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
            className="md:hidden w-11 h-11 rounded-[11px] border border-line2 bg-card grid place-items-center text-sm cursor-pointer"
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
  const startNav = useStartNavProgress();
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams().toString();
  const { prefs } = useNavPrefs();
  // #201/#202: follows the user's own order + visibility, from the one
  // catalogue, and groups by tier with a hairline divider so the sidebar reads
  // as "what I use daily / weekly / rarely" instead of twelve equal rows.
  const items = sidebarItems(prefs);

  return (
    <aside className="hidden md:flex w-[216px] flex-none border-r border-line bg-side px-3 py-5 flex-col gap-0.5 sticky top-0 h-screen box-border print:hidden">
      <div className="flex items-center gap-[9px] px-2 pb-[18px] pt-1">
        <BrandMark size={28} />
        <div className="font-extrabold text-[15px] tracking-tight">Ledgerly</div>
      </div>
      {items.map((n, i) => {
        const active = pathname.startsWith(n.id);
        // a divider wherever the tier changes (#202)
        const newTier = i > 0 && n.tier !== items[i - 1].tier;
        return (
          <div key={n.id}>
            {newTier && (
              <div className="px-2.5 pt-3 pb-1 text-[10px] font-bold uppercase tracking-[.1em] text-mut2 border-t border-line mt-2">
                {TIER_LABEL[n.tier]}
              </div>
            )}
            <Link
              href={withPeriod(n.id, params)}
              onClick={() => { startNav(); armStuckNavFallback(withPeriod(n.id, params)); }}
              className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] no-underline min-h-[40px] ${
                active ? "bg-acc text-white font-bold" : "text-mut font-medium hover:bg-accsoft"
              }`}
              style={active ? undefined : { color: "var(--mut)" }}
            >
              <span className="w-[22px] grid place-items-center flex-none"><NavGlyph id={n.icon} /></span>
              <span className="flex-1">{n.label}</span>
              {n.id === "/shared" && badge > 0 && !active && (
                <span className="text-[10.5px] bg-redsoft text-red px-[7px] py-0.5 rounded-full font-bold">{badge}</span>
              )}
            </Link>
            {n.id === "/transactions" && active && (
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
        const skin = isSkin(document.documentElement.dataset.skin) ? document.documentElement.dataset.skin! : DEFAULT_SKIN;
        applyAppearance(next, skin);
        setDark(next === "dark");
      }}
      className="w-11 h-11 rounded-[11px] border border-line2 bg-card grid place-items-center text-sm cursor-pointer hover:border-acc"
    >
      {dark === null ? "☾" : dark ? "☀" : "☾"}
    </button>
  );
}


function BottomNav({ badge }: { badge: number }) {
  const startNav = useStartNavProgress();
  const pathname = usePathname();
  const { openModal } = useUI();
  const { prefs } = useNavPrefs();
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const params = useSearchParams().toString();
  const { needsAttention } = useOffline();
  // Context-aware quick add: options follow the current module; null hides the
  // FAB entirely on view-only screens (Dashboard, Audit Log, Settings, Import).
  const fab = quickAddConfig(pathname, openModal);
  // Per-device customised tab set: the first N in the bar, the rest under More.
  const { visible, more } = bottomNav(prefs);
  const moreActive = more.some((m) => pathname.startsWith(m.id));
  const showDot = badge > 0 || needsAttention.length > 0;
  const scrollerRef = useRef<HTMLDivElement>(null);
  // scroll-hint: fade only the edge that still has hidden items, so the
  // horizontal row reads as scrollable without a permanent gradient lying
  // about content that isn't there.
  const [edges, setEdges] = useState({ left: false, right: true });
  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  };
  useEffect(() => {
    onScroll();
    window.addEventListener("resize", onScroll);
    return () => window.removeEventListener("resize", onScroll);
  }, []);
  // keep the active tab in view when you land on a section deep in the row
  useEffect(() => {
    scrollerRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [pathname]);

  return (
    <>
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 border-t border-line z-40 pb-[env(safe-area-inset-bottom)] print:hidden"
        style={{ background: "color-mix(in oklab, var(--card) 84%, transparent)", backdropFilter: "saturate(1.4) blur(18px)", WebkitBackdropFilter: "saturate(1.4) blur(18px)" }}
      >
        {/* Every section, in one horizontally-scrollable row. The center FAB
            floats fully above the bar, so the row keeps the full width and no
            tab hides behind it. */}
        <div ref={scrollerRef} onScroll={onScroll} className="flex overflow-x-auto no-scrollbar px-1.5" style={{ scrollbarWidth: "none" }}>
          {visible.map((n) => {
            const active = pathname.startsWith(n.id);
            return (
              <Link
                key={n.id}
                href={withPeriod(n.id, params)}
                onClick={() => { startNav(); armStuckNavFallback(withPeriod(n.id, params)); }}
                aria-current={active ? "page" : undefined}
                className="flex-1 min-w-[58px] flex flex-col items-center gap-[3px] pt-2 pb-1.5 min-h-[56px] box-border no-underline"
              >
                <span
                  className="relative grid place-items-center w-[46px] h-[26px] rounded-full transition-colors"
                  style={{ background: active ? "var(--accSoft2)" : "transparent", color: active ? "var(--acc)" : "var(--mut2)" }}
                >
                  <NavGlyph id={n.icon} />
                  {showDot && n.id === "/settings" && <span className="absolute top-0 right-2 w-2 h-2 rounded-full bg-red ring-2 ring-[var(--card)]" />}
                </span>
                <span className="text-[9.5px] font-semibold" style={{ color: active ? "var(--acc)" : "var(--mut2)" }}>{n.label}</span>
              </Link>
            );
          })}
          {more.length > 0 && (
            <button
              onClick={() => setMoreOpen(true)}
              aria-label="More sections"
              aria-haspopup="dialog"
              className="flex-1 min-w-[58px] flex flex-col items-center gap-[3px] pt-2 pb-1.5 min-h-[56px] box-border bg-transparent border-none cursor-pointer"
            >
              <span
                className="relative grid place-items-center w-[46px] h-[26px] rounded-full transition-colors"
                style={{ background: moreActive ? "var(--accSoft2)" : "transparent", color: moreActive ? "var(--acc)" : "var(--mut2)" }}
              >
                <NavGlyph id="more" />
                {showDot && more.some((m) => m.id === "/settings") && <span className="absolute top-0 right-2 w-2 h-2 rounded-full bg-red ring-2 ring-[var(--card)]" />}
              </span>
              <span className="text-[9.5px] font-semibold" style={{ color: moreActive ? "var(--acc)" : "var(--mut2)" }}>More</span>
            </button>
          )}
        </div>
        {/* Edge scroll-hints — each fades in only while that side has more. */}
        <div className="pointer-events-none absolute top-0 bottom-0 left-0 w-7 transition-opacity" style={{ background: "linear-gradient(to right, var(--card), transparent)", opacity: edges.left ? 1 : 0 }} />
        <div className="pointer-events-none absolute top-0 bottom-0 right-0 w-7 transition-opacity" style={{ background: "linear-gradient(to left, var(--card), transparent)", opacity: edges.right ? 1 : 0 }} />
        {/* Center quick-add, docked above the bar with a ground ring so it reads
            as raised. Hidden on view-only screens; a single-action module fires
            straight away, a multi-action one opens the context menu. */}
        {fab && (
          <button
            aria-label={fab.actions.length === 1 ? fab.actions[0].label : `${fab.label} — quick add`}
            onClick={() => (fab.actions.length === 1 ? fab.actions[0].run() : setQuickAddOpen(true))}
            className="absolute left-1/2 -translate-x-1/2 -top-[46px] w-[58px] h-[58px] rounded-full text-white grid place-items-center cursor-pointer border-none select-none active:scale-95 transition-transform"
            style={{ background: "linear-gradient(150deg, var(--acc), color-mix(in oklab, var(--acc) 58%, #7a3cff))", boxShadow: "0 14px 28px -8px color-mix(in oklab, var(--acc) 72%, transparent), 0 0 0 6px var(--bg)" }}
          >
            <svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        )}
      </nav>
      {quickAddOpen && fab && <QuickAddSheet label={fab.label} actions={fab.actions} close={() => setQuickAddOpen(false)} />}
      {moreOpen && <MoreSheet items={more} params={params} close={() => setMoreOpen(false)} />}
    </>
  );
}

function MoreSheet({ items, params, close }: { items: { id: string; icon: string; label: string }[]; params: string; close: () => void }) {
  const startNav = useStartNavProgress();
  const pathname = usePathname();
  return (
    <BottomSheet onClose={close} label="More sections" className="gap-1">
      <h2 className="text-[12px] font-bold text-mut2 uppercase tracking-wide px-1 pb-1">More</h2>
      <div className="grid grid-cols-4 gap-1.5">
        {items.map((n) => {
          const active = pathname.startsWith(n.id);
          return (
            <Link
              key={n.id}
              href={withPeriod(n.id, params)}
              onClick={() => {
                startNav();
                armStuckNavFallback(withPeriod(n.id, params));
                close();
              }}
              aria-current={active ? "page" : undefined}
              className="flex flex-col items-center gap-1.5 py-3 rounded-[12px] no-underline border border-line2 min-h-[64px] justify-center"
              style={{ background: active ? "var(--accSoft)" : "var(--card)", color: active ? "var(--acc)" : "var(--ink)" }}
            >
              <NavGlyph id={n.icon} />
              <span className="text-[11px] font-semibold">{n.label}</span>
            </Link>
          );
        })}
      </div>
    </BottomSheet>
  );
}

type QuickAction = { icon: string; label: string; run: () => void };

/** Context-aware Quick Add (v2.0): the FAB's options follow the module you're
 *  in. Returns null on view-only screens (Dashboard, Audit Log, Settings,
 *  Import) where the FAB is hidden entirely. The first action is the primary
 *  one; a single action fires on tap, several open the menu. */
function quickAddConfig(pathname: string, openModal: (t: ModalType, p?: ModalPrefill) => void): { label: string; actions: QuickAction[] } | null {
  const at = (s: string) => pathname.startsWith(s);
  // Card creation deliberately lives on the /cards route (it holds a decrypted
  // CVV — see cards/card-dialog.tsx), so the FAB signals it via an event the
  // route-local Add Card button listens for, rather than a global modal.
  const openCard = () => window.dispatchEvent(new CustomEvent("ledgerly:add-card"));
  if (at("/transactions"))
    return {
      label: "Add expense",
      actions: [
        { icon: "🧾", label: "Add expense", run: () => openModal("exp") },
        { icon: "💰", label: "Add income", run: () => openModal("inc") },
        { icon: "⇄", label: "Transfer money", run: () => openModal("tr") },
      ],
    };
  if (at("/lending"))
    return {
      label: "Lending",
      actions: [
        { icon: "💸", label: "You gave money", run: () => openModal("lendingEntry", { loanKind: "GAVE" }) },
        { icon: "💰", label: "You got money", run: () => openModal("lendingEntry", { loanKind: "GOT" }) },
      ],
    };
  if (at("/shared")) return { label: "Add shared expense", actions: [{ icon: "👥", label: "Add shared expense", run: () => openModal("exp", { split: true }) }] };
  if (at("/cards")) return { label: "Add card", actions: [{ icon: "💳", label: "Add credit card", run: openCard }] };
  if (at("/bills")) return { label: "Add bill", actions: [{ icon: "🧾", label: "Add bill", run: () => openModal("bill") }] };
  if (at("/budgets")) return { label: "Add budget", actions: [{ icon: "◔", label: "Add budget", run: () => openModal("budget") }] };
  // #209: the Accounts header used to carry "＋ Add account" and "⇄ Transfer
  // money" as buttons. The header is gone (the total leads the screen now), so
  // both live here — Transfer especially must not lose its entry point.
  if (at("/accounts"))
    return {
      label: "Accounts",
      actions: [
        { icon: "⇄", label: "Transfer money", run: () => openModal("tr") },
        { icon: "🏦", label: "Add account", run: () => openModal("account") },
      ],
    };
  // #203: Home used to return null here, so the largest, brightest control in
  // the mobile UI vanished on the screen people open most — and the bar does
  // not reserve its slot, so it left a visible hole where users had learned to
  // tap. Home now offers the same three money actions as Transactions.
  if (at("/dashboard"))
    return {
      label: "Add",
      actions: [
        { icon: "🧾", label: "Add expense", run: () => openModal("exp") },
        { icon: "💰", label: "Add income", run: () => openModal("inc") },
        { icon: "⇄", label: "Transfer money", run: () => openModal("tr") },
      ],
    };
  return null; // activity, settings, import → view-only, no FAB
}

function QuickAddSheet({ label, actions, close }: { label: string; actions: QuickAction[]; close: () => void }) {
  return (
    <BottomSheet onClose={close} label={label} className="gap-1">
      {actions.map((a) => (
        <button
          key={a.label}
          onClick={() => {
            close();
            a.run();
          }}
          className="flex items-center gap-3 px-2.5 py-[13px] rounded-[10px] text-sm font-semibold text-left cursor-pointer bg-transparent border-none text-ink hover:bg-accsoft w-full min-h-[44px]"
        >
          <span className="w-5 text-center text-[16px]">{a.icon}</span>
          {a.label}
        </button>
      ))}
    </BottomSheet>
  );
}

/** Desktop quick-add — same context-aware config, bottom-right. Hidden on
 *  view-only routes. A single action fires on click; several expand upward. */
function Fab() {
  const { openModal } = useUI();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const cfg = quickAddConfig(pathname, openModal);
  useEffect(() => setOpen(false), [pathname]); // collapse when the module changes
  if (!cfg) return null;
  const single = cfg.actions.length === 1;
  return (
    <>
      {open && !single && (
        <div className="hidden md:flex fixed right-5 z-[46] flex-col gap-2 items-end bottom-[90px]" style={{ animation: "pop .18s ease" }}>
          {cfg.actions.map((a) => (
            <button
              key={a.label}
              onClick={() => {
                setOpen(false);
                a.run();
              }}
              className="flex items-center gap-[9px] bg-card border border-line2 px-[15px] py-2.5 rounded-full text-[13px] font-semibold cursor-pointer text-ink"
              style={{ boxShadow: "var(--shLg)" }}
            >
              {a.icon} {a.label}
            </button>
          ))}
        </div>
      )}
      <button
        aria-label={single ? cfg.actions[0].label : `${cfg.label} — quick add`}
        title={single ? cfg.actions[0].label : cfg.label}
        onClick={() => (single ? cfg.actions[0].run() : setOpen((o) => !o))}
        className="hidden md:grid fixed right-5 w-[54px] h-[54px] rounded-full bg-acc text-white text-[25px] place-items-center cursor-pointer z-[47] select-none border-none bottom-6 hover:brightness-108 print:hidden transition-transform active:scale-95"
        style={{ boxShadow: "0 8px 22px color-mix(in oklab, var(--acc) 45%, transparent)" }}
      >
        {open && !single ? "✕" : "＋"}
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
