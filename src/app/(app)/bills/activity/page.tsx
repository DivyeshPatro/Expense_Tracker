import { ModuleActivityPage } from "@/components/shell/module-activity-page";
import { BILLS_TABS } from "@/components/shell/module-tabs";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function BillsActivityPage() {
  await requireUser();
  return <ModuleActivityPage tabs={BILLS_TABS} entities={["Bill"]} detail="Every change to your bills — added, edited, paid, deleted." />;
}
