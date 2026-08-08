// EPIC 14 / issue #185–#191: the one rule this app now follows on every module
// screen — *the answer is the hero, the action is a FAB*.
//
// The audit measured the largest rendered element in the top viewport of all 13
// screens. On 9 of them it was a "＋", an emoji, or a chevron: the screen's most
// prominent statement was "add more stuff", not "here is your money". Only
// Dashboard and Transactions led with a figure.
//
// This component is that figure. One hero number answering the screen's primary
// question, an eyebrow naming it, a sub-line qualifying it, and — optionally —
// subordinate values under a rule. Deliberately NOT the StatCard row it
// replaces: three equal-weight cards give the eye nothing to land on, so it
// lands on nothing.
//
// Server-compatible (no "use client"): pure presentation, usable from RSC pages.

import Link from "next/link";

export interface HeroStat {
  label: string;
  value: React.ReactNode;
  /** A CSS colour for the value — semantic (green/red), never the brand accent. */
  color?: string;
  href?: string;
}

export function ModuleHero({
  eyebrow,
  value,
  valueColor,
  sub,
  secondary = [],
  href,
  tone = "neutral",
}: {
  /** Names the figure. Answers "what am I looking at?" — e.g. "You'll get". */
  eyebrow: string;
  /** The answer. Rendered at 34px, the largest thing on the screen. */
  value: React.ReactNode;
  valueColor?: string;
  /** Qualifies the figure — e.g. "from 3 people · 1 overdue". */
  sub?: React.ReactNode;
  /** Subordinate values, under a rule. Kept visually quiet on purpose. */
  secondary?: HeroStat[];
  /** Makes the hero figure itself a deep link. */
  href?: string;
  /** A hairline accent along the top edge, for screens with an urgent state. */
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  const toneVar = tone === "good" ? "var(--green)" : tone === "warn" ? "var(--amber)" : tone === "bad" ? "var(--red)" : null;

  const figure = (
    <>
      <div className="text-[11.5px] font-semibold text-mut">{eyebrow}</div>
      <div
        className="text-[34px] font-extrabold tracking-[-.035em] leading-none mt-[6px] tabular-nums"
        style={valueColor ? { color: valueColor } : undefined}
      >
        {value}
      </div>
      {sub && <div className="text-[12px] text-mut mt-1.5">{sub}</div>}
    </>
  );

  return (
    <section
      className="relative overflow-hidden rounded-[20px] bg-card border border-line p-[18px] flex flex-col"
      style={{ boxShadow: "var(--sh)" }}
    >
      {toneVar && <span aria-hidden className="absolute left-0 right-0 top-0 h-[3px]" style={{ background: toneVar }} />}
      {href ? (
        <Link href={href} className="no-underline text-ink block focus-visible:outline-2 focus-visible:outline-acc rounded">
          {figure}
        </Link>
      ) : (
        figure
      )}
      {secondary.length > 0 && (
        <div className="flex flex-wrap gap-x-5 gap-y-2 mt-3.5 pt-3 border-t border-line">
          {secondary.map((s) => {
            const inner = (
              <>
                <span className="block text-[10.5px] font-semibold text-mut2 uppercase tracking-[.06em]">{s.label}</span>
                <span className="block text-[14px] font-bold tabular-nums mt-0.5" style={s.color ? { color: s.color } : undefined}>
                  {s.value}
                </span>
              </>
            );
            return s.href ? (
              <Link
                key={s.label}
                href={s.href}
                className="no-underline text-ink min-h-[44px] flex flex-col justify-center focus-visible:outline-2 focus-visible:outline-acc rounded"
              >
                {inner}
              </Link>
            ) : (
              <div key={s.label} className="min-h-[44px] flex flex-col justify-center">
                {inner}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
