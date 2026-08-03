"use client";

// Khatabook → Lending migration flow.
//
// Rendered by the import wizard when a file is detected as a lending ledger.
// It is a migration, not a CSV mapping screen: preview → resolve any existing
// contacts → import → a report that sends you straight into Lending, where the
// contacts, balances, history and reports are already populated.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { commitLendingImportAction, previewLendingImportAction, undoImportAction } from "@/app/actions";
import { formatPaise } from "@/lib/money";
import { useUI } from "@/components/shell/ui-context";
import type { LendingPreviewResult } from "@/server/services/lending-import";
import type { MergeDecision, PlannedContact } from "@/lib/import/lending/preview";

type Phase = "loading" | "ready" | "importing" | "done" | "error";

const PROGRESS = [
  "Reading file…",
  "Parsing…",
  "Finding contacts…",
  "Checking duplicates…",
  "Preparing balances…",
  "Importing…",
  "Verifying…",
];

export function KhatabookImport({
  rows,
  fileName,
  adapterId,
  adapterLabel,
  onSwitchToGeneric,
}: {
  rows: Record<string, unknown>[];
  fileName: string;
  adapterId: string;
  adapterLabel: string;
  onSwitchToGeneric: () => void;
}) {
  const router = useRouter();
  const { showToast } = useUI();

  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<LendingPreviewResult | null>(null);
  const [decisions, setDecisions] = useState<Record<string, MergeDecision>>({});
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  // Import-level "always create new contacts for duplicates" — one toggle
  // instead of a choice per existing contact, for hands-free large imports.
  const [alwaysCreate, setAlwaysCreate] = useState(false);

  const [progressStep, setProgressStep] = useState(0);
  const [result, setResult] = useState<LendingPreviewResult | null>(null);
  const [committed, setCommitted] = useState<{ batchId: string; elapsedMs: number; report: NonNullable<Awaited<ReturnType<typeof commitLendingImportAction>>["result"]> } | null>(null);
  const [undone, setUndone] = useState(false);

  const loadPreview = useCallback(
    async (opts: { decisions: Record<string, MergeDecision>; skipDuplicates: boolean; alwaysCreate: boolean }) => {
      const p = await previewLendingImportAction(rows, adapterId, {
        decisions: opts.decisions,
        skipDuplicates: opts.skipDuplicates,
        defaultExistingDecision: opts.alwaysCreate ? "create" : "merge",
      });
      setPreview(p);
      return p;
    },
    [rows, adapterId]
  );

  // Initial preview.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await loadPreview({ decisions: {}, skipDuplicates: true, alwaysCreate: false });
        if (!cancelled) setPhase("ready");
        if (cancelled) return;
        void p;
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Couldn't read this file");
          setPhase("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadPreview]);

  // Re-preview when the user changes merge decisions, duplicate handling, or
  // the import-level "always create new" toggle.
  async function updateOptions(next: { decisions?: Record<string, MergeDecision>; skipDuplicates?: boolean; alwaysCreate?: boolean }) {
    const d = next.decisions ?? decisions;
    const s = next.skipDuplicates ?? skipDuplicates;
    const a = next.alwaysCreate ?? alwaysCreate;
    setDecisions(d);
    setSkipDuplicates(s);
    setAlwaysCreate(a);
    try {
      await loadPreview({ decisions: d, skipDuplicates: s, alwaysCreate: a });
    } catch {
      /* keep the previous preview on a transient error */
    }
  }

  const existingContacts = (preview?.contacts ?? []).filter((c) => c.existingId);

  function setDecision(key: string, d: MergeDecision) {
    void updateOptions({ decisions: { ...decisions, [key]: d } });
  }
  function applyToAll(d: MergeDecision) {
    const next: Record<string, MergeDecision> = { ...decisions };
    for (const c of existingContacts) next[c.key] = d;
    void updateOptions({ decisions: next });
  }

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  async function runImport() {
    if (!preview) return;
    setPhase("importing");
    setProgressStep(0);
    const started = Date.now();
    timerRef.current = setInterval(() => setProgressStep((s) => Math.min(s + 1, PROGRESS.length - 1)), 260);
    const res = await commitLendingImportAction({
      rows,
      adapterId,
      fileName,
      options: { decisions, skipDuplicates, defaultExistingDecision: alwaysCreate ? "create" : "merge" },
    });
    if (timerRef.current) clearInterval(timerRef.current);
    if (!res.ok || !res.result) {
      setError(res.ok ? "Import failed" : res.error);
      setPhase("error");
      return;
    }
    setResult(preview);
    setCommitted({ batchId: res.result.batchId, elapsedMs: Date.now() - started, report: res.result });
    setPhase("done");
  }

  async function undo() {
    if (!committed) return;
    const res = await undoImportAction(committed.batchId);
    if (res.ok) {
      setUndone(true);
      showToast(res.message ?? "Import undone");
    } else {
      showToast(res.error);
    }
  }

  if (phase === "loading") {
    return <div className="card px-4 py-6 text-center text-mut text-[13px]">Reading {adapterLabel}…</div>;
  }
  if (phase === "error") {
    return (
      <div className="card px-4 py-5 flex flex-col gap-3">
        <div className="text-[13px] text-red font-semibold">{error}</div>
        <button onClick={onSwitchToGeneric} className="btn-secondary self-start">
          Use the normal CSV importer instead
        </button>
      </div>
    );
  }
  if (phase === "importing") {
    return <ImportProgress step={progressStep} />;
  }
  if (phase === "done" && committed && result) {
    return <MigrationReport report={committed.report} elapsedMs={committed.elapsedMs} undone={undone} onUndo={undo} onGoToLending={() => { router.push("/lending"); router.refresh(); }} onHistory={() => router.push("/settings")} />;
  }
  if (!preview) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="card px-4 py-3.5 flex items-start gap-3">
        <div className="text-[22px]">📒</div>
        <div className="flex-1">
          <div className="font-extrabold text-[15px]">{adapterLabel}</div>
          <div className="text-[12px] text-mut mt-0.5">
            This isn&apos;t a plain CSV — it&apos;s a lending ledger. Contacts, balances and history go straight into Lending.
          </div>
        </div>
        <button onClick={onSwitchToGeneric} className="text-[11.5px] font-semibold text-acc hover:underline whitespace-nowrap">
          Not a ledger? Normal import →
        </button>
      </div>

      {/* Headline numbers */}
      <div className="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(140px,1fr))]">
        <Stat label="Contacts to create" value={String(preview.contactsToCreate)} />
        <Stat label="Existing contacts" value={String(preview.contactsExisting)} />
        <Stat label="Lending entries" value={String(preview.counts.validRows - preview.counts.skippedRows)} tone="green" />
        <Stat label="Total You Gave" value={formatPaise(preview.totals.gavePaise)} />
        <Stat label="Total You Got" value={formatPaise(preview.totals.gotPaise)} />
        <Stat label="Net outstanding" value={formatPaise(preview.totals.netPaise)} tone={preview.totals.netPaise >= 0 ? "green" : "red"} />
        <Stat label="Duplicates" value={String(preview.counts.duplicateRows)} tone="amber" />
        <Stat label="Invalid rows" value={String(preview.counts.invalidRows)} tone={preview.counts.invalidRows ? "red" : undefined} />
      </div>

      {preview.dateRange && (
        <div className="text-[12px] text-mut">
          History spans <b className="text-ink">{preview.dateRange.min}</b> → <b className="text-ink">{preview.dateRange.max}</b>
          {" · "}
          {preview.counts.totalRows} rows
        </div>
      )}

      {/* Existing-contact resolution */}
      {existingContacts.length > 0 && (
        <div className="card px-4 py-3.5 flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <div className="font-bold text-[13px]">{existingContacts.length} contact{existingContacts.length === 1 ? "" : "s"} already exist</div>
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="text-mut">Apply to all:</span>
              {(["merge", "create", "skip"] as MergeDecision[]).map((d) => (
                <button key={d} onClick={() => applyToAll(d)} className="px-2 py-1 rounded-md border border-line2 font-semibold capitalize hover:bg-accsoft">
                  {d === "create" ? "Create new" : d}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-[12px] font-semibold cursor-pointer text-mut">
            <input type="checkbox" checked={alwaysCreate} onChange={(e) => void updateOptions({ alwaysCreate: e.target.checked })} />
            Always create new contacts for duplicates in this import (hands-free)
          </label>
          <div className="flex flex-col gap-1.5 max-h-[220px] overflow-auto">
            {existingContacts.map((c) => (
              <div key={c.key} className="flex items-center gap-2 text-[12.5px]">
                <span className="flex-1 font-semibold truncate">{c.displayName}</span>
                <span className="text-mut2 text-[11px]">{formatPaise(c.outstandingPaise)}</span>
                <select
                  value={decisions[c.key] ?? "merge"}
                  onChange={(e) => setDecision(c.key, e.target.value as MergeDecision)}
                  className="field !py-1 !w-auto text-[11.5px]"
                >
                  <option value="merge">Merge with existing</option>
                  <option value="create">Create a new contact</option>
                  <option value="skip">Skip this contact</option>
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Duplicate handling */}
      {preview.counts.duplicateRows > 0 && (
        <label className="flex items-center gap-2 text-[12.5px] font-semibold cursor-pointer">
          <input type="checkbox" checked={skipDuplicates} onChange={(e) => void updateOptions({ skipDuplicates: e.target.checked })} />
          Skip {preview.counts.duplicateRows} duplicate row{preview.counts.duplicateRows === 1 ? "" : "s"} (same contact, date, amount and type)
        </label>
      )}

      {/* Top contacts */}
      {preview.top.length > 0 && <TopContacts contacts={preview.top} />}

      {/* Row preview */}
      <RowPreview contacts={preview.contacts} />

      {preview.invalid.length > 0 && (
        <details className="text-[12px]">
          <summary className="cursor-pointer font-semibold text-red">{preview.invalid.length} row{preview.invalid.length === 1 ? "" : "s"} will be skipped</summary>
          <div className="mt-1.5 flex flex-col gap-0.5 max-h-[160px] overflow-auto text-mut">
            {preview.invalid.slice(0, 100).map((v) => (
              <div key={v.rowIndex}>Row {v.rowIndex} — {v.reason}</div>
            ))}
          </div>
        </details>
      )}

      <div className="flex gap-2">
        <button onClick={() => void runImport()} className="btn-primary flex-1" disabled={preview.counts.validRows === 0}>
          Import into Lending
        </button>
        <button onClick={onSwitchToGeneric} className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold">
          Cancel
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "green" | "amber" | "red" }) {
  const color = tone === "green" ? "var(--green)" : tone === "amber" ? "var(--amber)" : tone === "red" ? "var(--red)" : "var(--ink)";
  return (
    <div className="bg-accsoft rounded-[10px] px-3 py-2.5">
      <div className="text-[10px] font-semibold text-mut tracking-[.04em] uppercase">{label}</div>
      <div className="text-[16px] font-extrabold mt-0.5 truncate" style={{ color }}>{value}</div>
    </div>
  );
}

function TopContacts({ contacts }: { contacts: PlannedContact[] }) {
  return (
    <div className="card px-4 py-3.5">
      <div className="font-bold text-[13px] mb-2">Top contacts</div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-mut text-left">
              <th className="font-semibold py-1 pr-2">Contact</th>
              <th className="font-semibold py-1 px-2 text-right">You Gave</th>
              <th className="font-semibold py-1 px-2 text-right">You Got</th>
              <th className="font-semibold py-1 pl-2 text-right">Remaining</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.key} className="border-t border-line2">
                <td className="py-1.5 pr-2 font-semibold truncate max-w-[160px]">{c.displayName}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{formatPaise(c.totalGavePaise)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{formatPaise(c.totalGotPaise)}</td>
                <td className="py-1.5 pl-2 text-right tabular-nums font-bold" style={{ color: c.outstandingPaise >= 0 ? "var(--green)" : "var(--red)" }}>
                  {formatPaise(c.outstandingPaise)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RowPreview({ contacts }: { contacts: PlannedContact[] }) {
  const CAP = 40;
  const flat = contacts
    .filter((c) => c.resolution !== "skip")
    .flatMap((c) => c.entries.map((e) => ({ contact: c.displayName, ...e })));
  const shown = flat.slice(0, CAP);
  return (
    <div className="card px-4 py-3.5">
      <div className="font-bold text-[13px] mb-2">Preview</div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11.5px]">
          <thead>
            <tr className="text-mut text-left">
              <th className="font-semibold py-1 pr-2">Date</th>
              <th className="font-semibold py-1 px-2">Contact</th>
              <th className="font-semibold py-1 px-2">Type</th>
              <th className="font-semibold py-1 px-2 text-right">Amount</th>
              <th className="font-semibold py-1 px-2 text-right">Balance</th>
              <th className="font-semibold py-1 pl-2">Note</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <tr key={`${e.contact}-${e.rowIndex}`} className={`border-t border-line2 ${e.duplicate ? "opacity-45" : ""}`}>
                <td className="py-1.5 pr-2 tabular-nums whitespace-nowrap">{e.ymd}</td>
                <td className="py-1.5 px-2 truncate max-w-[120px]">{e.contact}</td>
                <td className="py-1.5 px-2 font-bold" style={{ color: e.kind === "GAVE" ? "var(--green)" : "var(--red)" }}>{e.kind === "GAVE" ? "Gave" : "Got"}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{formatPaise(e.amountPaise)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{formatPaise(e.runningBalancePaise)}</td>
                <td className="py-1.5 pl-2 truncate max-w-[160px] text-mut">{e.duplicate ? "duplicate — skipped" : e.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {flat.length > CAP && <div className="text-[11px] text-mut mt-2">Showing {CAP} of {flat.length} entries.</div>}
    </div>
  );
}

function ImportProgress({ step }: { step: number }) {
  return (
    <div className="card px-4 py-6 flex flex-col gap-2.5">
      {PROGRESS.map((label, i) => (
        <div key={label} className={`flex items-center gap-2.5 text-[13px] ${i <= step ? "text-ink font-semibold" : "text-mut2"}`}>
          <span className="w-4 text-center">{i < step ? "✓" : i === step ? "⋯" : "○"}</span>
          {label}
        </div>
      ))}
    </div>
  );
}

function MigrationReport({
  report,
  elapsedMs,
  undone,
  onUndo,
  onGoToLending,
  onHistory,
}: {
  report: NonNullable<Awaited<ReturnType<typeof commitLendingImportAction>>["result"]>;
  elapsedMs: number;
  undone: boolean;
  onUndo: () => void;
  onGoToLending: () => void;
  onHistory: () => void;
}) {
  return (
    <div className="card px-5 py-6 flex flex-col gap-4">
      <div className="text-center">
        <div className="text-[34px]">🎉</div>
        <div className="text-[18px] font-extrabold mt-1">{undone ? "Import undone" : "Migration complete"}</div>
        <div className="text-[12.5px] text-mut mt-0.5">
          {undone ? "Everything this import added has been removed." : `Imported in ${(elapsedMs / 1000).toFixed(1)}s`}
        </div>
      </div>

      {!undone && (
        <div className="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
          <Stat label="Contacts created" value={String(report.contactsCreated)} tone="green" />
          <Stat label="Contacts merged" value={String(report.contactsMerged)} />
          <Stat label="Contacts skipped" value={String(report.contactsSkipped)} />
          <Stat label="Lending entries" value={String(report.entriesImported)} tone="green" />
          <Stat label="Duplicates skipped" value={String(report.duplicatesSkipped)} tone="amber" />
          <Stat label="Invalid skipped" value={String(report.invalidSkipped)} tone={report.invalidSkipped ? "red" : undefined} />
          <Stat label="Total You Gave" value={formatPaise(report.totalGavePaise)} />
          <Stat label="Total You Got" value={formatPaise(report.totalGotPaise)} />
          <Stat label="Amount left" value={formatPaise(report.netOutstandingPaise)} tone={report.netOutstandingPaise >= 0 ? "green" : "red"} />
        </div>
      )}

      {!undone && (
        <div className="bg-side rounded-[12px] px-4 py-3.5">
          <div className="font-bold text-[13px] mb-2">Next steps</div>
          <ol className="flex flex-col gap-1.5 text-[12.5px] text-mut list-none m-0 p-0">
            <li className="flex items-start gap-2"><span>①</span> Review your imported contacts in Lending</li>
            <li className="flex items-start gap-2"><span>②</span> Assign funding sources to entries <span className="text-mut2">(optional)</span></li>
            <li className="flex items-start gap-2"><span>③</span> Add phone numbers to contacts <span className="text-mut2">(optional)</span></li>
            <li className="flex items-start gap-2"><span>④</span> Add profile photos <span className="text-mut2">(optional)</span></li>
          </ol>
          <div className="text-[11px] text-mut2 mt-2">Imported contacts are badged in Lending until you add a detail — so you can see at a glance what still needs a look.</div>
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        {!undone && (
          <button onClick={onGoToLending} className="btn-primary flex-1">
            Go to Lending
          </button>
        )}
        <button onClick={onHistory} className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold">
          View Import History
        </button>
        {!undone && (
          <button onClick={onUndo} className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-red">
            Undo Import
          </button>
        )}
      </div>
    </div>
  );
}
