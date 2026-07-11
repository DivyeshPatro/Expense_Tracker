"use client";

// Small client buttons used inside server-rendered pages.

import { useRouter } from "next/navigation";
import { useState } from "react";
import { payBillAction } from "@/app/actions";
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
