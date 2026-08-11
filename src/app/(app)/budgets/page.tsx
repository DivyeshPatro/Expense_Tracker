import { OpenModalButton } from "@/components/shell/buttons";
import { ModuleHero } from "@/components/shell/module-hero";
import { EmptyState } from "@/components/shell/empty-state";
import { ModuleTabs, BUDGETS_TABS } from "@/components/shell/module-tabs";
import { BudgetActions } from "./budget-actions";
import { summarizeBudgets } from "@/lib/budget-summary";
import { formatPaise } from "@/lib/money";
import { soft } from "@/lib/tx-display";
import { listBudgets } from "@/server/services/budgets";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function BudgetsPage() {
  const user = await requireUser();
  const budgets = await listBudgets(user.id);

  // #191: the screen answers "am I within budget?" — the ＋ New budget button
  // used to be the largest element on it.
  // Header figures come from one pure helper so "left", "spent" and "budgeted"
  // can't drift apart again — see src/lib/budget-summary.ts for why they did.
  const { leftInBudget, spent, budgeted, overAmount, overCount: over } = summarizeBudgets(budgets);

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      <ModuleTabs tabs={BUDGETS_TABS} />
      {budgets.length > 0 && (
        <ModuleHero
          // "in budgets under limit" rather than a bare "Left to spend":
          // headroom inside an overspent category isn't spendable, so this is
          // deliberately not Budgeted − Spent. The "Over" chip below carries
          // the difference so the three numbers visibly reconcile.
          eyebrow={over > 0 ? "Left in budgets under limit" : "Left to spend this month"}
          value={formatPaise(leftInBudget)}
          valueColor={over > 0 ? "var(--red)" : "var(--green)"}
          sub={
            over > 0
              ? `${over} of ${budgets.length} over limit by ${formatPaise(overAmount)} · ${formatPaise(budgeted)} − ${formatPaise(spent)} + ${formatPaise(overAmount)}`
              : `all ${budgets.length} within limit`
          }
          tone={over > 0 ? "bad" : "good"}
          secondary={[
            { label: "Spent", value: formatPaise(spent) },
            { label: "Budgeted", value: formatPaise(budgeted) },
            ...(over > 0 ? [{ label: "Over", value: formatPaise(overAmount) }] : []),
          ]}
        />
      )}
      <div className="card p-[var(--pad)] flex flex-col gap-[18px]">
        {budgets.length === 0 && (
          <EmptyState
            icon="◔"
            title="Set a monthly limit, spend with confidence"
            detail="Pick a category and a monthly cap — Ledgerly tracks your spending against it and warns you before you go over."
            action={<OpenModalButton type="budget" className="btn-primary">Set your first budget</OpenModalButton>}
          />
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
            <BudgetActions budget={b} />
          </div>
        ))}
      </div>
    </div>
  );
}
