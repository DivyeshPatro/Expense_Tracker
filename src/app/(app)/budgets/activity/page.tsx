import { ModuleActivityPage } from "@/components/shell/module-activity-page";
import { BUDGETS_TABS } from "@/components/shell/module-tabs";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function BudgetsActivityPage() {
  await requireUser();
  return <ModuleActivityPage tabs={BUDGETS_TABS} entities={["Budget"]} detail="Every change to your budgets — created, adjusted, removed." />;
}
