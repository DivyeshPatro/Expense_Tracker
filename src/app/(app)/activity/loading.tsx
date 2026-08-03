// Shown instantly while the Activity RSC payload streams in.
import { SkeletonCard, SkeletonLine } from "@/components/shell/skeleton";

export default function ActivityLoading() {
  return (
    <div className="flex flex-col gap-3.5">
      <SkeletonCard h={36} className="w-[320px] max-w-full rounded-control" />
      <SkeletonLine w="64px" />
      <SkeletonCard h={260} />
      <SkeletonLine w="80px" />
      <SkeletonCard h={180} />
    </div>
  );
}
