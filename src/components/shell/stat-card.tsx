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
  action,
}: {
  label: string;
  value: React.ReactNode;
  /** When set, the whole card navigates there (and gains hover/focus affordances). */
  href?: string;
  children?: React.ReactNode;
  className?: string;
  /**
   * An interactive control for the card's top-right corner (e.g. the expense
   * basis toggle). Rendered as a SIBLING of the link, never inside it: a button
   * nested in an anchor is invalid HTML, traps screen readers between two
   * conflicting roles, and would fire the navigation on every tap.
   */
  action?: React.ReactNode;
}) {
  const labelEl = <div className="text-[11px] text-mut font-semibold tracking-[.06em]">{label}</div>;
  const body = (
    <>
      <div className="text-[21px] font-extrabold mt-[5px]">{value}</div>
      {children}
    </>
  );

  // No action: unchanged from before — the whole card is one link.
  if (!action) {
    const inner = (
      <>
        {labelEl}
        {body}
      </>
    );
    return href ? (
      <Link
        href={href}
        className={`card flex-[1_1_150px] p-[var(--pad)] no-underline text-ink block hover:border-acc focus-visible:outline-2 focus-visible:outline-acc ${className}`}
      >
        {inner}
      </Link>
    ) : (
      <div className={`card flex-[1_1_150px] p-[var(--pad)] ${className}`}>{inner}</div>
    );
  }

  // With an action, the label and the control share a flex row so the space is
  // reserved by the layout rather than by a hardcoded padding tied to the
  // control's width — a 104px reserve against a 124px toggle overlapped by 3px
  // at the dashboard's 3-up width, and any label or locale change would move
  // that number again. The action sits outside the link because a button nested
  // in an anchor is invalid HTML and would fire the navigation on every tap.
  return (
    <div className={`card flex-[1_1_150px] p-[var(--pad)] flex flex-col ${className}`}>
      <div className="flex items-start justify-between gap-2">
        {href ? (
          <Link href={href} className="no-underline text-ink hover:text-acc focus-visible:outline-2 focus-visible:outline-acc min-w-0">
            {labelEl}
          </Link>
        ) : (
          labelEl
        )}
        <div className="shrink-0">{action}</div>
      </div>
      {href ? (
        <Link href={href} className="no-underline text-ink block focus-visible:outline-2 focus-visible:outline-acc">
          {body}
        </Link>
      ) : (
        body
      )}
    </div>
  );
}
