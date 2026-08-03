// Shown instantly while the Dashboard RSC payload streams in (route-level
// Suspense fallback). Mirrors the real page's block shapes — the mobile hero +
// needs + quick actions + section cards below md, the wider grid at md+ — so
// nothing jumps when the actual content swaps in.
import { SkeletonCard, SkeletonLine } from "@/components/shell/skeleton";

export default function DashboardLoading() {
  return (
    <div className="flex flex-col gap-4">
      {/* Mobile: hero → needs → quick actions → section cards */}
      <div className="md:hidden flex flex-col gap-3">
        <SkeletonCard h={150} className="rounded-sheet" />
        <SkeletonLine w="72px" h={11} className="mx-1 mt-1" />
        <SkeletonCard h={66} />
        <SkeletonCard h={66} />
        <SkeletonLine w="96px" h={11} className="mx-1 mt-1" />
        <div className="grid grid-cols-4 gap-2.5">
          <SkeletonCard h={72} />
          <SkeletonCard h={72} />
          <SkeletonCard h={72} />
          <SkeletonCard h={72} />
        </div>
        <SkeletonCard h={68} />
        <SkeletonCard h={68} />
        <SkeletonCard h={68} />
      </div>

      {/* Desktop grid */}
      <div className="hidden md:flex flex-col gap-4">
        <div className="flex flex-wrap gap-3.5">
          <SkeletonCard h={110} className="flex-[1.5_1_250px]" />
          <SkeletonCard h={110} className="flex-[1_1_150px]" />
          <SkeletonCard h={110} className="flex-[1_1_150px]" />
          <SkeletonCard h={110} className="flex-[1_1_150px]" />
        </div>
        <div className="flex flex-wrap gap-3.5">
          <SkeletonCard h={220} className="flex-[1.6_1_320px]" />
          <SkeletonCard h={220} className="flex-[1_1_260px]" />
        </div>
        <div className="flex flex-wrap gap-3.5">
          <SkeletonCard h={180} className="flex-[1.1_1_280px]" />
          <SkeletonCard h={180} className="flex-[1_1_250px]" />
          <SkeletonCard h={180} className="flex-[1_1_250px]" />
        </div>
      </div>
    </div>
  );
}
