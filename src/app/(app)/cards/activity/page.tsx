import { ModuleActivityPage } from "@/components/shell/module-activity-page";
import { CARDS_TABS } from "@/components/shell/module-tabs";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function CardsActivityPage() {
  await requireUser();
  return <ModuleActivityPage tabs={CARDS_TABS} entities={["CreditCard"]} detail="Every change to your saved cards — added, edited, revealed, archived." />;
}
