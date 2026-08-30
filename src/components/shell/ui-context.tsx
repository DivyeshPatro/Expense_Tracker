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
  // The full-screen transaction composer. Rendered outside the modal panel
  // (see modals.tsx) because it owns the whole screen rather than sitting in a
  // sheet, so it takes no title and no chrome from the shell.
  | "compose"
  | "group"
  | "txDetail"
  | "pendingDetail"
  | "lendingEntry"
  | "lendingContact"
  | "loanDetail"
  | "accountCardDetails"
  | "settleMembers";

export interface ModalPrefill {
  split?: boolean;
  participantId?: string;
  participantName?: string;
  direction?: "TO_OWNER" | "FROM_OWNER";
  amountRupees?: string;
  /** The member's current net before this settlement (paise; >0 they owe you,
   *  <0 you owe them) — powers the settle form's live before/after preview. */
  settleNetPaise?: number;
  /** Attributes the settlement to a group (from the Group Dashboard) so it
   *  clears that group's balance, not a shared one. */
  settleGroupId?: string;
  // #240 — a payment between two members. The pair IS the direction, so there
  // is no TO_OWNER/FROM_OWNER here and no account: the owner's money does not
  // move, which is exactly why this cannot reuse the fields above.
  fromParticipantId?: string;
  fromParticipantName?: string;
  toParticipantId?: string;
  toParticipantName?: string;
  transactionId?: string;
  intentId?: string;
  loanKind?: "GAVE" | "GOT"; // lending-module-phase1
  loanEntryId?: string; // lending-module-phase2
  accountId?: string; // lending-module-phase2 (card vault edit)
  targetLoanEntryId?: string; // lending-module-phase2: "Record Repayment" from Loan Detail — pre-allocates 100% to this loan
  targetLoanRemainingRupees?: string;
  // Duplicate-from-existing (Phase 2.9): one shared shape read by
  // ExpenseForm/IncomeForm/TransferForm/LendingEntryForm as create-form
  // initial state — each form only reads the fields relevant to it and
  // ignores the rest. Date is deliberately NOT carried — a duplicate
  // defaults to today, matching "repeat this" intent; the user can still
  // change it like any other field.
  dupAmountRupees?: string;
  dupAccountId?: string | null;
  dupToAccountId?: string | null; // transfer only
  dupCategoryId?: string | null;
  dupMerchant?: string; // transaction merchant, or a lending entry's reason — same "what/who was this for" concept
  dupNotes?: string;
  dupGroupId?: string | null; // transaction only
  dupDueDate?: string | null; // GAVE lending entries only
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
  participants: { id: string; name: string; initial: string; color: string; phone: string | null; lendingOnly: boolean; isLending: boolean }[];
  groups: { id: string; name: string; role: "OWNER" | "ADMIN" | "MEMBER"; memberIds: string[] }[];
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
