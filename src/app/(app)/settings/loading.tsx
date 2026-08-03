// Shown instantly while the Settings RSC payload streams in.
import { SkeletonCard } from "@/components/shell/skeleton";

export default function SettingsLoading() {
  return (
    <div className="flex flex-col gap-4 max-w-[640px]">
      {Array.from({ length: 3 }).map((_, i) => (
        <SkeletonCard key={i} h={120} />
      ))}
    </div>
  );
}
