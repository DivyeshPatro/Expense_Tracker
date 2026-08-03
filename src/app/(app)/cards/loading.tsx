// Shown instantly while the Cards RSC payload streams in.
import { Skeleton } from "@/components/shell/skeleton";

export default function CardsLoading() {
  return (
    <div className="grid gap-3.5 grid-cols-[repeat(auto-fill,minmax(290px,1fr))]">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="rounded-[16px] aspect-[1.586] min-h-[190px]" />
      ))}
    </div>
  );
}
