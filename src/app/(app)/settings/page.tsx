import Link from "next/link";
import { listCategories } from "@/server/services/categories";
import { listImportBatches } from "@/server/services/import";
import { listRecurringRules } from "@/server/services/recurring";
import { requireUser } from "@/server/session";
import { Categories, type CategoryRow } from "./categories";
import { DangerZone } from "./danger-zone";
import { ImportHistory, type ImportBatchRow } from "./import-history";
import { Appearance } from "@/components/shell/appearance-settings";
import { Profile } from "./profile";
import { RecurringRules } from "./recurring";
import { SyncCard } from "./sync-card";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireUser();
  const [batches, categories, recurringRules] = await Promise.all([
    listImportBatches(user.id),
    listCategories(user.id),
    listRecurringRules(user.id),
  ]);
  const batchRows: ImportBatchRow[] = batches.map((b) => ({
    id: b.id,
    source: b.source,
    fileName: b.fileName,
    importedCount: b.importedCount,
    skippedCount: b.skippedCount,
    status: b.status,
    createdAt: b.createdAt.toISOString(),
  }));
  const categoryRows: CategoryRow[] = categories
    .filter((c) => c.kind !== "TRANSFER")
    .map((c) => ({ id: c.id, name: c.name, icon: c.icon ?? "📦", kind: c.kind as "EXPENSE" | "INCOME" }));

  return (
    <div className="flex flex-col gap-4 max-w-[640px]" style={{ animation: "rise .25s ease" }}>
      <SyncCard />

      <Link href="/settings/navigation" className="card p-6 flex items-center gap-3 no-underline text-ink hover:border-acc" style={{ transition: "border-color .15s" }}>
        <span className="w-10 h-10 rounded-[11px] grid place-items-center bg-accsoft text-acc flex-none">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 6h16M4 12h10M4 18h7" /><circle cx="18" cy="13" r="3" /></svg>
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[13.5px] font-bold">Navigation</span>
          <span className="block text-[12px] text-mut">Reorder, hide, and pin the modules in your bottom bar and sidebar.</span>
        </span>
        <span aria-hidden className="text-mut2 text-[18px]">›</span>
      </Link>

      <section className="card p-6 flex flex-col gap-3">
        <h2 className="text-[13.5px] font-bold m-0">Appearance</h2>
        <div className="text-[12.5px] text-mut">Choose a mode and an accent. It applies everywhere and sticks to this device.</div>
        <Appearance />
      </section>

      <section className="card p-6 flex flex-col gap-3">
        <h2 className="text-[13.5px] font-bold m-0">Profile</h2>
        <div className="text-[12.5px] text-mut">Your account details and sign-in password.</div>
        <Profile name={user.name} email={user.email} />
      </section>

      <section className="card p-6 flex flex-col gap-3">
        <h2 className="text-[13.5px] font-bold m-0">Categories</h2>
        <div className="text-[12.5px] text-mut">Your defaults plus anything custom you&apos;ve added.</div>
        <Categories categories={categoryRows} />
      </section>

      <section className="card p-6 flex flex-col gap-3">
        <h2 className="text-[13.5px] font-bold m-0">Recurring transactions</h2>
        <div className="text-[12.5px] text-mut">
          Subscriptions, rent, salary — anything that repeats. These are created automatically each day they&apos;re due.
        </div>
        <RecurringRules rules={recurringRules} />
      </section>

      <section className="card p-6 flex flex-col gap-3">
        <h2 className="text-[13.5px] font-bold m-0">Import data</h2>
        <div className="text-[12.5px] text-mut">Bring in transactions from Monito, a bank statement export, or any CSV/Excel sheet.</div>
        <Link href="/import" className="btn-primary self-start">＋ Start an import</Link>
        <div className="mt-2">
          <div className="text-[12px] font-bold text-mut2 tracking-[.06em] mb-2">IMPORT HISTORY</div>
          <ImportHistory batches={batchRows} />
        </div>
      </section>

      <section className="card p-6 flex flex-col gap-3">
        <h2 className="text-[13.5px] font-bold m-0">Export data</h2>
        <div className="text-[12.5px] text-mut">Your data belongs to you — take it with you any time.</div>
        <div className="flex gap-2">
          <a href="/api/export/csv" className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-acc no-underline hover:bg-accsoft">
            Export transactions (CSV)
          </a>
          <a href="/api/export/xlsx" className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-acc no-underline hover:bg-accsoft">
            Export transactions (XLSX)
          </a>
          <a href="/api/export/json" className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-acc no-underline hover:bg-accsoft">
            Export everything (JSON)
          </a>
        </div>
      </section>

      <section className="card p-6 flex flex-col gap-3">
        <h2 className="text-[13.5px] font-bold m-0 text-red">Danger zone</h2>
        <DangerZone />
      </section>
    </div>
  );
}
