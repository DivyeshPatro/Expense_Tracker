import { requireUser } from "@/server/session";
import { DangerZone } from "../danger-zone";
import { SettingsSubPage } from "../settings-nav";

export const dynamic = "force-dynamic";

export default async function AdvancedSettingsPage() {
  await requireUser();
  return (
    <SettingsSubPage title="Advanced" detail="Irreversible things. Read before you tap.">
      <section className="card p-6 flex flex-col gap-3">
        <h2 className="text-[13.5px] font-bold m-0 text-red">Danger zone</h2>
        <DangerZone />
      </section>
    </SettingsSubPage>
  );
}
