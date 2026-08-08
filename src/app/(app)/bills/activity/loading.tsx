import { SkeletonPill, SkeletonCard } from "@/components/shell/skeleton";

export default function Loading() {
  return (
    <div className="flex flex-col gap-3.5">
      <SkeletonPill w={220} h={52} />
      <SkeletonCard h={320} />
    </div>
  );
}
