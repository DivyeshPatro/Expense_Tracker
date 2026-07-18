"use client";

// Lending module: the mobile/default modal host for a contact's ledger. All
// the actual content (summary card, quick actions, grouped entry timeline,
// contact editing) lives in the shared ContactLedgerView — this file is just
// the modal chrome wrapper, matching how transaction-detail.tsx hosts
// TransactionDetailSheet. The desktop two-pane view
// (src/components/lending/lending-workspace.tsx) renders the exact same
// ContactLedgerView inline instead of in a modal.

import { ContactLedgerView } from "@/components/lending/contact-ledger";

export function LendingContactSheet({ participantId }: { participantId: string }) {
  return <ContactLedgerView participantId={participantId} />;
}
