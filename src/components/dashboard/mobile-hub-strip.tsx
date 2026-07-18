// Phase 2.5 Finance Hub, mobile treatment (user-confirmed): the mobile
// dashboard stays deliberately lean (balance hero + spend + one attention
// item + recent transactions, from the earlier trim sprint) — this single
// horizontally-scrollable strip of compact deep-link cards is the one
// addition, making every module reachable from home without rebuilding the
// long scroll. Server component, md:hidden.

import Link from "next/link";
import { formatPaise } from "@/lib/money";

export interface HubStripData {
  lendingNet: number; // paise, positive ⇒ world owes you
  lendingOwed: number; // paise youAreOwed
  billsDueCount: number; // due within a week (overdue/urgent/soon)
  billsOverdue: boolean;
  pendingSettlements: number;
  netPosition: number; // paise
}

export function MobileHubStrip({ data }: { data: HubStripData }) {
  const cards: { href: string; icon: string; label: string; value: string; valueColor?: string }[] = [
    {
      href: "/lending",
      icon: "🤝",
      label: "Lending",
      value: data.lendingOwed > 0 ? `${formatPaise(data.lendingOwed)} owed to you` : "All square",
      valueColor: data.lendingOwed > 0 ? "var(--green)" : undefined,
    },
    {
      href: "/bills",
      icon: "🧾",
      label: "Bills",
      value: data.billsDueCount === 0 ? "Nothing due soon" : `${data.billsDueCount} due this week`,
      valueColor: data.billsOverdue ? "var(--red)" : data.billsDueCount > 0 ? "var(--amber)" : undefined,
    },
    {
      href: "/shared",
      icon: "👥",
      label: "Shared",
      value: data.pendingSettlements === 0 ? "All settled" : `${data.pendingSettlements} to settle`,
    },
    {
      href: "/accounts",
      icon: "💰",
      label: "Net position",
      value: `${data.netPosition < 0 ? "−" : ""}${formatPaise(data.netPosition)}`,
      valueColor: data.netPosition < 0 ? "var(--red)" : "var(--green)",
    },
  ];

  return (
    <div className="md:hidden flex gap-2.5 overflow-x-auto pb-1 -mx-1 px-1" style={{ scrollSnapType: "x proximity" }}>
      {cards.map((c) => (
        <Link
          key={c.href}
          href={c.href}
          className="card flex-none w-[150px] p-3 no-underline text-ink hover:border-acc focus-visible:outline-2 focus-visible:outline-acc"
          style={{ scrollSnapAlign: "start" }}
        >
          <div className="flex items-center gap-1.5 text-[11px] text-mut font-semibold">
            <span aria-hidden="true">{c.icon}</span>
            {c.label}
          </div>
          <div className="text-[12.5px] font-bold mt-1.5 truncate" style={c.valueColor ? { color: c.valueColor } : undefined}>
            {c.value}
          </div>
        </Link>
      ))}
    </div>
  );
}
