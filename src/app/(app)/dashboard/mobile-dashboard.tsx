"use client";

// Mobile-native Dashboard (Direction A "Cockpit"). Shown only below md; the
// desktop dashboard is untouched. Reads values the server page already computed
// — no new queries — and leads with financial standing + what needs you, with
// secondary detail behind expandable cards. Quick actions open the same modals
// the rest of the app uses.

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatPaise } from "@/lib/money";
import { useUI } from "@/components/shell/ui-context";
import { BottomSheet } from "@/components/shell/bottom-sheet";
import { Toggle } from "@/components/shell/toggle";

// Widgets the user can show/hide (stored on the device). The hero standing
// card and quick actions are the dashboard's spine and stay put; everything
// below is optional so the landing view can be as lean or complete as each
// person wants.
const TOGGLEABLE = [
  { key: "cashflow", label: "Cash flow" },
  { key: "khata", label: "Khata · lending" },
  { key: "bills", label: "Upcoming bills" },
  { key: "budgets", label: "Budgets" },
  { key: "recent", label: "Recent activity" },
] as const;
const HIDDEN_KEY = "ledgerly-dash-hidden";

export interface MobileDashboardData {
  greeting: string;
  name: string;
  netPosition: number;
  monthDelta: number;
  comp: { banks: number; owed: number; cash: number; cards: number };
  flow: { income: number; expense: number };
  needs: { icon: string; text: string; sub: string; href: string; sev: "red" | "amber" }[];
  lending: { owed: number; owe: number; net: number; overdue: number; people: number };
  bills: { name: string; amount: number; dueLabel: string }[];
  billsCount: number;
  billsTotal: number;
  budgets: { name: string; spent: number; limit: number; over: boolean }[];
  budgetsOver: number;
  recent: { icon: string; title: string; sub: string; amtF: string; amtColor: string }[];
}

const sign = (p: number) => (p < 0 ? "−" : "+") + formatPaise(p);

export function MobileDashboard({ data }: { data: MobileDashboardData }) {
  const { openModal } = useUI();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [customizing, setCustomizing] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(HIDDEN_KEY);
      if (raw) setHidden(new Set(JSON.parse(raw) as string[]));
    } catch {}
  }, []);
  const toggle = (k: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      try {
        localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  const show = (k: string) => !hidden.has(k);
  const c = data.comp;
  const parts = [
    { key: "Banks", v: Math.abs(c.banks), color: "var(--acc)" },
    { key: "Owed to you", v: Math.abs(c.owed), color: "var(--green)" },
    { key: "Cash", v: Math.abs(c.cash), color: "var(--amber)" },
    { key: "Cards", v: Math.abs(c.cards), color: "var(--red)", neg: true },
  ].filter((p) => p.v > 0);
  const compTotal = parts.reduce((s, p) => s + p.v, 0) || 1;
  const spentPct = data.flow.income > 0 ? Math.min(100, Math.round((data.flow.expense / data.flow.income) * 100)) : 0;

  return (
    <div className="md:hidden flex flex-col gap-3" style={{ animation: "rise .25s ease" }}>
      {/* HERO — standing */}
      <section
        className="rounded-[22px] p-[18px] border border-line2"
        style={{ background: "radial-gradient(130% 120% at 88% -20%, color-mix(in oklab,var(--acc) 22%, transparent), transparent 55%), linear-gradient(160deg, var(--side), var(--card))", boxShadow: "var(--shLg)" }}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[11.5px] text-mut font-semibold flex items-center gap-2">
              <span className="w-2 h-2 rounded-full" style={{ background: data.netPosition >= 0 ? "var(--green)" : "var(--red)", boxShadow: "0 0 0 4px var(--greenSoft)" }} />
              Net standing
            </div>
            <div className="text-[38px] font-extrabold tracking-[-.035em] leading-none mt-[7px] tabular-nums">
              {data.netPosition < 0 ? "−" : ""}{formatPaise(data.netPosition)}
            </div>
            <div className="text-[12.5px] font-bold mt-1 tabular-nums" style={{ color: data.monthDelta >= 0 ? "var(--green)" : "var(--red)" }}>
              {data.monthDelta >= 0 ? "▲" : "▼"} {formatPaise(data.monthDelta)} <span className="text-mut font-semibold">this month</span>
            </div>
          </div>
        </div>
        {/* composition bar */}
        <div className="mt-4 h-3 rounded-full overflow-hidden flex gap-[2px]" style={{ background: "var(--side)" }} role="img" aria-label="Money composition">
          {parts.map((p) => (
            <span key={p.key} style={{ flex: `0 0 ${(p.v / compTotal) * 100}%`, background: p.color, borderRadius: "3px", opacity: p.neg ? 0.85 : 1 }} />
          ))}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2 mt-3">
          {parts.map((p) => (
            <div key={p.key} className="flex items-center gap-[7px] text-[11.5px] text-mut">
              <i className="w-2 h-2 rounded-[3px]" style={{ background: p.color }} />
              {p.key} <b className="text-ink tabular-nums">{p.neg ? "−" : ""}{formatPaise(p.v)}</b>
            </div>
          ))}
        </div>
      </section>

      {/* NEEDS YOU */}
      {data.needs.length > 0 && (
        <>
          <Eyebrow>Needs you</Eyebrow>
          <div className="flex flex-col gap-2.5">
            {data.needs.map((n, i) => (
              <Link
                key={i}
                href={n.href}
                className="flex items-center gap-3 p-3.5 rounded-2xl bg-card border border-line relative overflow-hidden no-underline text-ink active:scale-[.985] transition-transform"
              >
                <span className="absolute left-0 top-0 bottom-0 w-1" style={{ background: `var(--${n.sev})` }} />
                <span className="w-[38px] h-[38px] rounded-xl grid place-items-center text-[17px]" style={{ background: `var(--${n.sev}Soft)` }}>{n.icon}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13.5px] font-bold tracking-[-.01em] truncate">{n.text}</span>
                  <span className="block text-[11.5px] text-mut truncate">{n.sub}</span>
                </span>
                <span className="text-[11.5px] font-bold flex-none" style={{ color: `var(--${n.sev})` }}>›</span>
              </Link>
            ))}
          </div>
        </>
      )}

      {/* QUICK ACTIONS */}
      <Eyebrow>Quick actions</Eyebrow>
      <div className="grid grid-cols-4 gap-2.5">
        <QuickAction label="Expense" tint="red" onClick={() => openModal("exp")} d="M12 19V5M5 12l7 7 7-7" />
        <QuickAction label="Income" tint="green" onClick={() => openModal("inc")} d="M12 5v14M5 12l7-7 7 7" />
        <QuickAction label="Lend" tint="acc" onClick={() => openModal("lendingEntry")} d="M8 7h11M8 7l3-3M8 7l3 3M16 17H5M16 17l-3-3M16 17l-3 3" />
        <QuickAction label="Bills" tint="amber" href="/bills" d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      </div>

      {/* CASH FLOW */}
      {show("cashflow") && (
      <SectionCard
        tint="acc" title="Cash flow" sub={spentPct <= 90 ? "On track" : "Watch spending"}
        value={<span style={{ color: data.monthDelta >= 0 ? "var(--green)" : "var(--red)" }}>{sign(data.monthDelta)}</span>} valueSub="net · this month" open
      >
        <div className="flex gap-2.5">
          <div className="flex-1 rounded-xl p-3" style={{ background: "var(--side)" }}>
            <div className="text-[10.5px] uppercase tracking-wide font-bold text-mut2">In</div>
            <div className="text-[17px] font-extrabold tabular-nums" style={{ color: "var(--green)" }}>{formatPaise(data.flow.income)}</div>
          </div>
          <div className="flex-1 rounded-xl p-3" style={{ background: "var(--side)" }}>
            <div className="text-[10.5px] uppercase tracking-wide font-bold text-mut2">Out</div>
            <div className="text-[17px] font-extrabold tabular-nums" style={{ color: "var(--red)" }}>{formatPaise(data.flow.expense)}</div>
          </div>
        </div>
        <div className="h-2 rounded-full mt-3 overflow-hidden" style={{ background: "var(--redSoft)" }}>
          <span className="block h-full rounded-full" style={{ width: `${spentPct}%`, background: "var(--green)" }} />
        </div>
        <div className="text-[11px] text-mut mt-2">You’ve spent <b className="text-ink tabular-nums">{spentPct}%</b> of what you earned this month.</div>
      </SectionCard>
      )}

      {/* LENDING */}
      {show("khata") && (
      <SectionCard
        tint="green" title="Khata · you’ll get" sub={`${data.lending.people} ${data.lending.people === 1 ? "person" : "people"}${data.lending.overdue ? ` · ${data.lending.overdue} overdue` : ""}`}
        value={<span style={{ color: "var(--green)" }}>{formatPaise(data.lending.owed)}</span>} valueSub={data.lending.owe > 0 ? `−${formatPaise(data.lending.owe)} you’ll pay` : "nothing to pay"} href="/lending"
      >
        <Row label="You’ll get" value={<span className="text-green">{formatPaise(data.lending.owed)}</span>} />
        <Row label="You’ll pay" value={<span className="text-red">−{formatPaise(data.lending.owe)}</span>} />
        <Row label="Net" value={<span style={{ color: data.lending.net < 0 ? "var(--red)" : "var(--green)" }}>{sign(data.lending.net)}</span>} strong />
      </SectionCard>
      )}

      {/* BILLS */}
      {show("bills") && data.billsCount > 0 && (
        <SectionCard
          tint="amber" title="Upcoming bills" sub={`${data.billsCount} within 10 days`}
          value={<span>{formatPaise(data.billsTotal)}</span>} valueSub="due soon" href="/bills"
        >
          {data.bills.map((b, i) => (
            <Row key={i} label={b.name} sub={b.dueLabel} value={<span className="tabular-nums">{formatPaise(b.amount)}</span>} />
          ))}
        </SectionCard>
      )}

      {/* BUDGETS */}
      {show("budgets") && data.budgets.length > 0 && (
        <SectionCard
          tint="acc" title="Budgets" sub={data.budgetsOver > 0 ? `${data.budgetsOver} over limit` : "all within limit"}
          value={<span style={{ color: data.budgetsOver > 0 ? "var(--red)" : "var(--ink)" }}>{data.budgetsOver || "✓"}</span>} valueSub={data.budgetsOver > 0 ? "over" : "on track"} href="/budgets"
        >
          {data.budgets.map((b, i) => {
            const pct = b.limit > 0 ? Math.min(100, Math.round((b.spent / b.limit) * 100)) : 0;
            const col = b.over ? "var(--red)" : pct >= 80 ? "var(--amber)" : "var(--green)";
            return (
              <div key={i} className={i > 0 ? "mt-3" : ""}>
                <div className="flex justify-between items-baseline">
                  <span className="text-[12.5px] font-semibold">{b.name}</span>
                  <span className="text-[11.5px] text-mut tabular-nums">{formatPaise(b.spent)} / {formatPaise(b.limit)}</span>
                </div>
                <div className="h-[7px] rounded-full mt-1.5 overflow-hidden" style={{ background: "var(--side)" }}>
                  <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: col }} />
                </div>
              </div>
            );
          })}
        </SectionCard>
      )}

      {/* RECENT */}
      {show("recent") && (
        <>
          <Eyebrow href="/transactions">Recent activity</Eyebrow>
          {data.recent.length > 0 ? (
            <div className="rounded-[20px] bg-card border border-line px-4 py-1.5">
              {data.recent.map((r, i) => (
                <div key={i} className={`flex items-center gap-3 py-2.5 ${i > 0 ? "border-t border-line" : ""}`}>
                  <span className="w-[34px] h-[34px] rounded-[11px] grid place-items-center text-[15px]" style={{ background: "var(--side)" }}>{r.icon}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13px] font-semibold truncate">{r.title}</span>
                    <span className="block text-[11px] text-mut truncate">{r.sub}</span>
                  </span>
                  <span className="text-[13.5px] font-bold tabular-nums flex-none" style={{ color: r.amtColor }}>{r.amtF}</span>
                </div>
              ))}
            </div>
          ) : (
            <button
              onClick={() => openModal("exp")}
              className="rounded-[20px] bg-card border border-line border-dashed px-4 py-6 flex flex-col items-center gap-1.5 text-center cursor-pointer w-full active:scale-[.99] transition-transform"
            >
              <span className="text-[22px]">🧾</span>
              <span className="text-[13px] font-bold text-ink">No activity yet</span>
              <span className="text-[11.5px] text-mut">Add your first expense to see it here.</span>
            </button>
          )}
        </>
      )}

      {/* CUSTOMIZE */}
      <button
        onClick={() => setCustomizing(true)}
        className="mx-auto mt-1 mb-1 flex items-center gap-1.5 text-[11.5px] font-semibold text-mut2 bg-transparent border-none cursor-pointer active:opacity-70"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M3 12h2.5M18.5 12H21M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" /></svg>
        Customize dashboard
      </button>

      {customizing && <CustomizeSheet hidden={hidden} onToggle={toggle} close={() => setCustomizing(false)} />}
    </div>
  );
}

function CustomizeSheet({ hidden, onToggle, close }: { hidden: Set<string>; onToggle: (k: string) => void; close: () => void }) {
  return (
    <BottomSheet onClose={close} label="Customize dashboard" maxWidth={420}>
      <h2 className="text-[13px] font-bold text-mut2 uppercase tracking-wide px-1 pb-1">Show on dashboard</h2>
      <p className="text-[11.5px] text-mut2 px-1 pb-2">Your standing and quick actions always stay. Pick what else appears.</p>
      <div className="flex flex-col">
        {TOGGLEABLE.map((w) => {
          const on = !hidden.has(w.key);
          return (
            <button
              key={w.key}
              role="switch"
              aria-checked={on}
              onClick={() => onToggle(w.key)}
              className="flex items-center justify-between gap-3 min-h-[48px] px-2 py-2 rounded-[11px] cursor-pointer bg-transparent border-none hover:bg-accsoft text-left"
            >
              <span className="text-[13.5px] font-semibold text-ink">{w.label}</span>
              <Toggle on={on} />
            </button>
          );
        })}
      </div>
      <button onClick={close} className="mt-3 h-11 rounded-[12px] text-[13.5px] font-bold text-white bg-acc border-none cursor-pointer">Done</button>
    </BottomSheet>
  );
}

function Eyebrow({ children, href }: { children: React.ReactNode; href?: string }) {
  return (
    <div className="flex items-center justify-between mx-1 mt-1">
      <span className="text-[10.5px] font-bold tracking-[.09em] uppercase text-mut2">{children}</span>
      {href && <Link href={href} className="text-[11px] font-semibold text-acc no-underline">All</Link>}
    </div>
  );
}

function QuickAction({ label, tint, d, onClick, href }: { label: string; tint: string; d: string; onClick?: () => void; href?: string }) {
  const inner = (
    <>
      <span className="w-[38px] h-[38px] rounded-xl grid place-items-center" style={{ background: `var(--${tint}Soft)`, color: `var(--${tint})` }}>
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
      </span>
      <span className="text-[11px] font-semibold text-mut">{label}</span>
    </>
  );
  const cls = "border border-line bg-card rounded-2xl py-3 flex flex-col items-center gap-[7px] cursor-pointer active:scale-95 transition-transform no-underline";
  return href ? <Link href={href} className={cls}>{inner}</Link> : <button onClick={onClick} className={cls}>{inner}</button>;
}

function SectionCard({
  tint, title, sub, value, valueSub, href, open, children,
}: {
  tint: string; title: string; sub: string; value: React.ReactNode; valueSub: string; href?: string; open?: boolean; children: React.ReactNode;
}) {
  const [isOpen, setOpen] = useState(!!open);
  return (
    <section className="rounded-[20px] bg-card border border-line overflow-hidden" style={{ boxShadow: "var(--sh)" }}>
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-3 p-4 text-left cursor-pointer bg-transparent border-none">
        <span className="w-[34px] h-[34px] rounded-[10px] grid place-items-center flex-none" style={{ background: `var(--${tint}Soft)`, color: `var(--${tint})` }}>
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: "currentColor" }} />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[13.5px] font-bold tracking-[-.01em]">{title}</span>
          <span className="block text-[11.5px] text-mut">{sub}</span>
        </span>
        <span className="text-right flex-none">
          <span className="block text-[15px] font-extrabold tracking-[-.02em] tabular-nums">{value}</span>
          <span className="block text-[10.5px] text-mut">{valueSub}</span>
        </span>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--mut2)" strokeWidth="2" strokeLinecap="round" className="flex-none transition-transform" style={{ transform: isOpen ? "rotate(180deg)" : "none" }}><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {isOpen && (
        <div className="px-4 pb-4 pt-3.5 border-t border-line -mt-px">
          {children}
          {href && <Link href={href} className="block text-center mt-3 text-[12px] font-semibold text-acc no-underline">Open {title.split(" ")[0].toLowerCase() === "khata" ? "lending" : title.toLowerCase()} ›</Link>}
        </div>
      )}
    </section>
  );
}

function Row({ label, sub, value, strong }: { label: string; sub?: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className={`flex items-center gap-3 py-2 ${strong ? "border-t border-line mt-1 pt-2.5" : ""}`}>
      <span className="flex-1 min-w-0">
        <span className={`block text-[13px] ${strong ? "font-bold" : "font-medium text-mut"} truncate`}>{label}</span>
        {sub && <span className="block text-[11px] text-mut2 truncate">{sub}</span>}
      </span>
      <span className="text-[13.5px] font-bold tabular-nums flex-none">{value}</span>
    </div>
  );
}
