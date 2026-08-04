// Shown instantly while the Cards RSC payload streams in — mirrors the compact
// wallet list so the layout doesn't jump when the rows arrive.
import { Skeleton } from "@/components/shell/skeleton";

export default function CardsLoading() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-[14px] border border-line bg-card p-2.5">
          <Skeleton className="w-[58px] h-[38px] rounded-[8px] flex-none" />
          <div className="flex-1 flex flex-col gap-1.5">
            <Skeleton className="h-3 w-1/3 rounded" />
            <Skeleton className="h-2.5 w-3/5 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}
