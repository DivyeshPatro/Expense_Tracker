"use client";

// Global period filter shown in the top bar on every period-aware page
// (Dashboard, Transactions, Accounts, Analytics). Self-contained: reads its
// own state from the URL so it works the same regardless of which page
// rendered it, and writes back to *this* page's path — switching sections
// keeps whatever period you picked instead of losing it on navigation.
//
// UI model: a single compact trigger ("📅 This Month ▾") opens a period
// selector — a bottom sheet on mobile, a popover anchored to the trigger on
// desktop. The selector offers the common windows up front (This/Last month,
// This year, All time) and folds the two heavier flows — a month grid and a
// custom date range — behind their own sub-views instead of living
// permanently in the header. Every choice still resolves to one of the four
// URL shapes parsePeriod already understands (?p=YYYY-MM | ?p=all | ?from&to
// | none); this file only changes how you get there, never the state.

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { currentMonthKey, MONTH_NAMES, shiftMonthKey, todayYMD } from "@/lib/dates";
import { parsePeriod, resolvePeriod } from "@/lib/period";
import { writePref } from "@/lib/preferences";
import { periodPref } from "@/lib/prefs-registry";
import { armStuckNavFallback } from "@/lib/resilient-nav";
import { BottomSheet } from "./bottom-sheet";
import { DateField } from "./date-field";
import { useFocusTrap } from "./use-focus-trap";

const PERIOD_AWARE_ROUTES = ["/dashboard", "/transactions", "/accounts", "/analytics", "/shared/groups"];

export function HeaderPeriodPicker({ storedPeriod }: { storedPeriod: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  if (!PERIOD_AWARE_ROUTES.some((r) => pathname.startsWith(r))) return null;

  const now = new Date();
  const currentKey = currentMonthKey(now);
  const today = todayYMD(now);
  const sp: Record<string, string | undefined> = {
    p: searchParams.get("p") ?? undefined,
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
  };
  // Resolve exactly as the server pages do, so the trigger label can never
  // disagree with what the page below it is showing — which is what happens
  // when you reach a period-aware page from the sidebar (bare URL) while a
  // period is remembered.
  const period = resolvePeriod(sp, storedPeriod, now);

  const go = (qs: string) => {
    // Remember the choice before navigating, so arriving at any period-aware
    // page with a bare URL later restores this window instead of snapping back
    // to the rolling default. `qs` is exactly what periodQueryParams emits, so
    // the stored form and the URL form stay one language.
    writePref(periodPref, qs);

    const params = new URLSearchParams(searchParams.toString());
    params.delete("p");
    params.delete("from");
    params.delete("to");
    const extra = new URLSearchParams(qs);
    extra.forEach((v, k) => params.set(k, v));
    const q = params.toString();
    const href = q ? `${pathname}?${q}` : pathname;
    router.push(href);
    armStuckNavFallback(href);
  };

  return <PeriodControl period={period} currentKey={currentKey} today={today} onNavigate={go} />;
}

// ── selection model ──────────────────────────────────────────────────────
// Which named window the current URL resolves to, so the trigger label and
// the sheet's active row/check agree without re-deriving the logic twice.

type Selection = "recent" | "thisMonth" | "lastMonth" | "thisYear" | "all" | "otherMonth" | "custom";

const monthLabel = (key: string) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const shortDay = (ymd: string) => `${Number(ymd.slice(8, 10))} ${MONTH_NAMES[Number(ymd.slice(5, 7)) - 1]}`;

function thisYearRange(today: string) {
  return { from: `${today.slice(0, 4)}-01-01`, to: today };
}

function classify(period: ReturnType<typeof parsePeriod>, currentKey: string, today: string): Selection {
  const lastKey = shiftMonthKey(currentKey, -1);
  const yr = thisYearRange(today);
  if (period.mode === "all") return "all";
  if (period.mode === "recent") return "recent";
  if (period.mode === "custom") return period.from === yr.from && period.to === yr.to ? "thisYear" : "custom";
  if (period.periodKey === currentKey) return "thisMonth";
  if (period.periodKey === lastKey) return "lastMonth";
  return "otherMonth";
}

function triggerLabel(period: ReturnType<typeof parsePeriod>, sel: Selection): string {
  switch (sel) {
    case "recent":
      return "Last 30 Days";
    case "thisMonth":
      return "This Month";
    case "lastMonth":
      return "Last Month";
    case "thisYear":
      return "This Year";
    case "all":
      return "All Time";
    case "otherMonth":
      return monthLabel(period.periodKey);
    case "custom":
      return `${shortDay(period.from)} – ${shortDay(period.to)}`;
  }
}

// ── control: trigger + responsive panel ──────────────────────────────────

function PeriodControl({
  period,
  currentKey,
  today,
  onNavigate,
}: {
  period: ReturnType<typeof parsePeriod>;
  currentKey: string;
  today: string;
  onNavigate: (qs: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sel = classify(period, currentKey, today);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const navigate = (qs: string) => {
    setOpen(false);
    onNavigate(qs);
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        // Include the visible label so the accessible name matches what's shown
        // (voice control + WCAG label-in-name); "Change period" alone mismatched.
        aria-label={`Change period, ${triggerLabel(period, sel)}`}
        className="inline-flex items-center gap-1.5 min-h-[44px] pl-3.5 pr-3 rounded-full text-[12.5px] font-bold cursor-pointer border-none whitespace-nowrap transition-[filter] hover:brightness-95"
        style={{ background: "var(--accSoft)", color: "var(--acc)" }}
      >
        <span aria-hidden="true" className="text-[13px] leading-none">📅</span>
        {triggerLabel(period, sel)}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .2s" }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open &&
        (isDesktop ? (
          <DesktopPopover triggerRef={triggerRef} close={() => setOpen(false)}>
            <PanelBody period={period} sel={sel} currentKey={currentKey} today={today} onNavigate={navigate} desktop />
          </DesktopPopover>
        ) : (
          <BottomSheet onClose={() => setOpen(false)} label="Select period">
            <PanelBody period={period} sel={sel} currentKey={currentKey} today={today} onNavigate={navigate} />
          </BottomSheet>
        ))}
    </div>
  );
}

// ── desktop: portaled popover anchored under the trigger ──────────────────

function DesktopPopover({ triggerRef, close, children }: { triggerRef: React.RefObject<HTMLButtonElement | null>; close: () => void; children: React.ReactNode }) {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useFocusTrap(popRef, true);

  useLayoutEffect(() => {
    function compute() {
      const t = triggerRef.current?.getBoundingClientRect();
      const p = popRef.current;
      if (!t || !p) return;
      const w = p.offsetWidth;
      let left = t.right - w; // right-align under the trigger
      left = Math.max(8, Math.min(left, window.innerWidth - 8 - w));
      setPos({ top: t.bottom + 6, left });
    }
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [triggerRef]);

  useEffect(() => {
    function onPointer(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || popRef.current?.contains(target)) return;
      // The custom-range DateField portals its calendar to <body>, outside this
      // popover's DOM — a click inside that nested dialog must not be treated as
      // an outside click, or picking a date would dismiss the whole picker.
      if (target instanceof Element && target.closest('[role="dialog"]')) return;
      close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        close();
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [triggerRef, close]);

  return createPortal(
    <div
      ref={popRef}
      role="dialog"
      aria-label="Select period"
      className="card fixed z-[100] w-[300px] max-w-[calc(100vw-16px)] p-2"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? "visible" : "hidden", boxShadow: "var(--shLg)", animation: "pop .16s ease" }}
    >
      {children}
    </div>,
    document.body,
  );
}

// ── panel body: main list → month grid / custom range sub-views ───────────

function PanelBody({
  period,
  sel,
  currentKey,
  today,
  onNavigate,
  desktop = false,
}: {
  period: ReturnType<typeof parsePeriod>;
  sel: Selection;
  currentKey: string;
  today: string;
  onNavigate: (qs: string) => void;
  desktop?: boolean;
}) {
  const [view, setView] = useState<"main" | "month" | "custom">("main");

  if (view === "month") {
    return <MonthView period={period} sel={sel} currentKey={currentKey} onBack={() => setView("main")} onPick={onNavigate} />;
  }
  if (view === "custom") {
    return <CustomView period={period} sel={sel} today={today} onBack={() => setView("main")} onApply={onNavigate} />;
  }

  const lastKey = shiftMonthKey(currentKey, -1);
  const yr = thisYearRange(today);
  const rowGap = desktop ? "gap-0.5" : "gap-1";

  return (
    <div className={`flex flex-col ${rowGap}`} style={{ animation: "fade .16s ease" }}>
      {!desktop && <h2 className="text-[13px] font-bold text-mut2 uppercase tracking-wide px-1.5 pb-1.5">Select period</h2>}
      {/* #186: the rolling window is the default (empty query string); the
          calendar month is now an explicit choice below it. */}
      <QuickRow label="Last 30 Days" sub="Rolling window" active={sel === "recent"} onClick={() => onNavigate("")} />
      <QuickRow label="This Month" sub={monthLabel(currentKey)} active={sel === "thisMonth"} onClick={() => onNavigate(`p=${currentKey}`)} />
      <QuickRow label="Last Month" sub={monthLabel(lastKey)} active={sel === "lastMonth"} onClick={() => onNavigate(`p=${lastKey}`)} />
      <QuickRow label="This Year" sub={`Jan – ${monthLabel(currentKey)}`} active={sel === "thisYear"} onClick={() => onNavigate(`from=${yr.from}&to=${yr.to}`)} />
      <QuickRow label="All Time" sub="Since the beginning" active={sel === "all"} onClick={() => onNavigate("p=all")} />
      <div className="h-px bg-line my-1.5 mx-1.5" />
      <NavRow label="Pick a month" sub={sel === "otherMonth" ? monthLabel(period.periodKey) : "Choose any month"} active={sel === "otherMonth"} onClick={() => setView("month")} />
      <NavRow label="Custom range" sub={sel === "custom" ? `${shortDay(period.from)} – ${shortDay(period.to)}` : "Set a start & end date"} active={sel === "custom"} onClick={() => setView("custom")} />
    </div>
  );
}

function Check() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--acc)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function QuickRow({ label, sub, active, onClick }: { label: string; sub: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className="flex items-center gap-3 w-full min-h-[46px] px-3 py-2 rounded-[11px] text-left cursor-pointer bg-transparent border-none hover:bg-accsoft"
      style={active ? { background: "var(--accSoft)" } : undefined}
    >
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] font-bold" style={{ color: active ? "var(--acc)" : "var(--ink)" }}>{label}</div>
        <div className="text-[11.5px] text-mut2 truncate">{sub}</div>
      </div>
      {active && <Check />}
    </button>
  );
}

function NavRow({ label, sub, active, onClick }: { label: string; sub: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 w-full min-h-[46px] px-3 py-2 rounded-[11px] text-left cursor-pointer bg-transparent border-none hover:bg-accsoft"
    >
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] font-bold" style={{ color: active ? "var(--acc)" : "var(--ink)" }}>{label}</div>
        <div className="text-[11.5px] text-mut2 truncate">{sub}</div>
      </div>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--mut2)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none">
        <path d="m9 18 6-6-6-6" />
      </svg>
    </button>
  );
}

function SubHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-1.5 pb-2">
      <button onClick={onBack} aria-label="Back" className="w-8 h-8 -ml-1 rounded-lg grid place-items-center text-mut cursor-pointer bg-transparent border-none hover:bg-accsoft flex-none">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <h2 className="text-[14px] font-bold text-ink m-0">{title}</h2>
    </div>
  );
}

// ── month grid sub-view ───────────────────────────────────────────────────

function MonthView({
  period,
  sel,
  currentKey,
  onBack,
  onPick,
}: {
  period: ReturnType<typeof parsePeriod>;
  sel: Selection;
  currentKey: string;
  onBack: () => void;
  onPick: (qs: string) => void;
}) {
  const selectedYM = period.mode === "month" ? period.periodKey : "";
  const [viewY, setViewY] = useState(Number((selectedYM || currentKey).slice(0, 4)));
  const thisYearNum = Number(currentKey.slice(0, 4));

  const pick = (m: number) => {
    const ym = `${viewY}-${String(m).padStart(2, "0")}`;
    onPick(ym === currentKey ? "" : `p=${ym}`);
  };

  return (
    <div style={{ animation: "fade .16s ease" }}>
      <SubHeader title="Pick a month" onBack={onBack} />
      <div className="flex items-center gap-1.5 pb-2.5">
        <button onClick={() => setViewY((y) => y - 1)} aria-label="Previous year" className="w-8 h-8 rounded-lg grid place-items-center text-mut cursor-pointer bg-transparent border-none hover:bg-accsoft flex-none">‹</button>
        <div className="flex-1 text-center text-[14px] font-bold text-ink">{viewY}</div>
        <button onClick={() => setViewY((y) => Math.min(y + 1, thisYearNum))} disabled={viewY >= thisYearNum} aria-label="Next year" className="w-8 h-8 rounded-lg grid place-items-center text-mut cursor-pointer bg-transparent border-none hover:bg-accsoft disabled:opacity-30 disabled:cursor-not-allowed flex-none">›</button>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {MONTH_NAMES.map((name, i) => {
          const m = i + 1;
          const ym = `${viewY}-${String(m).padStart(2, "0")}`;
          const isSelected = sel !== "thisYear" && sel !== "custom" && sel !== "all" && ym === selectedYM;
          const isFuture = ym > currentKey;
          return (
            <button
              key={name}
              data-month={m}
              onClick={() => pick(m)}
              disabled={isFuture}
              aria-pressed={isSelected}
              className="h-11 rounded-[10px] text-[13px] font-bold cursor-pointer border-none grid place-items-center disabled:opacity-30 disabled:cursor-not-allowed hover:bg-accsoft"
              style={isSelected ? { background: "var(--acc)", color: "#fff" } : { background: "transparent", color: "var(--ink)" }}
            >
              {name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── custom range sub-view ─────────────────────────────────────────────────

function CustomView({
  period,
  sel,
  today,
  onBack,
  onApply,
}: {
  period: ReturnType<typeof parsePeriod>;
  sel: Selection;
  today: string;
  onBack: () => void;
  onApply: (qs: string) => void;
}) {
  const [f, setF] = useState(sel === "custom" ? period.from : "");
  const [t, setT] = useState(sel === "custom" ? period.to : "");
  const invalid = !f || !t || f > t;

  return (
    <div style={{ animation: "fade .16s ease" }}>
      <SubHeader title="Custom range" onBack={onBack} />
      <div className="flex flex-col gap-2.5 px-1 pb-1">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11.5px] font-bold text-mut2 uppercase tracking-wide">Start date</span>
          <DateField value={f} max={t || today} onChange={setF} aria-label="Start date" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11.5px] font-bold text-mut2 uppercase tracking-wide">End date</span>
          <DateField value={t} min={f} max={today} onChange={setT} aria-label="End date" />
        </label>
        <button
          disabled={invalid}
          onClick={() => onApply(`from=${f}&to=${t}`)}
          className="mt-1 h-11 rounded-[11px] text-[13.5px] font-bold cursor-pointer border-none bg-acc text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Apply range
        </button>
      </div>
    </div>
  );
}
