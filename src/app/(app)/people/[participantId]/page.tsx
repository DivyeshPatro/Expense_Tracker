// Issue #207 — one person, one balance, both sources reconciled on screen.
//
// The row a user taps from /people. It shows the combined figure first, then
// exactly where it comes from, so the number is explained rather than asserted
// — and offers one Settle up that clears the whole relationship.

import Link from "next/link";
import { notFound } from "next/navigation";
import { ModuleHero } from "@/components/shell/module-hero";
import { OpenModalButton } from "@/components/shell/buttons";
import { formatPaise } from "@/lib/money";
import { SETTLED_THRESHOLD } from "@/lib/people";
import { personBalance } from "@/server/services/people";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function PersonPage({ params }: { params: Promise<{ participantId: string }> }) {
  const user = await requireUser();
  const { participantId } = await params;
  const person = await personBalance(user.id, participantId);
  if (!person) notFound();

  const owed = person.net > 0;
  const sources = [
    {
      key: "split",
      label: "Shared expenses",
      detail: "Bills you've split together",
      value: person.sharedNet,
      href: "/shared",
    },
    {
      key: "lent",
      label: "Money lent",
      detail: "Loans and repayments",
      value: person.lendingNet,
      href: `/lending?contact=${person.id}`,
    },
  ].filter((s) => Math.abs(s.value) > SETTLED_THRESHOLD);

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      <div className="flex items-center gap-2.5">
        <Link
          href="/people"
          aria-label="Back to People"
          className="w-11 h-11 rounded-[11px] grid place-items-center text-mut bg-card border border-line2 hover:bg-accsoft flex-none no-underline"
        >
          ←
        </Link>
        <span
          className="w-10 h-10 rounded-full grid place-items-center text-[14px] font-bold text-white flex-none"
          style={{ background: person.color }}
          aria-hidden
        >
          {person.initial}
        </span>
        <h1 className="text-[21px] font-extrabold tracking-[-.02em] m-0 truncate">{person.name}</h1>
      </div>

      <ModuleHero
        eyebrow={person.settled ? "All settled" : owed ? `${person.name} owes you` : `You owe ${person.name}`}
        value={person.settled ? "✓" : formatPaise(Math.abs(person.net))}
        valueColor={person.settled ? "var(--green)" : owed ? "var(--green)" : "var(--red)"}
        sub={
          person.settled
            ? "Nothing outstanding either way"
            : person.hasBothSources
              ? "Across shared expenses and money lent"
              : sources[0]?.detail
        }
        tone={person.overdueCount > 0 ? "bad" : person.settled ? "good" : "neutral"}
      />

      {/* The reconciliation: where the one number comes from. */}
      {sources.length > 0 && (
        <section className="card p-[var(--pad)] flex flex-col gap-1">
          <h2 className="text-[13.5px] font-bold m-0 mb-1">Where this comes from</h2>
          {sources.map((s) => (
            <Link
              key={s.key}
              href={s.href}
              className="flex items-center gap-3 py-2.5 min-h-[44px] no-underline text-ink border-b border-line last:border-b-0 hover:bg-accsoft -mx-1 px-1 rounded"
            >
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] font-semibold">{s.label}</span>
                <span className="block text-[11.5px] text-mut2">{s.detail}</span>
              </span>
              <span
                className="text-[13.5px] font-bold tabular-nums flex-none"
                style={{ color: s.value > 0 ? "var(--green)" : "var(--red)" }}
              >
                {s.value > 0 ? "+" : "−"}
                {formatPaise(Math.abs(s.value))}
              </span>
              <span aria-hidden className="text-mut2 text-[13px] flex-none">›</span>
            </Link>
          ))}
          {person.hasBothSources && (
            <div className="flex items-center gap-3 pt-2.5 mt-1 border-t border-line">
              <span className="flex-1 text-[13px] font-bold">Total</span>
              <span
                className="text-[15px] font-extrabold tabular-nums"
                style={{ color: owed ? "var(--green)" : "var(--red)" }}
              >
                {owed ? "+" : "−"}
                {formatPaise(Math.abs(person.net))}
              </span>
            </div>
          )}
        </section>
      )}

      {!person.settled && (
        <OpenModalButton
          type="settle"
          prefill={{
            participantId: person.id,
            participantName: person.name,
            direction: owed ? "TO_OWNER" : "FROM_OWNER",
            amountRupees: String(Math.round(Math.abs(person.net) / 100)),
            settleNetPaise: person.net,
          }}
          className="btn-primary w-full"
        >
          Settle up {formatPaise(Math.abs(person.net))}
        </OpenModalButton>
      )}
    </div>
  );
}
