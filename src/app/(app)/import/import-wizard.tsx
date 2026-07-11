"use client";

// Import wizard: upload → column mapping → category/account mapping → preview
// (validate + dedupe) → commit. Rows live in client state between steps and
// server actions do the actual validation/dedupe/insert — stateless by design
// so this works the same locally and on serverless deployments.

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  commitImportAction,
  createCategoryAction,
  getSavedMappingAction,
  previewImportAction,
} from "@/app/actions";
import type { ColumnMapping, PreviewRow, TargetField } from "@/lib/import/types";
import { emptyMapping } from "@/lib/import/types";
import { formatPaise } from "@/lib/money";
import { useUI } from "@/components/shell/ui-context";

type Step = "upload" | "mapping" | "resolve" | "preview";

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
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [assign, setAssign] = useState<Record<string, TargetField>>({});
  const [amountSign, setAmountSign] = useState<ColumnMapping["amountSign"]>("negative-is-expense");
  const [categoryMap, setCategoryMap] = useState<Record<string, string>>({});
  const [extraCategories, setExtraCategories] = useState<{ id: string; name: string; icon: string }[]>([]);
  const [accountMap, setAccountMap] = useState<Record<string, string>>({});
  const [defaultAccountId, setDefaultAccountId] = useState(refData.accounts[0]?.id ?? "");
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);

  const mapping = useMemo(() => columnFieldToMapping(assign, amountSign), [assign, amountSign]);

  async function handleUpload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/import/parse", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upload failed");
      setHeaders(data.headers);
      setRows(data.rows);
      setFileName(data.fileName);
      const guessedSource = String(data.fileName).replace(/\.[^.]+$/, "");
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
        <div className="card p-6 flex flex-col gap-3 items-start">
          <div className="text-[13.5px] font-bold">Upload a CSV or Excel file</div>
          <div className="text-[12.5px] text-mut">
            Works with exports from Monito, bank statements, or any spreadsheet with date/amount/merchant columns.
            Nothing is written to your ledger until you review and confirm at the end.
          </div>
          <label className="btn-primary cursor-pointer">
            {busy ? "Reading…" : "Choose file"}
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              disabled={busy}
              onChange={(e) => e.target.files?.[0] && handleUpload(e.target.files[0])}
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
                Values that don&apos;t match one of your categories yet (e.g. &quot;Clothing&quot;) can be created on the spot.
              </div>
              <div className="flex flex-col gap-2">
                {distinctCategories.map((c) => (
                  <CategoryMapRow
                    key={c}
                    rawValue={c}
                    value={categoryMap[c] ?? ""}
                    options={[...refData.expenseCategories, ...refData.incomeCategories, ...extraCategories]}
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
              <option value="">No account (unassigned)</option>
              {refData.accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>{acc.icon} {acc.name}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setStep("mapping")} className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold cursor-pointer">Back</button>
            <button disabled={busy} onClick={runPreview} className="btn-primary disabled:opacity-50">{busy ? "Validating…" : "Preview import"}</button>
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
    </div>
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

  return (
    <div className="flex items-center gap-2.5">
      <div className="flex-1 text-[12.5px] font-medium truncate">{rawValue}</div>
      <select
        className="field !w-auto min-w-[200px]"
        value={value}
        onChange={(e) => (e.target.value === CREATE_NEW ? setCreating(true) : onChange(e.target.value))}
      >
        <option value="">Auto-detect from merchant</option>
        {options.map((cat) => (
          <option key={cat.id} value={cat.id}>{cat.icon} {cat.name}</option>
        ))}
        <option value={CREATE_NEW}>+ Create new category…</option>
      </select>
    </div>
  );
}
