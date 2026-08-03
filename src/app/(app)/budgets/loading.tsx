// Shown instantly while the Budgets RSC payload streams in.
import { SkeletonCard } from "@/components/shell/skeleton";

export default function BudgetsLoading() {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="card p-[var(--pad)] flex flex-col gap-[18px]">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} h={46} className="rounded-control" />
        ))}
      </div>
    </div>
  );
}
