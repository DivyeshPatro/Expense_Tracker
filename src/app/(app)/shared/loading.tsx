// Shown instantly while the Shared RSC payload streams in.
import { SkeletonCard } from "@/components/shell/skeleton";

export default function SharedLoading() {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap gap-3.5">
        <SkeletonCard h={80} className="flex-[1_1_160px]" />
        <SkeletonCard h={80} className="flex-[1_1_160px]" />
      </div>
      <SkeletonCard h={220} />
    </div>
  );
}
