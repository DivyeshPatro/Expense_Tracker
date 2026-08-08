import { ModuleActivityPage } from "@/components/shell/module-activity-page";
import { SPENDING_TABS } from "@/components/shell/module-tabs";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function SpendingActivityPage() {
  await requireUser();
  return <ModuleActivityPage tabs={SPENDING_TABS} entities={["Transaction"]} detail="Every change to your transactions — added, edited, deleted — in plain English." />;
}
