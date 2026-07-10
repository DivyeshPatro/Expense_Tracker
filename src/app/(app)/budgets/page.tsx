import { OpenModalButton } from "@/components/shell/buttons";
import { formatPaise } from "@/lib/money";
import { soft } from "@/lib/tx-display";
import { listBudgets } from "@/server/services/budgets";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function BudgetsPage() {
  const user = await requireUser();
  const budgets = await listBudgets(user.id);

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      <div className="flex justify-end">
        <OpenModalButton type="budget" className="btn-primary">＋ New budget</OpenModalButton>
      </div>
      <div className="card p-[var(--pad)] flex flex-col gap-[18px]">
        {budgets.length === 0 && (
          <div className="text-center py-10 text-mut2 text-[13px]">No budgets yet — create one to keep a category in check.</div>
        )}
        {budgets.map((b) => (
          <div key={b.id}>
            <div className="flex items-center gap-2.5">
              <div className="w-[34px] h-[34px] rounded-[10px] grid place-items-center text-sm" style={{ background: soft(b.color) }}>{b.icon}</div>
              <div className="flex-1">
                <div className="text-[13px] font-bold">{b.category}</div>
                <div className="text-[11.5px] text-mut2">{formatPaise(b.spent)} of {formatPaise(b.limit)} · monthly</div>
              </div>
              <div className="text-[12.5px] font-bold" style={{ color: b.over ? "var(--red)" : b.warn ? "var(--amber)" : "var(--mut)" }}>
                {b.over ? `Over by ${formatPaise(b.spent - b.limit)}` : `${formatPaise(b.limit - b.spent)} left`}
              </div>
            </div>
            <div className="h-[7px] rounded bg-accsoft mt-2.5">
              <div
                className="h-full rounded"
                style={{ width: `${Math.min(100, b.pct)}%`, background: b.over ? "var(--red)" : b.warn ? "var(--amber)" : "var(--acc)" }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
