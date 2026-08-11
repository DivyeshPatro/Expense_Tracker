// #204: the Settings index. Seven grouped rows, each into its own sub-page —
// replacing nine sections stacked into 3.39 screens of scroll.

import { requireUser } from "@/server/session";
import { SettingsIndex, SETTINGS_ICONS, type SettingsGroup } from "./settings-nav";
import { SyncCard } from "./sync-card";

export const dynamic = "force-dynamic";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await requireUser();

  const groups: SettingsGroup[] = [
    { href: "/settings/general", label: "General", detail: "Your name, email, and categories", icon: SETTINGS_ICONS.general },
    { href: "/settings/appearance", label: "Appearance", detail: "Light or dark, and an accent colour", icon: SETTINGS_ICONS.appearance },
    { href: "/settings/dashboard", label: "Dashboard", detail: "Recurring transactions and what shows on home", icon: SETTINGS_ICONS.dashboard },
    { href: "/settings/navigation", label: "Navigation", detail: "Reorder, hide, and pin your modules", icon: SETTINGS_ICONS.navigation },
    { href: "/settings/security", label: "Security", detail: "Password and sign-in", icon: SETTINGS_ICONS.security },
    { href: "/settings/backup", label: "Backup & data", detail: "Import, export, and sync", icon: SETTINGS_ICONS.backup },
    { href: "/settings/advanced", label: "Advanced", detail: "Danger zone and account deletion", icon: SETTINGS_ICONS.developer },
  ];

  return (
    <div className="flex flex-col gap-4 max-w-[640px]" style={{ animation: "rise .25s ease" }}>
      <div>
        <h1 className="text-[21px] font-extrabold tracking-[-.02em] m-0">Settings</h1>
        <p className="text-[12.5px] text-mut mt-1 mb-0">
          Signed in as {user.email}
        </p>
      </div>
      <SyncCard />
      <SettingsIndex groups={groups} />
    </div>
  );
}
