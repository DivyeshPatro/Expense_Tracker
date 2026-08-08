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

import { ModuleActivity } from "@/components/shell/module-activity";
import { ModuleHero } from "@/components/shell/module-hero";
import { LendingReports } from "@/components/lending/lending-reports";
import { LendingTabs } from "@/components/lending/lending-tabs";
import { LendingWorkspace } from "@/components/lending/lending-workspace";
import { RemindersPanel } from "@/components/lending/reminders-panel";
import { formatPaise } from "@/lib/money";
import { lendingDashboardSummary, lendingReminders, lendingReportsData, listLoanEntries } from "@/server/services/lending";
import { importedContactSources } from "@/server/services/lending-import";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function LendingPage() {
  const user = await requireUser();
  const [summary, recent, reminders, reports, importedContacts] = await Promise.all([
    lendingDashboardSummary(user.id),
    listLoanEntries(user.id, { limit: 8 }),
    lendingReminders(user.id),
    lendingReportsData(user.id),
    importedContactSources(user.id),
  ]);

  // #187: the hero's sub-line — who the money is with, and what's late.
  const owedBy = summary.contacts.filter((c) => c.net > 0).length;
  const peopleSub =
    summary.youAreOwed === 0 && summary.youOwe === 0
      ? "Nothing outstanding either way"
      : [
          owedBy > 0 ? `from ${owedBy} ${owedBy === 1 ? "person" : "people"}` : null,
          summary.overdueCount > 0 ? `${summary.overdueCount} overdue` : null,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      <LendingTabs
        overview={
          <>
            {/* #187: "Who owes me?" is why anyone opens this screen, so it is
                the largest thing on it. The old header led with two ＋ buttons
                and a strapline; both are now the FAB's job. */}
            <div className="flex-[1_1_100%]">
              <ModuleHero
                eyebrow="You'll get"
                value={formatPaise(summary.youAreOwed)}
                valueColor="var(--green)"
                sub={peopleSub}
                tone={summary.overdueCount > 0 ? "bad" : "neutral"}
                secondary={[
                  { label: "You'll pay", value: formatPaise(summary.youOwe), color: summary.youOwe > 0 ? "var(--red)" : undefined },
                  {
                    label: "Net",
                    value: `${summary.net < 0 ? "−" : "+"}${formatPaise(Math.abs(summary.net))}`,
                    color: summary.net < 0 ? "var(--red)" : "var(--green)",
                  },
                ]}
              />
            </div>
            {reminders.length > 0 && (
              <div className="flex-[1_1_100%]">
                <RemindersPanel reminders={reminders} />
              </div>
            )}
            <div className="flex-[1_1_100%]">
              <LendingWorkspace contacts={summary.contacts} recentEntries={recent} importedContacts={importedContacts} />
            </div>
          </>
        }
        reports={
          <div className="flex-[1_1_100%]">
            <LendingReports data={reports} />
          </div>
        }
        activity={
          <div className="flex-[1_1_100%]">
            <ModuleActivity entities={["LoanEntry"]} />
          </div>
        }
      />
    </div>
  );
}
