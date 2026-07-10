"use client";

// Small client buttons used inside server-rendered pages.

import { useRouter } from "next/navigation";
import { useState } from "react";
import { deleteTransactionAction, payBillAction, undoDeleteAction } from "@/app/actions";
import { useUI, type ModalPrefill, type ModalType } from "./ui-context";

export function OpenModalButton({
  type,
  prefill,
  className,
  children,
}: {
  type: ModalType;
  prefill?: ModalPrefill;
  className?: string;
  children: React.ReactNode;
}) {
  const { openModal } = useUI();
  return (
    <button onClick={() => openModal(type, prefill)} className={className}>
      {children}
    </button>
  );
}

export function PayBillButton({ billId, label }: { billId: string; label: string }) {
  const { showToast } = useUI();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const res = await payBillAction(billId);
        setBusy(false);
        showToast(res.ok ? label : !res.ok && "error" in res ? res.error : "Failed");
        router.refresh();
      }}
      className="px-3 py-[7px] rounded-lg border border-line2 text-[11.5px] font-semibold text-acc cursor-pointer bg-transparent hover:bg-accsoft disabled:opacity-60"
    >
      {busy ? "…" : "Mark paid"}
    </button>
  );
}

export function DeleteTxButton({ id }: { id: string }) {
  const { showToast } = useUI();
  const router = useRouter();
  return (
    <button
      title="Delete"
      aria-label="Delete transaction"
      onClick={async () => {
        const res = await deleteTransactionAction(id);
        if (!res.ok) {
          showToast(res.error);
          return;
        }
        router.refresh();
        showToast("Transaction deleted", async () => {
          const undo = await undoDeleteAction(id);
          showToast(undo.ok ? "Restored" : "Could not restore");
          router.refresh();
        });
      }}
      className="text-[13px] text-mut2 cursor-pointer p-1 bg-transparent border-none hover:text-red"
    >
      ✕
    </button>
  );
}
