// Shown instantly while the Analytics (Insights) RSC payload streams in.
import { SkeletonCard } from "@/components/shell/skeleton";

export default function AnalyticsLoading() {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap gap-3.5">
        <SkeletonCard h={76} className="flex-[1_1_160px]" />
        <SkeletonCard h={76} className="flex-[1_1_160px]" />
        <SkeletonCard h={76} className="flex-[1_1_160px]" />
      </div>
      <SkeletonCard h={36} className="md:hidden rounded-control" />
      <div className="flex flex-wrap gap-3.5">
        <SkeletonCard h={220} className="flex-[1.4_1_320px]" />
        <SkeletonCard h={220} className="flex-[1.4_1_320px] hidden md:block" />
        <SkeletonCard h={220} className="flex-[1_1_280px] hidden md:block" />
        <SkeletonCard h={220} className="flex-[1_1_240px] hidden md:block" />
      </div>
    </div>
  );
}
