"use client";

// Dashboard period filter: This month (default) / any month / custom range /
// To date. Drives the page through URL search params so the server component
// recomputes the cards for the chosen window.

import { useRouter } from "next/navigation";
import { useState } from "react";

export type PeriodMode = "month" | "custom" | "all";

export function PeriodPicker({
  mode,
  monthKey,
  currentMonthKey,
  from,
  to,
}: {
  mode: PeriodMode;
  monthKey: string; // selected (or current) "YYYY-MM"
  currentMonthKey: string;
  from: string; // custom range start "YYYY-MM-DD" (or default)
  to: string; // custom range end "YYYY-MM-DD" (or default)
}) {
  const router = useRouter();
  const [customOpen, setCustomOpen] = useState(mode === "custom");
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);

  const chip = (active: boolean) =>
    `px-3 py-[6px] rounded-full text-[12px] font-semibold cursor-pointer border-none ${active ? "" : "hover:brightness-95"}`;
  const chipStyle = (active: boolean) => ({
    background: active ? "var(--acc)" : "var(--accSoft)",
    color: active ? "#fff" : "var(--acc)",
  });

  const isThisMonth = mode === "month" && monthKey === currentMonthKey;
  const isOtherMonth = mode === "month" && monthKey !== currentMonthKey;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button className={chip(isThisMonth)} style={chipStyle(isThisMonth)} onClick={() => { setCustomOpen(false); router.push("/dashboard"); }}>
        This month
      </button>
      <input
        type="month"
        className="field !w-auto !py-[5px] !px-2.5 !text-[12px] !rounded-full font-semibold"
        style={isOtherMonth ? { borderColor: "var(--acc)", color: "var(--acc)" } : undefined}
        value={monthKey}
        max={currentMonthKey}
        onChange={(e) => {
          if (!e.target.value) return;
          setCustomOpen(false);
          router.push(e.target.value === currentMonthKey ? "/dashboard" : `/dashboard?p=${e.target.value}`);
        }}
        aria-label="Pick a month"
      />
      <button className={chip(mode === "custom")} style={chipStyle(mode === "custom")} onClick={() => setCustomOpen((v) => !v)}>
        Custom range
      </button>
      <button className={chip(mode === "all")} style={chipStyle(mode === "all")} onClick={() => { setCustomOpen(false); router.push("/dashboard?p=all"); }}>
        To date
      </button>
      {customOpen && (
        <span className="flex items-center gap-1.5 flex-wrap">
          <input type="date" className="field !w-auto !py-[5px] !px-2 !text-[12px]" value={f} max={t} onChange={(e) => setF(e.target.value)} aria-label="From date" />
          <span className="text-[12px] text-mut2">→</span>
          <input type="date" className="field !w-auto !py-[5px] !px-2 !text-[12px]" value={t} min={f} onChange={(e) => setT(e.target.value)} aria-label="To date" />
          <button
            disabled={!f || !t || f > t}
            className="px-3 py-[6px] rounded-full text-[12px] font-bold cursor-pointer border-none bg-acc text-white disabled:opacity-50"
            onClick={() => router.push(`/dashboard?from=${f}&to=${t}`)}
          >
            Apply
          </button>
        </span>
      )}
    </div>
  );
}
