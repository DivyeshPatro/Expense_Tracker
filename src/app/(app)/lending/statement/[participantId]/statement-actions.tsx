"use client";

// Action bar for the printable statement (v2.1 Lending 2.0). Print → the
// browser's "Save as PDF" produces the shareable statement (#57/#60); the
// From/To range scopes it (#59). Hidden when printing. Excel + share land in
// follow-up increments.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DateField } from "@/components/shell/date-field";

export function StatementActions({
  participantId,
  from,
  to,
  today,
  shareText,
}: {
  participantId: string;
  from?: string;
  to?: string;
  today: string;
  shareText: string;
}) {
  const router = useRouter();
  const [f, setF] = useState(from ?? "");
  const [t, setT] = useState(to ?? "");
  const [open, setOpen] = useState(false);

  const rangeQs = (() => {
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    const s = qs.toString();
    return s ? `&${s}` : "";
  })();

  async function share() {
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: "Ledgerly statement", text: shareText });
        return;
      } catch {
        // user cancelled or share failed — fall through to WhatsApp
      }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, "_blank", "noopener");
  }

  function apply() {
    const qs = new URLSearchParams();
    if (f) qs.set("from", f);
    if (t) qs.set("to", t);
    const s = qs.toString();
    router.push(`/lending/statement/${participantId}${s ? `?${s}` : ""}`);
    setOpen(false);
  }
  function clear() {
    setF("");
    setT("");
    router.push(`/lending/statement/${participantId}`);
    setOpen(false);
  }

  const rangeLabel = from || to ? "Custom range" : "All time";

  return (
    <div className="flex flex-col gap-2 print:hidden">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/lending?contact=${participantId}`}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-ink no-underline hover:bg-accsoft"
        >
          ← Back
        </Link>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-ink cursor-pointer hover:bg-accsoft"
        >
          📅 {rangeLabel}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ transform: open ? "rotate(180deg)" : "none" }}><path d="m6 9 6 6 6-6" /></svg>
        </button>
        <div className="flex-1" />
        <button
          onClick={share}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-ink cursor-pointer hover:bg-accsoft"
        >
          🔗 Share
        </button>
        <a
          href={`/api/export/lending-statement?participant=${participantId}${rangeQs}`}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-ink no-underline cursor-pointer hover:bg-accsoft"
        >
          ⬇ Excel
        </a>
        <button
          onClick={() => window.print()}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-lg text-[12.5px] font-bold text-white cursor-pointer border-none bg-acc hover:brightness-108"
        >
          🖨 PDF
        </button>
      </div>

      {open && (
        <div className="flex flex-wrap items-end gap-2 p-3 rounded-xl border border-line bg-card" style={{ boxShadow: "var(--sh)" }}>
          <label className="flex flex-col gap-1">
            <span className="label-caps">From</span>
            <DateField value={f} max={t || today} onChange={setF} aria-label="Statement from date" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label-caps">To</span>
            <DateField value={t} min={f} max={today} onChange={setT} aria-label="Statement to date" />
          </label>
          <button onClick={apply} className="h-10 px-4 rounded-lg text-[12.5px] font-bold text-white cursor-pointer border-none bg-acc">Apply</button>
          {(from || to) && <button onClick={clear} className="h-10 px-3 rounded-lg text-[12.5px] font-semibold cursor-pointer border border-line2 bg-card text-mut">All time</button>}
        </div>
      )}
    </div>
  );
}
