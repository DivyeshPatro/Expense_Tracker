import { listRecurringRules } from "@/server/services/recurring";
import { requireUser } from "@/server/session";
import { RecurringRules } from "../recurring";
import { SettingsSubPage } from "../settings-nav";

export const dynamic = "force-dynamic";

export default async function DashboardSettingsPage() {
  const user = await requireUser();
  const recurringRules = await listRecurringRules(user.id);
  return (
    <SettingsSubPage title="Dashboard" detail="What happens automatically, and what shows on home.">
      <section className="card p-6 flex flex-col gap-3">
        <h2 className="text-[13.5px] font-bold m-0">Recurring transactions</h2>
        <div className="text-[12.5px] text-mut">
          Subscriptions, rent, salary — anything that repeats. These are created automatically each day they&apos;re due.
        </div>
        <RecurringRules rules={recurringRules} />
      </section>
      <section className="card p-6 flex flex-col gap-2">
        <h2 className="text-[13.5px] font-bold m-0">Home screen</h2>
        <div className="text-[12.5px] text-mut">
          Choose which sections appear on home with <b>Customize dashboard</b>, at the bottom of the home screen on your phone.
        </div>
      </section>
    </SettingsSubPage>
  );
}
