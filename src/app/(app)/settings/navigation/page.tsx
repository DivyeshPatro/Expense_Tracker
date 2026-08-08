import Link from "next/link";
import { requireUser } from "@/server/session";
import { NavEditor } from "./nav-editor";

export const dynamic = "force-dynamic";

export default async function NavigationSettingsPage() {
  await requireUser();
  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      <div className="flex items-center gap-2.5">
        <Link href="/settings" aria-label="Back to Settings" className="w-9 h-9 rounded-lg grid place-items-center text-mut cursor-pointer bg-card border border-line2 hover:bg-accsoft flex-none no-underline">
          ←
        </Link>
        <div>
          <h1 className="text-[21px] font-extrabold tracking-[-.02em] m-0">Navigation</h1>
          <div className="text-[11.5px] text-mut2">Customise the app around how you use it — saved on this device.</div>
        </div>
      </div>
      <NavEditor />
    </div>
  );
}
