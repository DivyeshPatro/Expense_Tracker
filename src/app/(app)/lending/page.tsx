// Lending module Dashboard: You are owed / You owe / Net Lending, an
// overdue count (Phase-1 approximation — see lendingBalances' own comment),
// the Contacts list (search + sorted by largest outstanding), and either
// Recent Entries or — on desktop, once a contact is selected — that
// contact's full ledger inline (Phase 1.5 item #12: two-pane instead of a
// modal on desktop; mobile still gets the modal sheet). Personal, not
// collaborative — reuses Participant for contacts but computes its own
// balance separate from Shared Expenses' net (different money flows, same
// person).
//
// Phase 2 adds three tabs (LendingTabs, mirrors AnalyticsTabs): Overview
// (the above, plus a Reminders panel), Card Recovery, and Reports — nested
// under this same route rather than new top-level nav items.

import { OpenModalButton } from "@/components/shell/buttons";
import { StatCard } from "@/components/shell/stat-card";
import { CardRecoveryDashboard } from "@/components/lending/card-recovery";
import { LendingReports } from "@/components/lending/lending-reports";
import { LendingTabs } from "@/components/lending/lending-tabs";
import { LendingWorkspace } from "@/components/lending/lending-workspace";
import { RemindersPanel } from "@/components/lending/reminders-panel";
import { formatPaise } from "@/lib/money";
import { cardRecoveryDashboard, lendingDashboardSummary, lendingReminders, lendingReportsData, listLoanEntries } from "@/server/services/lending";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function LendingPage() {
  const user = await requireUser();
  const [summary, recent, reminders, cardRecovery, reports] = await Promise.all([
    lendingDashboardSummary(user.id),
    listLoanEntries(user.id, { limit: 8 }),
    lendingReminders(user.id),
    cardRecoveryDashboard(user.id),
    lendingReportsData(user.id),
  ]);

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div className="text-[12.5px] font-semibold text-mut">Money you lend, borrow, and get repaid — personal, not shared.</div>
        <div className="flex gap-2">
          <OpenModalButton
            type="lendingEntry"
            prefill={{ loanKind: "GAVE" }}
            className="px-[13px] py-2 rounded-lg text-[12.5px] font-bold cursor-pointer border-none text-white bg-acc hover:brightness-108"
          >
            + You Gave
          </OpenModalButton>
          <OpenModalButton
            type="lendingEntry"
            prefill={{ loanKind: "GOT" }}
            className="px-[13px] py-2 rounded-lg text-[12.5px] font-bold cursor-pointer border-none text-white bg-green hover:brightness-108"
          >
            + You Got
          </OpenModalButton>
        </div>
      </div>

      <LendingTabs
        overview={
          <>
            <div className="flex flex-wrap gap-3.5 flex-[1_1_100%]">
              <StatCard label="YOU ARE OWED" value={<span className="text-green">{formatPaise(summary.youAreOwed)}</span>} />
              <StatCard label="YOU OWE" value={<span className="text-red">{formatPaise(summary.youOwe)}</span>} />
              <StatCard
                label="NET LENDING"
                value={
                  <span style={{ color: summary.net < 0 ? "var(--red)" : "var(--green)" }}>
                    {summary.net < 0 ? "−" : "+"}
                    {formatPaise(Math.abs(summary.net))}
                  </span>
                }
              />
              {summary.overdueCount > 0 && <StatCard label="OVERDUE" value={<span className="text-red">{summary.overdueCount}</span>} />}
            </div>
            {reminders.length > 0 && (
              <div className="flex-[1_1_100%]">
                <RemindersPanel reminders={reminders} />
              </div>
            )}
            <div className="flex-[1_1_100%]">
              <LendingWorkspace contacts={summary.contacts} recentEntries={recent} />
            </div>
          </>
        }
        recovery={
          <div className="flex-[1_1_100%]">
            <CardRecoveryDashboard cards={cardRecovery} />
          </div>
        }
        reports={
          <div className="flex-[1_1_100%]">
            <LendingReports data={reports} />
          </div>
        }
      />
    </div>
  );
}
