"use client";

// Global period filter shown in the top bar on every period-aware page
// (Dashboard, Transactions, Accounts, Analytics). Self-contained: reads its
// own state from the URL so it works the same regardless of which page
// rendered it, and writes back to *this* page's path — switching sections
// keeps whatever period you picked instead of losing it on navigation.

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { currentMonthKey, MONTH_NAMES, todayYMD } from "@/lib/dates";
import { parsePeriod } from "@/lib/period";
import { armStuckNavFallback } from "@/lib/resilient-nav";
import { DateField } from "./date-field";

const PERIOD_AWARE_ROUTES = ["/dashboard", "/transactions", "/accounts", "/analytics"];

export function HeaderPeriodPicker() {
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
  const { mode, periodKey, from, to } = parsePeriod(sp, now);

  const go = (qs: string) => {
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

  return <PeriodPicker mode={mode} monthKey={periodKey} currentMonthKey={currentKey} from={from} to={to} today={today} onNavigate={go} />;
}

function PeriodPicker({
  mode,
  monthKey,
  currentMonthKey: currentKey,
  from,
  to,
  today,
  onNavigate,
}: {
  mode: "month" | "custom" | "all";
  monthKey: string;
  currentMonthKey: string;
  from: string;
  to: string;
  today: string;
  onNavigate: (qs: string) => void;
}) {
  const [customOpen, setCustomOpen] = useState(mode === "custom");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);

  const monthLabel = (key: string) => {
    const [y, m] = key.split("-");
    return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
  };

  const chip = (active: boolean) =>
    `px-2.5 py-[5px] rounded-full text-[11.5px] font-semibold cursor-pointer border-none whitespace-nowrap ${active ? "" : "hover:brightness-95"}`;
  const chipStyle = (active: boolean) => ({
    background: active ? "var(--acc)" : "var(--accSoft)",
    color: active ? "#fff" : "var(--acc)",
  });

  const isThisMonth = mode === "month" && monthKey === currentKey;
  const isOtherMonth = mode === "month" && monthKey !== currentKey;
  const currentLabel = isThisMonth ? "This month" : isOtherMonth ? monthLabel(monthKey) : mode === "custom" ? "Custom range" : "To date";

  return (
    <div className="relative">
      {/* Mobile: one compact pill that opens the full picker below it. */}
      <button
        className="md:hidden inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[12px] font-bold"
        style={{ background: "var(--accSoft)", color: "var(--acc)" }}
        onClick={() => setMobileOpen((v) => !v)}
        aria-expanded={mobileOpen}
        aria-label="Change period"
      >
        {currentLabel}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ transform: mobileOpen ? "rotate(180deg)" : "none", transition: "transform .2s" }}><path d="m6 9 6 6 6-6" /></svg>
      </button>
      <div className={`${mobileOpen ? "flex" : "hidden"} md:flex items-center gap-1.5 flex-wrap absolute md:static top-full left-0 mt-1.5 md:mt-0 z-30 bg-card md:bg-transparent border border-line md:border-0 rounded-xl md:rounded-none p-2 md:p-0 shadow-lg md:shadow-none`}>
      <button className={chip(isThisMonth)} style={chipStyle(isThisMonth)} onClick={() => { setCustomOpen(false); setMobileOpen(false); onNavigate(""); }}>
        This month
      </button>
      <DateField
        mode="month"
        showIcon={false}
        value={monthKey}
        max={currentKey}
        onChange={(v) => {
          if (!v) return;
          setCustomOpen(false);
          setMobileOpen(false);
          onNavigate(v === currentKey ? "" : `p=${v}`);
        }}
        triggerClassName="field !w-auto !py-[4px] !px-2.5 !text-[11.5px] !rounded-full font-semibold cursor-pointer"
        triggerStyle={isOtherMonth ? { borderColor: "var(--acc)", color: "var(--acc)" } : undefined}
        aria-label="Pick a month"
      />
      <button className={chip(mode === "custom")} style={chipStyle(mode === "custom")} onClick={() => setCustomOpen((v) => !v)}>
        Custom range
      </button>
      <button className={chip(mode === "all")} style={chipStyle(mode === "all")} onClick={() => { setCustomOpen(false); setMobileOpen(false); onNavigate("p=all"); }}>
        To date
      </button>
      {customOpen && (
        <span className="flex items-center gap-1 flex-wrap absolute mt-9 bg-card border border-line rounded-lg p-2 shadow-lg z-20">
          <DateField
            showIcon={false}
            value={f}
            max={t || today}
            onChange={setF}
            triggerClassName="field !w-auto !py-1 !px-1.5 !text-[11.5px] cursor-pointer"
            aria-label="From date"
          />
          <span className="text-[11.5px] text-mut2">→</span>
          <DateField
            showIcon={false}
            value={t}
            min={f}
            max={today}
            onChange={setT}
            triggerClassName="field !w-auto !py-1 !px-1.5 !text-[11.5px] cursor-pointer"
            aria-label="To date"
          />
          <button
            disabled={!f || !t || f > t}
            className="px-2.5 py-1 rounded-full text-[11.5px] font-bold cursor-pointer border-none bg-acc text-white disabled:opacity-50"
            onClick={() => { setCustomOpen(false); setMobileOpen(false); onNavigate(`from=${f}&to=${t}`); }}
          >
            Apply
          </button>
        </span>
      )}
      </div>
    </div>
  );
}
