import { requireUser } from "@/server/session";
import { Appearance } from "@/components/shell/appearance-settings";
import { SettingsSubPage } from "../settings-nav";

export const dynamic = "force-dynamic";

export const metadata = { title: "Appearance · Settings" };

export default async function AppearanceSettingsPage() {
  await requireUser();
  return (
    <SettingsSubPage title="Appearance" detail="Applies everywhere and sticks to this device.">
      <section className="card p-6 flex flex-col gap-3">
        <Appearance />
      </section>
    </SettingsSubPage>
  );
}
