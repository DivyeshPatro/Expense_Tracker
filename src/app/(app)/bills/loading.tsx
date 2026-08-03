// Shown instantly while the Bills RSC payload streams in. Mirrors the
// redesigned mobile layout: the New-bill button then tappable bill cards.
import { SkeletonCard } from "@/components/shell/skeleton";

export default function BillsLoading() {
  return (
    <div className="flex flex-col gap-2.5">
      <SkeletonCard h={44} className="w-full md:w-[128px] md:ml-auto rounded-control" />
      {Array.from({ length: 5 }).map((_, i) => (
        <SkeletonCard key={i} h={72} className="rounded-sheet" />
      ))}
    </div>
  );
}
