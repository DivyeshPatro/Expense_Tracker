import Link from "next/link";
import { listImportBatches } from "@/server/services/import";
import { requireUser } from "@/server/session";
import { DangerZone } from "./danger-zone";
import { ImportHistory, type ImportBatchRow } from "./import-history";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
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
    <div className="flex flex-col gap-4 max-w-[640px]" style={{ animation: "rise .25s ease" }}>
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
