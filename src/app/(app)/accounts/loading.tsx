// Shown instantly while the Accounts RSC payload streams in.
import { SkeletonCard } from "@/components/shell/skeleton";

export default function AccountsLoading() {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap gap-3.5">
        <SkeletonCard h={110} className="flex-[1_1_220px]" />
        <SkeletonCard h={110} className="flex-[1_1_220px]" />
        <SkeletonCard h={110} className="flex-[1_1_220px]" />
        <SkeletonCard h={110} className="flex-[1_1_220px]" />
      </div>
      <SkeletonCard h={180} />
    </div>
  );
}
