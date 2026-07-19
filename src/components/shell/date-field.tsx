"use client";

// The single themed calendar used everywhere the app asks for a date or a
// month — Add/Edit Expense, Income, Transfer, Pending Intent Edit, Bills,
// and the global period picker (Dashboard/Transactions/Accounts/Analytics
// header). Replaces every native <input type="date"|"month">: those can't
// be restyled to match Ledgerly's design system and vary wildly by platform.
//
// The popover renders through a portal into document.body and is positioned
// with `position: fixed` from the trigger's measured viewport rect, with
// flip (below → above) and shift (clamp to viewport) collision handling.
// Portaling is what makes "never introduces scrollbars into parent dialogs"
// true by construction: the popover's DOM lives outside the modal's
// overflow-auto subtree entirely, so it can never inflate that container's
// scrollHeight, regardless of where the trigger sits inside it.
//
// One component serves two grains — day-picking (mode="day", the default)
// and month-picking (mode="month", for the period picker) — because they're
// the same interaction (a themed calendar popover anchored to a field
// trigger) at two granularities, and duplicating the portal/position/
// keyboard-nav machinery for a second component would just be two things to
// keep in sync instead of one.

import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MONTH_NAMES, todayYMD } from "@/lib/dates";

function parseYMD(ymd: string): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.split("-").map(Number);
  return { y, m, d };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const toYMD = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`;
const toYM = (y: number, m: number) => `${y}-${pad2(m)}`;

/** Last day of month `m` (1-12) in year `y`. */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Civil-date arithmetic via UTC (no DST/timezone drift) — used for both
 * month-header stepping and arrow-key day navigation, so both roll over
 * year/month boundaries identically and correctly. */
function shiftYMD(y: number, m: number, d: number, deltaDays: number): { y: number; m: number; d: number } {
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function formatDisplay(ymd: string): string {
  if (!ymd) return "Select date";
  const { y, m, d } = parseYMD(ymd);
  if (!y || !m || !d) return "Select date";
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
}

function formatMonthDisplay(ym: string): string {
  if (!ym) return "Select month";
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return "Select month";
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const YEAR_RANGE_PAST = 15;
const YEAR_RANGE_FUTURE = 1;
const POPOVER_MARGIN = 8; // min gap kept from every viewport edge
const POPOVER_GAP = 6; // gap between trigger and popover

interface Rect {
  top: number;
  left: number;
}

/** Measures the trigger + popover and returns a `position: fixed` origin
 * that flips above the trigger when there's no room below, and shifts
 * horizontally to stay clear of the viewport edges. Runs in a layout effect
 * (before paint) so there's no visible jump from an initial guess. */
function usePopoverPosition(open: boolean, triggerRef: React.RefObject<HTMLElement | null>, popoverRef: React.RefObject<HTMLElement | null>, recalcKey: unknown) {
  const [pos, setPos] = useState<Rect | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    function compute() {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) return;
      const t = trigger.getBoundingClientRect();
      const pW = popover.offsetWidth;
      const pH = popover.offsetHeight;

      let top = t.bottom + POPOVER_GAP;
      const fitsBelow = top + pH <= window.innerHeight - POPOVER_MARGIN;
      if (!fitsBelow) {
        const above = t.top - pH - POPOVER_GAP;
        top = above >= POPOVER_MARGIN ? above : Math.max(POPOVER_MARGIN, window.innerHeight - POPOVER_MARGIN - pH);
      }

      let left = t.left;
      if (left + pW > window.innerWidth - POPOVER_MARGIN) left = window.innerWidth - POPOVER_MARGIN - pW;
      left = Math.max(POPOVER_MARGIN, left);

      setPos({ top, left });
    }
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true); // capture: catches scroll inside modal's overflow-auto too
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recalcKey]);

  return pos;
}

export function DateField({
  value,
  onChange,
  autoFocus,
  min,
  max,
  mode = "day",
  triggerClassName,
  triggerStyle,
  showIcon = true,
  "aria-label": ariaLabel,
}: {
  /** "YYYY-MM-DD" in day mode, "YYYY-MM" in month mode. */
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  /** optional lower bound, same grain as `value` */
  min?: string;
  /** optional upper bound, same grain as `value` */
  max?: string;
  /** "day" (default) picks a calendar date; "month" picks a Year+Month only. */
  mode?: "day" | "month";
  /** overrides the default `.field` trigger look — e.g. the header period
   * picker's compact pill chips — without forking the component. */
  triggerClassName?: string;
  triggerStyle?: React.CSSProperties;
  /** hide the 📅 glyph — for compact chip-style triggers where it's just noise */
  showIcon?: boolean;
  /** overrides the trigger's accessible name — the displayed date is the
   * default; set this when the field's purpose isn't obvious from context
   * alone (e.g. "From date" vs "To date" sitting side by side). */
  "aria-label"?: string;
}) {
  return mode === "month" ? (
    <MonthPicker value={value} onChange={onChange} min={min} max={max} autoFocus={autoFocus} triggerClassName={triggerClassName} triggerStyle={triggerStyle} showIcon={showIcon} ariaLabel={ariaLabel} />
  ) : (
    <DayPicker value={value} onChange={onChange} min={min} max={max} autoFocus={autoFocus} triggerClassName={triggerClassName} triggerStyle={triggerStyle} showIcon={showIcon} ariaLabel={ariaLabel} />
  );
}

/** Shared outside-click + Escape handling. The popover is portaled out of
 * the trigger's DOM subtree, so "outside" means outside *both* refs, not
 * just the trigger's own wrapper. */
function useDismiss(open: boolean, close: () => void, triggerRef: React.RefObject<HTMLElement | null>, popoverRef: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    function onDocPointer(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      close();
    }
    function onDocKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        close();
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onDocKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onDocKey);
    };
  }, [open, close, triggerRef, popoverRef]);
}

const TRIGGER_BASE = "field flex items-center justify-between gap-2 cursor-pointer text-left";
const POPOVER_BASE = "card fixed z-[100] p-3 flex flex-col gap-2.5";

function DayPicker({
  value,
  onChange,
  autoFocus,
  min,
  max,
  triggerClassName,
  triggerStyle,
  showIcon = true,
  ariaLabel,
}: {
  value: string;
  onChange: (ymd: string) => void;
  autoFocus?: boolean;
  min?: string;
  max?: string;
  triggerClassName?: string;
  triggerStyle?: React.CSSProperties;
  showIcon?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const base = value || todayYMD();
  const { y: baseY, m: baseM, d: baseD } = parseYMD(base);
  const [viewY, setViewY] = useState(baseY);
  const [viewM, setViewM] = useState(baseM);
  const [focusDay, setFocusDay] = useState(baseD);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const close = () => setOpen(false);
  const pos = usePopoverPosition(open, triggerRef, popoverRef, `${viewY}-${viewM}`);
  useDismiss(open, close, triggerRef, popoverRef);

  // re-sync the visible month to whatever the field's value is, every time
  // the popover opens — otherwise re-opening after picking a far-off month
  // would strand the user back on last time's view
  useEffect(() => {
    if (!open) return;
    const { y, m, d } = parseYMD(value || todayYMD());
    setViewY(y);
    setViewM(m);
    setFocusDay(d);
  }, [open, value]);

  // keep the focused day cell in sync with actual keyboard focus, so Tab
  // reaching the grid from month/year selects lands somewhere sane
  useEffect(() => {
    if (open) gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${focusDay}"]`)?.focus();
  }, [open, viewY, viewM, focusDay]);

  function select(y: number, m: number, d: number) {
    onChange(toYMD(y, m, d));
    setOpen(false);
    triggerRef.current?.focus();
  }

  function stepMonth(delta: number) {
    let ny = viewY;
    let nm = viewM + delta;
    if (nm < 1) {
      nm = 12;
      ny -= 1;
    } else if (nm > 12) {
      nm = 1;
      ny += 1;
    }
    setViewY(ny);
    setViewM(nm);
    setFocusDay((d) => Math.min(d, daysInMonth(ny, nm)));
  }

  function moveFocus(deltaDays: number) {
    const { y, m, d } = shiftYMD(viewY, viewM, focusDay, deltaDays);
    setViewY(y);
    setViewM(m);
    setFocusDay(d);
  }

  function handleGridKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        moveFocus(-1);
        break;
      case "ArrowRight":
        e.preventDefault();
        moveFocus(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(-7);
        break;
      case "ArrowDown":
        e.preventDefault();
        moveFocus(7);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        select(viewY, viewM, focusDay);
        break;
    }
  }

  const dim = daysInMonth(viewY, viewM);
  const firstWeekday = new Date(Date.UTC(viewY, viewM - 1, 1)).getUTCDay();
  const cells: (number | null)[] = [...Array(firstWeekday).fill(null), ...Array.from({ length: dim }, (_, i) => i + 1)];
  const today = todayYMD();
  const thisYear = Number(today.slice(0, 4));
  const years = Array.from({ length: YEAR_RANGE_PAST + YEAR_RANGE_FUTURE + 1 }, (_, i) => thisYear + YEAR_RANGE_FUTURE - i);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        autoFocus={autoFocus}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={triggerClassName ?? TRIGGER_BASE}
        style={triggerStyle}
      >
        <span>{formatDisplay(value)}</span>
        {showIcon && <span aria-hidden="true" className="text-mut2">📅</span>}
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Choose date"
            className={POPOVER_BASE}
            style={{ width: "272px", maxWidth: "calc(100vw - 16px)", top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? "visible" : "hidden", boxShadow: "var(--shLg)" }}
          >
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => stepMonth(-1)}
                aria-label="Previous month"
                className="w-7 h-7 rounded-lg grid place-items-center text-mut cursor-pointer bg-transparent border-none hover:bg-accsoft flex-none"
              >
                ‹
              </button>
              <select
                className="field !py-1.5 !text-[12.5px] flex-1"
                value={viewM}
                onChange={(e) => {
                  const nm = Number(e.target.value);
                  setViewM(nm);
                  setFocusDay((d) => Math.min(d, daysInMonth(viewY, nm)));
                }}
                aria-label="Month"
              >
                {MONTH_NAMES.map((name, i) => (
                  <option key={name} value={i + 1}>{name}</option>
                ))}
              </select>
              <select
                className="field !py-1.5 !text-[12.5px]"
                style={{ width: "82px" }}
                value={viewY}
                onChange={(e) => {
                  const ny = Number(e.target.value);
                  setViewY(ny);
                  setFocusDay((d) => Math.min(d, daysInMonth(ny, viewM)));
                }}
                aria-label="Year"
              >
                {years.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => stepMonth(1)}
                aria-label="Next month"
                className="w-7 h-7 rounded-lg grid place-items-center text-mut cursor-pointer bg-transparent border-none hover:bg-accsoft flex-none"
              >
                ›
              </button>
            </div>

            <div className="grid grid-cols-7 gap-1" ref={gridRef} onKeyDown={handleGridKeyDown}>
              {WEEKDAY_LABELS.map((w, i) => (
                <div key={i} className="text-[10.5px] font-bold text-mut2 text-center h-6 grid place-items-center">{w}</div>
              ))}
              {cells.map((day, i) => {
                if (day === null) return <div key={`blank-${i}`} aria-hidden="true" />;
                const ymd = toYMD(viewY, viewM, day);
                const isSelected = ymd === value;
                const isToday = ymd === today;
                const isOutOfRange = (max ? ymd > max : false) || (min ? ymd < min : false);
                return (
                  <button
                    key={day}
                    type="button"
                    data-day={day}
                    disabled={isOutOfRange}
                    tabIndex={day === focusDay ? 0 : -1}
                    onClick={() => select(viewY, viewM, day)}
                    onFocus={() => setFocusDay(day)}
                    aria-current={isToday ? "date" : undefined}
                    aria-pressed={isSelected}
                    className="h-8 rounded-lg text-[12.5px] font-semibold cursor-pointer border-none grid place-items-center disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{
                      background: isSelected ? "var(--acc)" : "transparent",
                      color: isSelected ? "#fff" : "var(--ink)",
                      boxShadow: !isSelected && isToday ? "inset 0 0 0 1.5px var(--acc)" : undefined,
                    }}
                  >
                    {day}
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => {
                const { y, m, d } = parseYMD(today);
                select(y, m, d);
              }}
              className="text-[12px] font-semibold text-acc bg-transparent border-none cursor-pointer self-start p-0 hover:underline"
            >
              Today
            </button>
          </div>,
          document.body
        )}
    </>
  );
}

function MonthPicker({
  value,
  onChange,
  autoFocus,
  min,
  max,
  triggerClassName,
  triggerStyle,
  showIcon = true,
  ariaLabel,
}: {
  value: string;
  onChange: (ym: string) => void;
  autoFocus?: boolean;
  min?: string;
  max?: string;
  triggerClassName?: string;
  triggerStyle?: React.CSSProperties;
  showIcon?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const now = new Date();
  const nowYM = toYM(now.getFullYear(), now.getMonth() + 1);
  const base = value || nowYM;
  const [baseY, baseM] = base.split("-").map(Number);
  const [viewY, setViewY] = useState(baseY);
  const [focusMonth, setFocusMonth] = useState(baseM);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const close = () => setOpen(false);
  const pos = usePopoverPosition(open, triggerRef, popoverRef, viewY);
  useDismiss(open, close, triggerRef, popoverRef);

  useEffect(() => {
    if (!open) return;
    const [y, m] = (value || nowYM).split("-").map(Number);
    setViewY(y);
    setFocusMonth(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, value]);

  useEffect(() => {
    if (open) gridRef.current?.querySelector<HTMLButtonElement>(`[data-month="${focusMonth}"]`)?.focus();
  }, [open, viewY, focusMonth]);

  function select(y: number, m: number) {
    onChange(toYM(y, m));
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveFocus(delta: number) {
    const total = viewY * 12 + (focusMonth - 1) + delta;
    const ny = Math.floor(total / 12);
    const nm = (total % 12) + 1;
    setViewY(ny);
    setFocusMonth(nm);
  }

  function handleGridKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        moveFocus(-1);
        break;
      case "ArrowRight":
        e.preventDefault();
        moveFocus(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(-3);
        break;
      case "ArrowDown":
        e.preventDefault();
        moveFocus(3);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        select(viewY, focusMonth);
        break;
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        autoFocus={autoFocus}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={triggerClassName ?? TRIGGER_BASE}
        style={triggerStyle}
      >
        <span>{formatMonthDisplay(value)}</span>
        {showIcon && <span aria-hidden="true" className="text-mut2">📅</span>}
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Choose month"
            className={POPOVER_BASE}
            style={{ width: "224px", maxWidth: "calc(100vw - 16px)", top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? "visible" : "hidden", boxShadow: "var(--shLg)" }}
          >
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setViewY((y) => y - 1)}
                aria-label="Previous year"
                className="w-7 h-7 rounded-lg grid place-items-center text-mut cursor-pointer bg-transparent border-none hover:bg-accsoft flex-none"
              >
                ‹
              </button>
              <div className="flex-1 text-center text-[13px] font-bold text-ink">{viewY}</div>
              <button
                type="button"
                onClick={() => setViewY((y) => y + 1)}
                aria-label="Next year"
                className="w-7 h-7 rounded-lg grid place-items-center text-mut cursor-pointer bg-transparent border-none hover:bg-accsoft flex-none"
              >
                ›
              </button>
            </div>

            <div className="grid grid-cols-3 gap-1" ref={gridRef} onKeyDown={handleGridKeyDown}>
              {MONTH_NAMES.map((name, i) => {
                const m = i + 1;
                const ym = toYM(viewY, m);
                const isSelected = ym === value;
                const isCurrent = ym === nowYM;
                const isOutOfRange = (max ? ym > max : false) || (min ? ym < min : false);
                return (
                  <button
                    key={name}
                    type="button"
                    data-month={m}
                    disabled={isOutOfRange}
                    tabIndex={m === focusMonth ? 0 : -1}
                    onClick={() => select(viewY, m)}
                    onFocus={() => setFocusMonth(m)}
                    aria-current={isCurrent ? "date" : undefined}
                    aria-pressed={isSelected}
                    className="h-9 rounded-lg text-[12.5px] font-semibold cursor-pointer border-none grid place-items-center disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{
                      background: isSelected ? "var(--acc)" : "transparent",
                      color: isSelected ? "#fff" : "var(--ink)",
                      boxShadow: !isSelected && isCurrent ? "inset 0 0 0 1.5px var(--acc)" : undefined,
                    }}
                  >
                    {name}
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => select(Number(nowYM.slice(0, 4)), Number(nowYM.slice(5)))}
              className="text-[12px] font-semibold text-acc bg-transparent border-none cursor-pointer self-start p-0 hover:underline"
            >
              This month
            </button>
          </div>,
          document.body
        )}
    </>
  );
}
