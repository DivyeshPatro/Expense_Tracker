import { cookies } from "next/headers";
import { BASIS_COOKIE, parseBasisPref } from "@/lib/expense-basis";
import { listCategories } from "@/server/services/categories";
import { requireUser } from "@/server/session";
import { BasisPreference } from "../basis-preference";
import { Categories, type CategoryRow } from "../categories";
import { Profile } from "../profile";
import { SettingsSubPage } from "../settings-nav";

export const dynamic = "force-dynamic";

export default async function GeneralSettingsPage() {
  const user = await requireUser();
  const basisPref = parseBasisPref((await cookies()).get(BASIS_COOKIE)?.value);
  const categories = await listCategories(user.id);
  const categoryRows: CategoryRow[] = categories
    .filter((c) => c.kind !== "TRANSFER")
    .map((c) => ({ id: c.id, name: c.name, icon: c.icon ?? "📦", kind: c.kind as "EXPENSE" | "INCOME" }));

  return (
    <SettingsSubPage title="General" detail="Your details and the categories you spend against.">
      <section className="card p-6 flex flex-col gap-3">
        <h2 className="text-[13.5px] font-bold m-0">Profile</h2>
        <Profile name={user.name} email={user.email} />
      </section>
      <section className="card p-6 flex flex-col gap-3">
        <h2 className="text-[13.5px] font-bold m-0">How expenses are shown</h2>
        <div className="text-[12.5px] text-mut">
          When you split a bill, the amount you paid and the amount you owe are different. Choose which one Ledgerly leads with.
        </div>
        <BasisPreference initial={basisPref} />
      </section>
      <section className="card p-6 flex flex-col gap-3">
        <h2 className="text-[13.5px] font-bold m-0">Categories</h2>
        <div className="text-[12.5px] text-mut">Your defaults plus anything custom you&apos;ve added.</div>
        <Categories categories={categoryRows} />
      </section>
    </SettingsSubPage>
  );
}
