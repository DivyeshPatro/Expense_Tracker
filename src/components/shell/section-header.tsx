// Phase 2.5 (Finance Hub): the standard card-section header — h2 plus an
// optional right-aligned "All →" style link — previously repeated inline
// across Dashboard/Bills/Budgets/Shared/Analytics sections. Server-compatible.

import Link from "next/link";

export function SectionHeader({ title, href, linkLabel = "All →" }: { title: string; href?: string; linkLabel?: string }) {
  return (
    <div className="flex justify-between items-center">
      <h2 className="text-[13.5px] font-bold m-0">{title}</h2>
      {href && (
        <Link href={href} className="text-[11.5px] font-semibold no-underline">
          {linkLabel}
        </Link>
      )}
    </div>
  );
}
