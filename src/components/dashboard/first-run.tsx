"use client";

// First-run guidance on the dashboard.
//
// A brand-new account previously landed on ₹0, ₹0, ₹0, one auto-created Cash
// Wallet, an empty card, and a "Needs your attention → All caught up" panel.
// Telling someone they are all caught up before they have done anything is
// hollow, and nothing on the screen said what to do first.
//
// State is DERIVED from the user's data, never stored as a "hasOnboarded"
// flag. A flag can disagree with reality — dismissed but empty, or completed
// then everything deleted — and then the dashboard lies. Deriving it means the
// card is correct by construction and disappears the moment it stops being
// true, with nothing to migrate or reset.

import Link from "next/link";
import { useUI } from "@/components/shell/ui-context";

export interface FirstRunState {
  /** Any account beyond the auto-created starter, or any opening balance set. */
  accountsReady: boolean;
  /** At least one transaction exists. */
  hasTransactions: boolean;
}

export function FirstRunCard({ state }: { state: FirstRunState }) {
  const { openModal } = useUI();

  const steps = [
    {
      done: state.accountsReady,
      title: "Set up your accounts",
      detail: "Add the banks, wallets and cards you actually use, with what's in them today.",
      cta: (
        <button onClick={() => openModal("account")} className="btn-primary text-[12.5px] font-bold px-3.5 min-h-[40px]">
          Add an account
        </button>
      ),
    },
    {
      done: state.hasTransactions,
      title: "Record something",
      detail: "An amount and a merchant is enough — Ledgerly fills in the rest next time.",
      cta: (
        <button onClick={() => openModal("compose")} className="btn-primary text-[12.5px] font-bold px-3.5 min-h-[40px]">
          Add an expense
        </button>
      ),
    },
    {
      done: state.hasTransactions,
      title: "Or bring your history in",
      detail: "Import from Monito, Khatabook, a bank statement, or any spreadsheet. Nothing is saved until you confirm.",
      cta: (
        <Link href="/import" className="btn-ghost text-[12.5px] font-bold px-3.5 min-h-[40px] inline-flex items-center no-underline">
          Open Import
        </Link>
      ),
    },
  ];

  // The first thing still outstanding — one clear next action rather than three
  // competing ones.
  const nextIndex = steps.findIndex((s) => !s.done);

  return (
    <section
      className="rounded-[18px] p-[var(--pad)] border border-line2"
      style={{
        background:
          "radial-gradient(120% 120% at 90% -20%, color-mix(in oklab,var(--acc) 14%, transparent), transparent 55%), var(--card)",
      }}
      aria-labelledby="first-run-heading"
    >
      <h2 id="first-run-heading" className="text-[15px] font-extrabold tracking-[-.01em] m-0">
        Let&apos;s get your ledger started
      </h2>
      <p className="text-[12.5px] text-mut mt-1 mb-3.5">Two minutes now and the numbers above start meaning something.</p>

      <ol className="flex flex-col gap-2.5 m-0 p-0 list-none">
        {steps.map((s, i) => {
          const isNext = i === nextIndex;
          return (
            <li
              key={s.title}
              className="flex items-start gap-3 rounded-[13px] p-3 border"
              style={{
                borderColor: isNext ? "var(--acc)" : "var(--line2)",
                background: isNext ? "var(--accSoft)" : "transparent",
                opacity: s.done ? 0.6 : 1,
              }}
            >
              <span
                aria-hidden="true"
                className="w-6 h-6 flex-none rounded-full grid place-items-center text-[12px] font-bold"
                style={{
                  background: s.done ? "var(--greenSoft)" : "var(--bg)",
                  color: s.done ? "var(--green)" : "var(--mut)",
                  border: s.done ? "none" : "1px solid var(--line2)",
                }}
              >
                {s.done ? "✓" : i + 1}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[13.5px] font-bold">
                  {s.title}
                  {/* Spoken, not just coloured — the tick is aria-hidden. */}
                  {s.done && <span className="sr-only"> — done</span>}
                </span>
                <span className="block text-[12px] text-mut mt-0.5">{s.detail}</span>
                {!s.done && <span className="block mt-2.5">{s.cta}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
