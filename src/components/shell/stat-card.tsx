// Phase 2.5 (Finance Hub): the one stat-card component. This exact visual
// contract (card + tiny tracking-wide label + big value) was previously
// re-implemented inline by Dashboard, Shared, Lending, and Analytics — now
// extracted so they all render the same thing. Server-compatible (no
// "use client"): pure presentation, usable directly from RSC pages.
// `href` makes the whole card a deep-link (Finance Hub requirement: "every
// summary card should deep-link") with a visible keyboard focus ring.

import Link from "next/link";

export function StatCard({
  label,
  value,
  href,
  children,
  className = "",
}: {
  label: string;
  value: React.ReactNode;
  /** When set, the whole card navigates there (and gains hover/focus affordances). */
  href?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const inner = (
    <>
      <div className="text-[11px] text-mut font-semibold tracking-[.06em]">{label}</div>
      <div className="text-[21px] font-extrabold mt-[5px]">{value}</div>
      {children}
    </>
  );
  if (href) {
    return (
      <Link
        href={href}
        className={`card flex-[1_1_150px] p-[var(--pad)] no-underline text-ink block hover:border-acc focus-visible:outline-2 focus-visible:outline-acc ${className}`}
      >
        {inner}
      </Link>
    );
  }
  return <div className={`card flex-[1_1_150px] p-[var(--pad)] ${className}`}>{inner}</div>;
}
