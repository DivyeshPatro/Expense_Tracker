import { OpenModalButton, PayBillButton } from "@/components/shell/buttons";
import { EmptyState } from "@/components/shell/empty-state";
import { ModuleActivity } from "@/components/shell/module-activity";
import { BillActions, MobileBills, PaidBills } from "./bill-actions";
import { formatPaise } from "@/lib/money";
import { soft } from "@/lib/tx-display";
import { billUrgencyBackground, billUrgencyColor } from "@/lib/urgency";
import { listBills, listPaidBills } from "@/server/services/bills";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function BillsPage() {
  const user = await requireUser();
  const [bills, paidBills] = await Promise.all([listBills(user.id), listPaidBills(user.id)]);

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      <div className="flex justify-end">
        <OpenModalButton type="bill" className="btn-primary w-full md:w-auto">＋ New bill</OpenModalButton>
      </div>

      {bills.length === 0 && (
        <div className="card px-4 py-1.5">
          <EmptyState icon="🧾" title="No bills tracked yet" detail="Add rent, electricity, subscriptions — anything with a due date." />
        </div>
      )}

      {/* Mobile: tappable cards → action sheet. */}
      <MobileBills bills={bills} />

      {/* Desktop: the inline table stays as-is. */}
      {bills.length > 0 && (
        <div className="hidden md:block card px-4 py-1.5">
          {bills.map((b) => (
            <div key={b.id} className="flex items-center gap-3 py-[13px] border-b border-line last:border-b-0 flex-wrap">
              <div className="w-[38px] h-[38px] rounded-[11px] grid place-items-center text-base flex-none" style={{ background: soft(b.color) }}>{b.icon}</div>
              <div className="flex-1 min-w-[140px]">
                <div className="text-[13px] font-bold">{b.name}</div>
                <div className="text-[11.5px] text-mut2">{b.cadence ? `🔁 ${b.cadence}` : "One-off"}</div>
              </div>
              <div
                className="px-2.5 py-1 rounded-full text-[11px] font-bold"
                style={{ background: billUrgencyBackground(b.urgency), color: billUrgencyColor(b.urgency) }}
              >
                {b.dueLabel}
              </div>
              <div className="text-sm font-extrabold min-w-[80px] text-right">{formatPaise(b.amount)}</div>
              <PayBillButton billId={b.id} label={`${b.name} paid · ${formatPaise(b.amount)}`} />
              <BillActions bill={b} />
            </div>
          ))}
        </div>
      )}

      <PaidBills bills={paidBills} />
      <ModuleActivity entities={["Bill"]} />
    </div>
  );
}
