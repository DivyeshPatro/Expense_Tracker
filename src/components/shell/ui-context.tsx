"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";

export type ModalType =
  | "exp"
  | "inc"
  | "tr"
  | "settle"
  | "budget"
  | "account"
  | "bill"
  | "friend"
  | "group"
  | "txDetail"
  | "pendingDetail"
  | "lendingEntry"
  | "lendingContact"
  | "loanDetail"
  | "accountCardDetails";

export interface ModalPrefill {
  split?: boolean;
  participantId?: string;
  participantName?: string;
  direction?: "TO_OWNER" | "FROM_OWNER";
  amountRupees?: string;
  transactionId?: string;
  intentId?: string;
  loanKind?: "GAVE" | "GOT"; // lending-module-phase1
  loanEntryId?: string; // lending-module-phase2
  accountId?: string; // lending-module-phase2 (card vault edit)
  targetLoanEntryId?: string; // lending-module-phase2: "Record Repayment" from Loan Detail — pre-allocates 100% to this loan
  targetLoanRemainingRupees?: string;
}

export interface RefData {
  accounts: {
    id: string;
    name: string;
    icon: string;
    // lending-module-phase2: Card Vault fields, populated for CREDIT_CARD accounts only
    type?: string;
    cardNetwork?: string | null;
    cardLast4?: string | null;
    statementDay?: number | null;
    dueDay?: number | null;
  }[];
  expenseCategories: { id: string; name: string; icon: string }[];
  incomeCategories: { id: string; name: string; icon: string }[];
  participants: { id: string; name: string; initial: string; color: string }[];
  groups: { id: string; name: string; role: "OWNER" | "ADMIN" | "MEMBER" }[];
  userName: string;
}

interface UIState {
  refData: RefData;
  modal: { type: ModalType; prefill?: ModalPrefill } | null;
  openModal: (type: ModalType, prefill?: ModalPrefill) => void;
  closeModal: () => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  toast: { msg: string; undo?: () => void } | null;
  showToast: (msg: string, undo?: () => void) => void;
  dismissToast: () => void;
}

const UIContext = createContext<UIState | null>(null);

export function useUI(): UIState {
  const ctx = useContext(UIContext);
  if (!ctx) throw new Error("useUI outside provider");
  return ctx;
}

export function UIProvider({ refData, children }: { refData: RefData; children: React.ReactNode }) {
  const [modal, setModal] = useState<UIState["modal"]>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toast, setToast] = useState<UIState["toast"]>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string, undo?: () => void) => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ msg, undo });
    timer.current = setTimeout(() => setToast(null), 4500);
  }, []);

  const openModal = useCallback((type: ModalType, prefill?: ModalPrefill) => {
    setModal({ type, prefill });
    setPaletteOpen(false);
  }, []);

  return (
    <UIContext.Provider
      value={{
        refData,
        modal,
        openModal,
        closeModal: () => setModal(null),
        paletteOpen,
        setPaletteOpen,
        toast,
        showToast,
        dismissToast: () => setToast(null),
      }}
    >
      {children}
    </UIContext.Provider>
  );
}
