import { ModuleActivityPage } from "@/components/shell/module-activity-page";
import { SHARED_TABS } from "@/components/shell/module-tabs";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function SharedActivityPage() {
  await requireUser();
  return <ModuleActivityPage tabs={SHARED_TABS} entities={["Settlement"]} detail="Every settlement recorded with the people you share costs with." />;
}
