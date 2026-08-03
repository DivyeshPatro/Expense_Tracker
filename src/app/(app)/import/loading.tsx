// Shown instantly while the Import RSC payload streams in.
import { SkeletonCard } from "@/components/shell/skeleton";

export default function ImportLoading() {
  return (
    <div className="flex flex-col gap-3.5">
      <SkeletonCard h={36} className="w-[220px] rounded-control" />
      <div className="card p-[var(--pad)] flex flex-col gap-3">
        <SkeletonCard h={140} />
        <SkeletonCard h={36} className="w-[160px] self-end rounded-control" />
      </div>
    </div>
  );
}
