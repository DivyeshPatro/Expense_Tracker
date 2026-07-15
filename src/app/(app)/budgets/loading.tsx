// Shown instantly while the Budgets RSC payload streams in.
export default function BudgetsLoading() {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="card p-[var(--pad)] flex flex-col gap-[18px]">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton h-[46px] rounded-[10px]" />
        ))}
      </div>
    </div>
  );
}
