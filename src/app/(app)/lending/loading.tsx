// Shown instantly while the Lending RSC payload streams in.
import { SkeletonCard, SkeletonLine, SkeletonPill } from "@/components/shell/skeleton";

export default function LendingLoading() {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <SkeletonLine w="280px" />
        <div className="flex gap-2">
          <SkeletonPill w={104} h={36} className="!rounded-control" />
          <SkeletonPill w={100} h={36} className="!rounded-control" />
        </div>
      </div>
      <SkeletonCard h={36} className="md:hidden rounded-control" />
      <div className="flex flex-wrap gap-3.5">
        <SkeletonCard h={76} className="flex-[1_1_160px]" />
        <SkeletonCard h={76} className="flex-[1_1_160px]" />
        <SkeletonCard h={76} className="flex-[1_1_160px]" />
      </div>
      <div className="flex flex-wrap gap-3.5 items-start">
        <SkeletonCard h={260} className="flex-[1_1_320px]" />
        <SkeletonCard h={260} className="flex-[1.3_1_320px]" />
      </div>
    </div>
  );
}
