"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { undoImportAction } from "@/app/actions";
import { friendlyDay } from "@/lib/dates";
import { useUI } from "@/components/shell/ui-context";

export interface ImportBatchRow {
  id: string;
  source: string;
  fileName: string;
  importedCount: number;
  skippedCount: number;
  status: string;
  createdAt: string;
}

export function ImportHistory({ batches }: { batches: ImportBatchRow[] }) {
  const { showToast } = useUI();
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  if (batches.length === 0) {
    return <div className="text-[12.5px] text-mut2">No imports yet.</div>;
  }

  return (
    <div className="flex flex-col gap-2">
      {batches.map((b) => (
        <div key={b.id} className="flex items-center gap-3 py-2 border-b border-line last:border-b-0 text-[12.5px]">
          <div className="flex-1 min-w-0">
            <div className="font-semibold truncate">{b.source} · {b.fileName}</div>
            <div className="text-mut2">{friendlyDay(b.createdAt.slice(0, 10))} · {b.importedCount} imported, {b.skippedCount} skipped</div>
          </div>
          {b.status === "COMMITTED" ? (
            <button
              disabled={busyId === b.id}
              onClick={async () => {
                setBusyId(b.id);
                const res = await undoImportAction(b.id);
                setBusyId(null);
                showToast(res.ok ? "Import undone" : res.error);
                router.refresh();
              }}
              className="px-3 py-1.5 rounded-lg border border-line2 text-[11.5px] font-semibold text-acc cursor-pointer bg-transparent hover:bg-accsoft disabled:opacity-60"
            >
              {busyId === b.id ? "…" : "Undo"}
            </button>
          ) : (
            <span className="text-mut2 font-semibold">Undone</span>
          )}
        </div>
      ))}
    </div>
  );
}
