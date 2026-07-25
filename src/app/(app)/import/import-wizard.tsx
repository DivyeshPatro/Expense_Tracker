"use client";

// Import wizard: upload → column mapping → category/account mapping → preview
// (validate + dedupe) → commit. Rows live in client state between steps and
// server actions do the actual validation/dedupe/insert — stateless by design
// so this works the same locally and on serverless deployments.

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  commitBackupRestoreAction,
  commitImportAction,
  createCategoryAction,
  getSavedMappingAction,
  previewBackupRestoreAction,
  previewImportAction,
} from "@/app/actions";
import type { ColumnMapping, PreviewRow, TargetField } from "@/lib/import/types";
import { emptyMapping, UNCATEGORIZED } from "@/lib/import/types";
import { formatPaise } from "@/lib/money";
import { useUI } from "@/components/shell/ui-context";

type Step = "upload" | "mapping" | "resolve" | "preview" | "backupPreview";

const FIELD_LABELS: Record<TargetField, string> = {
  date: "Date",
  amount: "Amount (signed)",
  debit: "Debit / withdrawal",
  credit: "Credit / deposit",
  type: "Type (Debit/Credit etc.)",
  merchant: "Merchant / description",
  category: "Category",
  account: "Account",
  notes: "Notes",
  paymentMethod: "Payment method",
  ignore: "Ignore this column",
};

const FIELD_ORDER: TargetField[] = ["date", "amount", "debit", "credit", "type", "merchant", "category", "account", "notes", "paymentMethod", "ignore"];

function mappingToColumnField(mapping: ColumnMapping): Record<string, TargetField> {
  const out: Record<string, TargetField> = {};
  for (const [field, header] of Object.entries(mapping)) {
    if (typeof header === "string" && header) out[header] = field as TargetField;
  }
  return out;
}

function columnFieldToMapping(assign: Record<string, TargetField>, amountSign: ColumnMapping["amountSign"]): ColumnMapping {
  const m = emptyMapping();
  m.amountSign = amountSign;
  for (const [header, field] of Object.entries(assign)) {
    if (field === "ignore") continue;
    (m as unknown as Record<string, string>)[field] = header;
  }
  return m;
}

export function ImportWizard() {
  const { refData, showToast } = useUI();
  const router = useRouter();
  const [step, setStep] = useState<Step>("upload");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fileName, setFileName] = useState("");
  const [source, setSource] = useState("");
  const [preset, setPreset] = useState<string | undefined>(undefined);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [assign, setAssign] = useState<Record<string, TargetField>>({});
  const [amountSign, setAmountSign] = useState<ColumnMapping["amountSign"]>("negative-is-expense");
  const [categoryMap, setCategoryMap] = useState<Record<string, string>>({});
  const [extraCategories, setExtraCategories] = useState<{ id: string; name: string; icon: string }[]>([]);
  const [accountMap, setAccountMap] = useState<Record<string, string>>({});
  // Unassigned by default: a source with no per-row account (Monito, most
  // category-only trackers) shouldn't silently dump years of history onto
  // whichever account happens to be first in the list.
  const [defaultAccountId, setDefaultAccountId] = useState("");
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  // Backup (.json) restore — a parallel flow to the CSV wizard. The backup
  // card on the upload step switches `preset` to "backup", which routes the
  // chosen file through previewBackupRestoreAction instead of the sheet parser.
  const [backupJson, setBackupJson] = useState<unknown>(null);
  const [backupPreview, setBackupPreview] = useState<Awaited<ReturnType<typeof previewBackupRestoreAction>> | null>(null);

  const mapping = useMemo(() => columnFieldToMapping(assign, amountSign), [assign, amountSign]);

  async function handleBackupUpload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const text = await file.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error("That file isn't valid JSON — was it exported from Ledgerly's Settings → Export?");
      }
      const result = await previewBackupRestoreAction(json);
      setBackupJson(json);
      setBackupPreview(result);
      setFileName(file.name);
      setStep("backupPreview");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read this backup file");
    } finally {
      setBusy(false);
    }
  }

  async function commitBackup() {
    if (!backupJson) return;
    setBusy(true);
    setError(null);
    const res = await commitBackupRestoreAction(backupJson);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    showToast(`Restored ${res.imported} transaction${res.imported === 1 ? "" : "s"}`);
    router.push("/transactions");
    router.refresh();
  }

  async function handleUpload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      if (preset) form.append("preset", preset);
      const res = await fetch("/api/import/parse", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upload failed");
      setHeaders(data.headers);
      setRows(data.rows);
      setFileName(data.fileName);
      // Reconcile the preset with whatever the server actually used (it echoes
      // it back). Default the source label to "Khatabook" when that preset is
      // active so the saved-mapping memory key matches across users.
      const activePreset = (data.preset as string | undefined) ?? preset;
      setPreset(activePreset);
      const guessedSource = activePreset === "khatabook" ? "Khatabook" : String(data.fileName).replace(/\.[^.]+$/, "");
      setSource(guessedSource);
      const saved = await getSavedMappingAction(guessedSource);
      const initialMapping = saved ? (saved.columnMap as unknown as ColumnMapping) : (data.mapping as ColumnMapping);
      setAssign(mappingToColumnField(initialMapping));
      setAmountSign(initialMapping.amountSign ?? "negative-is-expense");
      if (saved) setCategoryMap(saved.categoryMap as unknown as Record<string, string>);
      setStep("mapping");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  const distinctCategories = useMemo(() => {
    if (!mapping.category) return [];
    return [...new Set(rows.map((r) => String(r[mapping.category!] ?? "").trim()).filter(Boolean))];
  }, [rows, mapping.category]);

  const distinctAccounts = useMemo(() => {
    if (!mapping.account) return [];
    return [...new Set(rows.map((r) => String(r[mapping.account!] ?? "").trim()).filter(Boolean))];
  }, [rows, mapping.account]);

  const allCategoryOptions = useMemo(
    () => [...refData.expenseCategories, ...refData.incomeCategories, ...extraCategories],
    [refData.expenseCategories, refData.incomeCategories, extraCategories]
  );

  // A raw value that's already spelled exactly like one of your categories
  // (e.g. Monito's "Food" matching your "Food" category) resolves itself —
  // no need to make the user re-pick something that's already obvious.
  function directMatch(rawValue: string): string | null {
    const hit = allCategoryOptions.find((c) => c.name.toLowerCase() === rawValue.toLowerCase());
    return hit ? hit.id : null;
  }

  // Auto-fill obvious matches so the user only has to make a decision for
  // values that genuinely don't correspond to an existing category yet.
  useEffect(() => {
    setCategoryMap((s) => {
      let changed = false;
      const next = { ...s };
      for (const c of distinctCategories) {
        if (next[c]) continue;
        const hit = directMatch(c);
        if (hit) {
          next[c] = hit;
          changed = true;
        }
      }
      return changed ? next : s;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distinctCategories, allCategoryOptions]);

  // Everything else needs an explicit decision: map to an existing category
  // or create a new one — no silent "leave it uncategorized" fallback.
  const unresolvedCategories = distinctCategories.filter((c) => !categoryMap[c]);

  async function runPreview() {
    setBusy(true);
    setError(null);
    try {
      const result = await previewImportAction(rows, mapping);
      setPreview(result.rows);
      setStep("preview");
    } catch {
      setError("Couldn't validate these rows — check your column mapping.");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    const res = await commitImportAction({
      source: source.trim() || fileName,
      fileName,
      rows: preview,
      categoryMap,
      accountMap,
      defaultAccountId: defaultAccountId || null,
      mapping,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    showToast(`Imported ${res.imported} transaction${res.imported === 1 ? "" : "s"}`);
    router.push("/transactions");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4" style={{ animation: "rise .25s ease" }}>
      <Steps current={step} />
      {error && <div className="text-[12.5px] font-semibold text-red bg-redsoft rounded-lg px-3 py-2">{error}</div>}

      {step === "upload" && (
        <div className="card p-6 flex flex-col gap-4">
          <div>
            <div className="text-[13.5px] font-bold">Import transactions</div>
            <div className="text-[12.5px] text-mut mt-1">
              Bring in data from another app or your bank. Nothing is written to your ledger until you review and confirm at the end.
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <div className="label-caps">SOURCE FORMAT</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <SourceCard
                icon="📄"
                label="CSV / Excel"
                detail="Bank statements, Monito, or any spreadsheet with date + amount + merchant columns."
                selected={preset === undefined}
                onClick={() => setPreset(undefined)}
              />
              <SourceCard
                icon="📒"
                label="Khatabook"
                detail="Gave / Got exports with party-name columns. We map Entry Type, Party Name and Remark for you."
                selected={preset === "khatabook"}
                onClick={() => setPreset("khatabook")}
              />
              <SourceCard
                icon="💾"
                label="Ledgerly Backup"
                detail="Restore transactions from a .json file you exported from Ledgerly's Settings."
                selected={preset === "backup"}
                onClick={() => setPreset("backup")}
              />
            </div>
            {preset === "khatabook" && (
              <div className="text-[12px] text-amber bg-ambersoft rounded-lg px-3 py-2">
                ⚠ Khatabook tracks people you lent to — Ledgerly imports those rows as plain income/expense transactions, not as lending entries. Lending parties live in a separate area.
              </div>
            )}
            {preset === "backup" && (
              <div className="text-[12px] text-mut bg-accsoft rounded-lg px-3 py-2">
                Additive only: every restored transaction lands as a new row. Accounts and categories that don&apos;t already exist (matched by name) are created fresh. Existing data is never overwritten. You can undo the whole restore in one go from Settings → Import history.
              </div>
            )}
          </div>
          <label className="btn-primary cursor-pointer self-start">
            {busy ? "Reading…" : "Choose file"}
            <input
              type="file"
              key={preset}
              accept={preset === "backup" ? ".json" : ".csv,.xlsx,.xls"}
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                // A .json upload is always treated as a Ledgerly Backup even if
                // the source card wasn't clicked first — Playwright bypasses the
                // accept filter, and a user can switch source after picking a file.
                if (preset === "backup" || f.name.toLowerCase().endsWith(".json")) void handleBackupUpload(f);
                else void handleUpload(f);
              }}
            />
          </label>
        </div>
      )}

      {step === "mapping" && (
        <div className="card p-6 flex flex-col gap-4">
          <div>
            <div className="label-caps">IMPORT SOURCE (for remembering this mapping next time)</div>
            <input className="field !w-auto min-w-[220px]" value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. Monito, HDFC Statement" />
          </div>
          <div className="text-[13.5px] font-bold">Map your columns</div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px] border-collapse">
              <thead>
                <tr className="border-b border-line text-left text-mut">
                  <th className="py-1.5 pr-3 font-semibold">Column</th>
                  <th className="py-1.5 pr-3 font-semibold">Sample value</th>
                  <th className="py-1.5 font-semibold">Maps to</th>
                </tr>
              </thead>
              <tbody>
                {headers.map((h) => (
                  <tr key={h} className="border-b border-line">
                    <td className="py-1.5 pr-3 font-semibold">{h}</td>
                    <td className="py-1.5 pr-3 text-mut2 max-w-[200px] truncate">{String(rows[0]?.[h] ?? "")}</td>
                    <td className="py-1.5">
                      <select
                        className="field !py-1.5"
                        value={assign[h] ?? "ignore"}
                        onChange={(e) => setAssign((s) => ({ ...s, [h]: e.target.value as TargetField }))}
                      >
                        {FIELD_ORDER.map((f) => (
                          <option key={f} value={f}>{FIELD_LABELS[f]}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {mapping.amount && (
            <div>
              <div className="label-caps">SIGN CONVENTION</div>
              <div className="flex gap-4 text-[12.5px]">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" checked={amountSign === "negative-is-expense"} onChange={() => setAmountSign("negative-is-expense")} />
                  Negative = expense (bank statement default)
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" checked={amountSign === "positive-is-expense"} onChange={() => setAmountSign("positive-is-expense")} />
                  Positive = expense
                </label>
              </div>
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <button
              disabled={busy || !mapping.date || (!mapping.amount && !(mapping.debit && mapping.credit))}
              onClick={() => (mapping.category || mapping.account ? setStep("resolve") : runPreview())}
              className="btn-primary disabled:opacity-50"
            >
              {busy ? "Validating…" : "Continue"}
            </button>
          </div>
        </div>
      )}

      {step === "resolve" && (
        <div className="card p-6 flex flex-col gap-5">
          {distinctCategories.length > 0 && (
            <div>
              <div className="text-[13.5px] font-bold mb-2">Map categories</div>
              <div className="text-[12px] text-mut mb-2">
                Every value from your file needs a decision: matched to one of your categories automatically where the
                spelling lines up exactly, otherwise pick an existing category, create a new one, or explicitly leave it
                uncategorized — nothing gets silently skipped.
              </div>
              {unresolvedCategories.length > 0 && (
                <div className="text-[12px] font-semibold text-amber bg-ambersoft rounded-lg px-3 py-2 mb-2">
                  ⚠ {unresolvedCategories.length} value{unresolvedCategories.length === 1 ? "" : "s"} still need{unresolvedCategories.length === 1 ? "s" : ""} a decision below before you can continue.
                </div>
              )}
              <div className="flex flex-col gap-2">
                {distinctCategories.map((c) => (
                  <CategoryMapRow
                    key={c}
                    rawValue={c}
                    value={categoryMap[c] ?? ""}
                    options={allCategoryOptions}
                    onChange={(v) => setCategoryMap((s) => ({ ...s, [c]: v }))}
                    onCreated={(cat) => {
                      setExtraCategories((s) => [...s, cat]);
                      setCategoryMap((s) => ({ ...s, [c]: cat.id }));
                    }}
                  />
                ))}
              </div>
            </div>
          )}
          {distinctAccounts.length > 0 && (
            <div>
              <div className="text-[13.5px] font-bold mb-2">Map accounts</div>
              <div className="flex flex-col gap-2">
                {distinctAccounts.map((a) => (
                  <div key={a} className="flex items-center gap-2.5">
                    <div className="flex-1 text-[12.5px] font-medium truncate">{a}</div>
                    <select
                      className="field !w-auto min-w-[180px]"
                      value={accountMap[a] ?? ""}
                      onChange={(e) => setAccountMap((s) => ({ ...s, [a]: e.target.value }))}
                    >
                      <option value="">Use default account</option>
                      {refData.accounts.map((acc) => (
                        <option key={acc.id} value={acc.id}>{acc.icon} {acc.name}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div>
            <div className="label-caps">DEFAULT ACCOUNT (for rows with no account match above)</div>
            <select className="field !w-auto min-w-[200px]" value={defaultAccountId} onChange={(e) => setDefaultAccountId(e.target.value)}>
              <option value="">No account (unassigned) — recommended</option>
              {refData.accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>{acc.icon} {acc.name}</option>
              ))}
            </select>
            <div className="text-[12px] text-mut mt-1.5">
              {defaultAccountId ? (
                <span className="text-amber font-semibold">
                  ⚠ Every row without its own account match will be posted against this one account&apos;s balance — only choose this
                  if you&apos;re sure all of this history really came from that one account.
                </span>
              ) : (
                "Unassigned rows still count toward your spending totals, budgets and analytics — they just won't change any account's balance, since the source file doesn't say which account was used."
              )}
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setStep("mapping")} className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold cursor-pointer">Back</button>
            <button
              disabled={busy || unresolvedCategories.length > 0}
              title={unresolvedCategories.length > 0 ? "Resolve every category value above first" : undefined}
              onClick={runPreview}
              className="btn-primary disabled:opacity-50"
            >
              {busy ? "Validating…" : unresolvedCategories.length > 0 ? `Resolve ${unresolvedCategories.length} categor${unresolvedCategories.length === 1 ? "y" : "ies"} to continue` : "Preview import"}
            </button>
          </div>
        </div>
      )}

      {step === "preview" && preview && (
        <PreviewTable
          preview={preview}
          setPreview={setPreview}
          busy={busy}
          onBack={() => setStep(mapping.category || mapping.account ? "resolve" : "mapping")}
          onCommit={commit}
        />
      )}

      {step === "backupPreview" && backupPreview && (
        <BackupRestoreSummary
          preview={backupPreview}
          fileName={fileName}
          busy={busy}
          onBack={() => {
            setBackupPreview(null);
            setBackupJson(null);
            setStep("upload");
          }}
          onCommit={commitBackup}
        />
      )}
    </div>
  );
}

function SourceCard({
  icon,
  label,
  detail,
  selected,
  onClick,
}: {
  icon: string;
  label: string;
  detail: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left p-3.5 rounded-[10px] cursor-pointer border transition-colors ${selected ? "border-acc bg-accsoft" : "border-line2 bg-card hover:bg-accsoft"}`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[18px]" aria-hidden="true">{icon}</span>
        <span className="text-[13px] font-bold">{label}</span>
        {selected && <span className="ml-auto text-[11px] font-bold text-acc">✓ Selected</span>}
      </div>
      <div className="text-[11.5px] text-mut2 leading-snug">{detail}</div>
    </button>
  );
}

function Steps({ current }: { current: Step }) {
  const items: { key: Step; label: string }[] = [
    { key: "upload", label: "Upload" },
    { key: "mapping", label: "Map columns" },
    { key: "resolve", label: "Categories & accounts" },
    { key: "preview", label: "Preview & import" },
  ];
  const idx = items.findIndex((i) => i.key === current);
  return (
    <div className="flex gap-2 text-[12px] font-semibold">
      {items.map((it, i) => (
        <div key={it.key} className="flex items-center gap-2">
          <span
            className="px-2.5 py-1 rounded-full"
            style={{ background: i <= idx ? "var(--acc)" : "var(--accSoft)", color: i <= idx ? "#fff" : "var(--mut)" }}
          >
            {i + 1}. {it.label}
          </span>
          {i < items.length - 1 && <span className="text-mut2">→</span>}
        </div>
      ))}
    </div>
  );
}

function PreviewTable({
  preview,
  setPreview,
  busy,
  onBack,
  onCommit,
}: {
  preview: PreviewRow[];
  setPreview: (rows: PreviewRow[]) => void;
  busy: boolean;
  onBack: () => void;
  onCommit: () => void;
}) {
  const counts = {
    valid: preview.filter((r) => r.status === "valid").length,
    duplicate: preview.filter((r) => r.status === "duplicate").length,
    invalid: preview.filter((r) => r.status === "invalid").length,
  };
  const toImport = preview.filter((r) => !r.skip).length;

  function toggleSkip(rowIndex: number) {
    setPreview(preview.map((r) => (r.rowIndex === rowIndex ? { ...r, skip: !r.skip } : r)));
  }

  const STATUS_STYLE: Record<string, { bg: string; col: string; label: string }> = {
    valid: { bg: "var(--greenSoft)", col: "var(--green)", label: "OK" },
    duplicate: { bg: "var(--amberSoft)", col: "var(--amber)", label: "Duplicate" },
    invalid: { bg: "var(--redSoft)", col: "var(--red)", label: "Invalid" },
  };

  return (
    <div className="card p-6 flex flex-col gap-4">
      <div className="flex gap-3 flex-wrap text-[12.5px] font-semibold">
        <span className="px-2.5 py-1 rounded-full bg-greensoft text-green">{counts.valid} new</span>
        <span className="px-2.5 py-1 rounded-full bg-ambersoft text-amber">{counts.duplicate} duplicates</span>
        <span className="px-2.5 py-1 rounded-full bg-redsoft text-red">{counts.invalid} invalid</span>
        <span className="text-mut">· {toImport} will be imported</span>
      </div>
      <div className="max-h-[420px] overflow-auto border border-line rounded-lg">
        <table className="w-full text-[12px] border-collapse">
          <thead className="sticky top-0 bg-card">
            <tr className="border-b border-line text-left text-mut">
              <th className="py-1.5 px-2 font-semibold">Import?</th>
              <th className="py-1.5 px-2 font-semibold">Status</th>
              <th className="py-1.5 px-2 font-semibold">Date</th>
              <th className="py-1.5 px-2 font-semibold">Type</th>
              <th className="py-1.5 px-2 font-semibold">Amount</th>
              <th className="py-1.5 px-2 font-semibold">Merchant</th>
              <th className="py-1.5 px-2 font-semibold">Note</th>
            </tr>
          </thead>
          <tbody>
            {preview.map((r) => {
              const s = STATUS_STYLE[r.status];
              return (
                <tr key={r.rowIndex} className="border-b border-line">
                  <td className="py-1.5 px-2">
                    <input type="checkbox" checked={!r.skip} onChange={() => toggleSkip(r.rowIndex)} disabled={r.status === "invalid"} />
                  </td>
                  <td className="py-1.5 px-2">
                    <span className="px-2 py-0.5 rounded-full font-semibold" style={{ background: s.bg, color: s.col }}>{s.label}</span>
                  </td>
                  <td className="py-1.5 px-2">{r.ymd ?? "—"}</td>
                  <td className="py-1.5 px-2">{r.type ?? "—"}</td>
                  <td className="py-1.5 px-2">{r.amountPaise !== null ? formatPaise(r.amountPaise) : "—"}</td>
                  <td className="py-1.5 px-2 max-w-[160px] truncate">{r.merchant ?? "—"}</td>
                  <td className="py-1.5 px-2 text-mut2 max-w-[200px] truncate">{r.reason ?? ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onBack} className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold cursor-pointer">Back</button>
        <button disabled={busy || toImport === 0} onClick={onCommit} className="btn-primary disabled:opacity-50">
          {busy ? "Importing…" : `Import ${toImport} transaction${toImport === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}

const UNSUPPORTED_LABELS: Record<string, string> = {
  budgets: "Budgets",
  bills: "Bills",
  participants: "Lending participants",
  groups: "Groups",
  settlements: "Settlements",
  recurringRules: "Recurring rules",
  loanEntries: "Lending entries",
  loanAllocations: "Loan allocations",
  tags: "Tags",
};

const INVALID_REASON_LABELS: Record<string, string> = {
  duplicate: "duplicate",
  "missing or unsupported type": "missing or unsupported type",
  "amount missing or not a positive number": "amount missing or not a positive number",
  "merchant missing": "merchant missing",
  "date missing or invalid": "date missing or invalid",
  "referenced account missing": "referenced account missing",
  "transfer destination account missing": "transfer destination account missing",
  "transfer needs source and destination accounts": "transfer missing an account side",
};

function BackupRestoreSummary({
  preview,
  fileName,
  busy,
  onBack,
  onCommit,
}: {
  preview: Awaited<ReturnType<typeof previewBackupRestoreAction>>;
  fileName: string;
  busy: boolean;
  onBack: () => void;
  onCommit: () => void;
}) {
  const toImport = preview.validTransactions;
  const invalidBreakdown = preview.invalidBreakdown;
  const hasInvalidReasons = Object.keys(invalidBreakdown).length > 0;
  const unsupportedNames = preview.unsupported.map((k) => UNSUPPORTED_LABELS[k] ?? k);
  return (
    <div className="card p-6 flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="text-[13.5px] font-bold">Restore from {fileName}</div>
        {preview.formatVersion !== null && preview.formatVersion !== 1 && (
          <div className="text-[12px] text-amber bg-ambersoft rounded-lg px-3 py-2">
            ⚠ This backup was made with a newer format (v{preview.formatVersion}). Some fields may not restore — proceed only if you understand the risk.
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        <SummaryStat label="Transactions" value={preview.transactions} />
        <SummaryStat label="Will restore" value={toImport} tone="green" />
        <SummaryStat label="Duplicates skipped" value={preview.duplicateTransactions} tone="amber" />
        <SummaryStat label="Invalid skipped" value={preview.invalidTransactions} tone="red" />
        <SummaryStat label="New accounts" value={preview.newAccounts} />
        <SummaryStat label="Matched accounts" value={preview.matchedAccounts} />
        <SummaryStat label="New categories" value={preview.newCategories} />
        <SummaryStat label="Matched categories" value={preview.matchedCategories} />
      </div>

      {hasInvalidReasons && (
        <div className="text-[12px] text-red bg-redsoft rounded-lg px-3 py-2">
          <span className="font-semibold">Invalid rows:</span>{" "}
          {Object.entries(invalidBreakdown).map(([reason, count], i, arr) => (
            <span key={reason}>
              {count} {INVALID_REASON_LABELS[reason] ?? reason}{i < arr.length - 1 ? ", " : ""}
            </span>
          ))}
          . The backup must contain a supported type, a positive amount, a merchant, a valid date, and all referenced accounts (including transfer destinations).
        </div>
      )}

      {unsupportedNames.length > 0 && (
        <div className="text-[12px] text-amber bg-ambersoft rounded-lg px-3 py-2">
          <span className="font-semibold">Not restored:</span>{" "}
          {unsupportedNames.join(", ")}. Only the transaction ledger, accounts, and categories are restored in this version.
        </div>
      )}

      {(preview.unusableAccounts > 0 || preview.unusableCategories > 0) && (
        <div className="text-[12px] text-amber bg-ambersoft rounded-lg px-3 py-2">
          <span className="font-semibold">Incomplete entries:</span>{" "}
          {[
            preview.unusableAccounts > 0
              ? `${preview.unusableAccounts} account${preview.unusableAccounts === 1 ? "" : "s"}`
              : null,
            preview.unusableCategories > 0
              ? `${preview.unusableCategories} categor${preview.unusableCategories === 1 ? "y" : "ies"}`
              : null,
          ]
            .filter(Boolean)
            .join(" and ")}{" "}
          in this backup are missing a name or type and can&apos;t be restored. Any transaction that referenced them is counted under invalid rows above.
        </div>
      )}

      {(preview.earliest || preview.latest) && (
        <div className="text-[12px] text-mut">
          {preview.earliest && <span>From <b className="text-ink">{preview.earliest}</b></span>}
          {preview.earliest && preview.latest && <span> · </span>}
          {preview.latest && <span>to <b className="text-ink">{preview.latest}</b></span>}
        </div>
      )}

      {preview.sample.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="label-caps">SAMPLE</div>
          <div className="max-h-[180px] overflow-auto border border-line rounded-lg">
            <table className="w-full text-[12px] border-collapse">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b border-line text-left text-mut">
                  <th className="py-1.5 px-2 font-semibold">Date</th>
                  <th className="py-1.5 px-2 font-semibold">Type</th>
                  <th className="py-1.5 px-2 font-semibold">Amount</th>
                  <th className="py-1.5 px-2 font-semibold">Merchant</th>
                </tr>
              </thead>
              <tbody>
                {preview.sample.map((r, i) => (
                  <tr key={i} className="border-b border-line">
                    <td className="py-1.5 px-2">{r.date ?? "—"}</td>
                    <td className="py-1.5 px-2">{r.type ?? "—"}</td>
                    <td className="py-1.5 px-2">{r.amount !== null ? formatPaise(r.amount) : "—"}</td>
                    <td className="py-1.5 px-2 max-w-[160px] truncate">{r.merchant ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="text-[12px] text-mut bg-accsoft rounded-lg px-3 py-2.5">
        Accounts &amp; categories are matched by name; only the missing ones are created, starting from their opening balance so the restored ledger adds up. Budgets, bills, lending entries, settlements, recurring rules and tags from the backup aren&apos;t restored in this version — only the transaction ledger. You can undo the whole restore in one step from Settings → Import history.
      </div>

      <div className="flex gap-2 justify-end">
        <button onClick={onBack} className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold cursor-pointer">Back</button>
        <button disabled={busy || toImport === 0} onClick={onCommit} className="btn-primary disabled:opacity-50">
          {busy ? "Restoring…" : `Restore ${toImport} transaction${toImport === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}

function SummaryStat({ label, value, tone }: { label: string; value: number; tone?: "green" | "amber" | "red" }) {
  const color = tone === "green" ? "var(--green)" : tone === "amber" ? "var(--amber)" : tone === "red" ? "var(--red)" : "var(--ink)";
  return (
    <div className="bg-accsoft rounded-[10px] px-3 py-2.5">
      <div className="text-[10px] font-semibold text-mut tracking-[.04em] uppercase">{label}</div>
      <div className="text-[18px] font-extrabold mt-0.5" style={{ color }}>{value}</div>
    </div>
  );
}

const CREATE_NEW = "__create_new__";

function CategoryMapRow({
  rawValue,
  value,
  options,
  onChange,
  onCreated,
}: {
  rawValue: string;
  value: string;
  options: { id: string; name: string; icon: string }[];
  onChange: (v: string) => void;
  onCreated: (cat: { id: string; name: string; icon: string }) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(rawValue);
  const [kind, setKind] = useState<"EXPENSE" | "INCOME">("EXPENSE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (creating) {
    return (
      <div className="flex items-center gap-2.5 flex-wrap bg-accsoft rounded-lg p-2.5">
        <div className="flex-1 min-w-[120px] text-[12.5px] font-medium truncate">{rawValue}</div>
        <input className="field !w-auto !py-1.5 min-w-[140px]" value={name} onChange={(e) => setName(e.target.value)} placeholder="Category name" autoFocus />
        <div className="flex gap-1">
          {(["EXPENSE", "INCOME"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className="px-2.5 py-1.5 rounded-lg text-[11.5px] font-semibold cursor-pointer border-none"
              style={{ background: kind === k ? "var(--acc)" : "var(--card)", color: kind === k ? "#fff" : "var(--acc)" }}
            >
              {k === "EXPENSE" ? "Expense" : "Income"}
            </button>
          ))}
        </div>
        <button
          disabled={busy || !name.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const res = await createCategoryAction({ name, kind });
            setBusy(false);
            if (!res.ok || !res.category) {
              setError(!res.ok ? res.error : "Couldn't create category");
              return;
            }
            onCreated(res.category);
            setCreating(false);
          }}
          className="px-3 py-1.5 rounded-lg bg-acc text-white text-[11.5px] font-bold cursor-pointer border-none disabled:opacity-50"
        >
          {busy ? "…" : "Add"}
        </button>
        <button onClick={() => setCreating(false)} className="px-2.5 py-1.5 rounded-lg border border-line2 text-[11.5px] font-semibold cursor-pointer bg-card">
          Cancel
        </button>
        {error && <div className="w-full text-[11.5px] font-semibold text-red">{error}</div>}
      </div>
    );
  }

  const resolved = value !== "";
  return (
    <div className="flex items-center gap-2.5">
      {!resolved && <span className="text-amber text-[13px]" title="Needs a decision">●</span>}
      <div className="flex-1 text-[12.5px] font-medium truncate">{rawValue}</div>
      <select
        className="field !w-auto min-w-[200px]"
        value={value}
        style={!resolved ? { borderColor: "var(--amber)" } : undefined}
        onChange={(e) => (e.target.value === CREATE_NEW ? setCreating(true) : onChange(e.target.value))}
      >
        <option value="" disabled>Choose one…</option>
        {options.map((cat) => (
          <option key={cat.id} value={cat.id}>{cat.icon} {cat.name}</option>
        ))}
        <option value={CREATE_NEW}>+ Create new category…</option>
        <option value={UNCATEGORIZED}>Leave uncategorized</option>
      </select>
    </div>
  );
}
