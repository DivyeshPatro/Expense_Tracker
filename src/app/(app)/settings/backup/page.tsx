import Link from "next/link";
import { listImportBatches } from "@/server/services/import";
import { requireUser } from "@/server/session";
import { ImportHistory, type ImportBatchRow } from "../import-history";
import { SettingsSubPage } from "../settings-nav";

export const dynamic = "force-dynamic";

export default async function BackupSettingsPage() {
  const user = await requireUser();
  const batches = await listImportBatches(user.id);
  const batchRows: ImportBatchRow[] = batches.map((b) => ({
    id: b.id,
    source: b.source,
    fileName: b.fileName,
    importedCount: b.importedCount,
    skippedCount: b.skippedCount,
    status: b.status,
    createdAt: b.createdAt.toISOString(),
  }));

  return (
    <SettingsSubPage title="Backup & data" detail="Your data belongs to you — bring it in, take it out.">
      <section className="card p-6 flex flex-col gap-3">
        <h2 className="text-[13.5px] font-bold m-0">Import</h2>
        <div className="text-[12.5px] text-mut">Bring in transactions from Monito, a bank statement export, or any CSV/Excel sheet.</div>
        <Link href="/import" className="btn-primary self-start min-h-[44px] inline-flex items-center">＋ Start an import</Link>
        <div className="mt-2">
          <div className="text-[12px] font-bold text-mut2 tracking-[.06em] mb-2">IMPORT HISTORY</div>
          <ImportHistory batches={batchRows} />
        </div>
      </section>
      <section className="card p-6 flex flex-col gap-3">
        <h2 className="text-[13.5px] font-bold m-0">Export</h2>
        <div className="text-[12.5px] text-mut">Take a copy any time.</div>
        <div className="flex gap-2 flex-wrap">
          <a href="/api/export/csv" className="px-3.5 min-h-[44px] inline-flex items-center rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-acc no-underline hover:bg-accsoft">
            Transactions (CSV)
          </a>
          <a href="/api/export/xlsx" className="px-3.5 min-h-[44px] inline-flex items-center rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-acc no-underline hover:bg-accsoft">
            Transactions (XLSX)
          </a>
          <a href="/api/export/json" className="px-3.5 min-h-[44px] inline-flex items-center rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-acc no-underline hover:bg-accsoft">
            Everything (JSON)
          </a>
        </div>
      </section>
      <section className="card p-6 flex flex-col gap-3">
        <h2 className="text-[13.5px] font-bold m-0">Sync</h2>
        <div className="text-[12.5px] text-mut">Changes made offline are saved on this device and sync when you&apos;re back online.</div>
        <Link href="/settings/sync" className="text-[12.5px] font-semibold text-acc no-underline min-h-[44px] inline-flex items-center">Open Sync Center →</Link>
      </section>
    </SettingsSubPage>
  );
}
