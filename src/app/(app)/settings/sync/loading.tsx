// Shown instantly while the Sync Center RSC payload streams in.
import { SkeletonCard } from "@/components/shell/skeleton";

export default function SyncCenterLoading() {
  return (
    <div className="flex flex-col gap-3.5">
      <SkeletonCard h={90} />
      <div className="card p-6 flex flex-col gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <SkeletonCard key={i} h={42} className="rounded-control" />
        ))}
      </div>
    </div>
  );
}
