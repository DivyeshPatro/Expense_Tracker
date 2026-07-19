"use client";

// Destructive actions require typing a confirmation word — cheap insurance
// against a stray click wiping real data.

import { useState } from "react";
import { clearTransactionsAction, deleteMyAccountAction } from "@/app/actions";
import { authClient } from "@/lib/auth-client";
import { useUI } from "@/components/shell/ui-context";

export function DangerZone() {
  const [confirmMode, setConfirmMode] = useState<"clear" | "delete" | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <button
        onClick={() => setConfirmMode("clear")}
        className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-red cursor-pointer self-start hover:bg-redsoft"
      >
        Clear all transactions
      </button>
      <div className="text-[12px] text-mut2 -mt-2">
        Deletes every transaction, split, settlement, bill and recurring rule, and resets account balances back to
        their opening balance. Accounts, categories, budgets, friends and lending records (money lent or borrowed)
        stay as-is — that&apos;s a separate ledger. Use this before importing your real history over the demo data.
      </div>
      <button
        onClick={() => setConfirmMode("delete")}
        className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-red cursor-pointer self-start hover:bg-redsoft"
      >
        Delete my account
      </button>
      <div className="text-[12px] text-mut2 -mt-2">Permanently deletes your account and everything in it. This cannot be undone.</div>
      {confirmMode && <ConfirmModal mode={confirmMode} close={() => setConfirmMode(null)} />}
    </div>
  );
}

function ConfirmModal({ mode, close }: { mode: "clear" | "delete"; close: () => void }) {
  const { showToast } = useUI();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const word = mode === "clear" ? "CLEAR" : "DELETE";
  const title = mode === "clear" ? "Clear all transactions?" : "Delete your account?";
  const desc =
    mode === "clear"
      ? "This wipes all transactions, splits, settlements, bills and recurring rules, and resets every account balance to its opening balance. Lending records are a separate ledger and are not affected. This cannot be undone."
      : "This permanently deletes your account, accounts, transactions, budgets, friends — everything. This cannot be undone.";

  async function confirm() {
    setBusy(true);
    setError(null);
    const res = mode === "clear" ? await clearTransactionsAction() : await deleteMyAccountAction();
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (mode === "delete") {
      await authClient.signOut();
      window.location.href = "/sign-in";
      return;
    }
    showToast("All transactions cleared");
    close();
    window.location.reload();
  }

  return (
    <div onClick={close} className="fixed inset-0 z-[60] flex items-center justify-center p-4" style={{ background: "var(--ov)" }}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-[420px] bg-card rounded-2xl p-6 flex flex-col gap-3" style={{ boxShadow: "var(--shLg)" }}>
        <div className="text-base font-extrabold">{title}</div>
        <div className="text-[12.5px] text-mut">{desc}</div>
        <div>
          <label className="label-caps" htmlFor="confirm-word">Type {word} to confirm</label>
          <input id="confirm-word" aria-label="Confirmation text" className="field" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </div>
        {error && <div className="text-[12.5px] font-semibold text-red bg-redsoft rounded-lg px-3 py-2">{error}</div>}
        <div className="flex gap-2 justify-end">
          <button onClick={close} className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold cursor-pointer">Cancel</button>
          <button
            disabled={text !== word || busy}
            onClick={confirm}
            className="px-3.5 py-2 rounded-lg bg-red text-white text-[12.5px] font-bold cursor-pointer border-none disabled:opacity-50"
          >
            {busy ? "…" : title}
          </button>
        </div>
      </div>
    </div>
  );
}
