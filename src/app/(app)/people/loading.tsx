// Route-level fallback for People (#211) — every other route already had one;
// /people was added in #207 without it. Mirrors the real page's shapes: hero
// figure, then one row per person, so nothing jumps when content swaps in.
import { SkeletonCard, SkeletonRows } from "@/components/shell/skeleton";

export default function PeopleLoading() {
  return (
    <div className="flex flex-col gap-3.5">
      <SkeletonCard h={140} className="rounded-sheet" />
      <SkeletonRows rows={5} h={68} />
    </div>
  );
}
