// Shown instantly while the Transactions RSC payload streams in. Mirrors the
// redesigned Spends layout: Spends/Insights toggle, the summary tile, filter
// chips, search, then the transaction rows.
import { SkeletonCard, SkeletonPill, SkeletonRows } from "@/components/shell/skeleton";

export default function TransactionsLoading() {
  return (
    <div className="flex flex-col gap-3.5">
      <SkeletonCard h={44} className="w-[200px]" />
      <SkeletonCard h={128} />
      <div className="flex gap-2">
        <SkeletonPill w={64} />
        <SkeletonPill w={88} />
        <SkeletonPill w={76} />
        <SkeletonPill w={92} />
      </div>
      <SkeletonCard h={46} />
      <SkeletonRows rows={8} h={52} />
    </div>
  );
}
