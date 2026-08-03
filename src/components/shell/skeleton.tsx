// Composable loading-skeleton primitives shared by every route's loading.tsx.
// All build on the `.skeleton` utility (the branded shimmer in globals.css) and
// the named radius scale, so route fallbacks stay consistent instead of each
// hand-rolling its own dimensions and corner radii.

export function Skeleton({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`skeleton ${className}`} style={style} aria-hidden />;
}

/** A card-shaped block (rounded-card). `h` in px or any CSS length. */
export function SkeletonCard({ h = 120, className = "", style }: { h?: number | string; className?: string; style?: React.CSSProperties }) {
  return <Skeleton className={`rounded-card ${className}`} style={{ height: typeof h === "number" ? `${h}px` : h, ...style }} />;
}

/** A vertical stack of list-row blocks (rounded-control). */
export function SkeletonRows({ rows = 5, h = 52, className = "" }: { rows?: number; h?: number; className?: string }) {
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="rounded-control" style={{ height: `${h}px` }} />
      ))}
    </div>
  );
}

/** A single text-line block. `w` any CSS length. */
export function SkeletonLine({ w = "100%", h = 16, className = "" }: { w?: string; h?: number; className?: string }) {
  return <Skeleton className={`rounded ${className}`} style={{ width: w, height: `${h}px` }} />;
}

/** A pill block (rounded-full) — e.g. the period trigger, filter chips. */
export function SkeletonPill({ w = 120, h = 32, className = "" }: { w?: number | string; h?: number; className?: string }) {
  return <Skeleton className={`rounded-full ${className}`} style={{ width: typeof w === "number" ? `${w}px` : w, height: `${h}px` }} />;
}
