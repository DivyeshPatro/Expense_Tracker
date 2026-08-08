import { requireUser } from "@/server/session";
import { SecuritySettings } from "../profile";
import { SettingsSubPage } from "../settings-nav";

export const dynamic = "force-dynamic";

export default async function SecuritySettingsPage() {
  await requireUser();
  return (
    <SettingsSubPage title="Security" detail="How you sign in.">
      <section className="card p-6 flex flex-col gap-3">
        <SecuritySettings />
      </section>
    </SettingsSubPage>
  );
}
