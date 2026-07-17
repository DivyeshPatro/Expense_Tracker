"use client";

// Small, generic building blocks shared by every modal form (create *and*
// edit) — kept dependency-free of any specific form's business logic so
// reuse never grows into coupling.

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { ActionResult } from "@/app/actions";
import { useUI } from "./ui-context";

export function useSubmit() {
  const { closeModal, showToast } = useUI();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // a ref, not just `busy` state: two clicks landing in the same tick both
  // fire before React commits the disabled attribute, so the DOM-level
  // guard alone can't stop a true double-tap from submitting twice — this
  // check is synchronous and closes that gap (offline-sync spec §17 Phase 2
  // exit criterion: "double-tap submit produces one intent")
  const inFlight = useRef(false);
  async function run(
    action: () => Promise<ActionResult & { queued?: boolean }>,
    successMsg: string | ((res: ActionResult & { queued?: boolean }) => string)
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const res = await action();
    inFlight.current = false;
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    closeModal();
    showToast(typeof successMsg === "function" ? successMsg(res) : successMsg);
    // a queued (offline) create changed nothing server-side — refreshing would
    // fire a doomed RSC fetch; the local echo renders from the outbox instead,
    // and the drain refreshes when the change actually lands
    if (!res.queued) router.refresh();
  }
  return { run, busy, error };
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex-1 min-w-[130px]">
      <div className="label-caps">{label}</div>
      {children}
    </div>
  );
}

export function AmountInput({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <input
      type="number"
      inputMode="decimal"
      min="0"
      step="0.01"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="0"
      autoFocus={autoFocus}
      className="field !py-3 !text-[19px] !font-bold"
    />
  );
}

export function SubmitButton({
  busy,
  color,
  children,
  onClick,
}: {
  busy: boolean;
  color?: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="p-3 rounded-[10px] text-white text-[13.5px] font-bold text-center cursor-pointer border-none hover:brightness-108 disabled:opacity-60"
      style={{ background: color ?? "var(--acc)" }}
    >
      {busy ? "…" : children}
    </button>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="text-[12.5px] font-semibold text-red bg-redsoft rounded-lg px-3 py-2">{error}</div>;
}
