"use client";

// Shared <option> list for every account / funding-source picker.
//
// These pickers used to render one flat list of accounts, so "which funding kind
// is this?" was answerable only by reading account names — a card and the bank
// behind it look identical when the only difference is what the user chose to
// type. Grouping by account type makes the funding kinds (Cash / Bank / Wallet /
// Credit card) explicit at the point of choice, and credit-card rows carry their
// Card Vault identity (network + last4) so the card is recognisable without
// leaving the form.
//
// Deliberately an <optgroup> list rather than a custom dropdown: it stays a
// native <select>, which keeps keyboard/screen-reader behaviour and the existing
// `field` styling for free, and option labels are unchanged so anything selecting
// an option by its label still works.

import { accountOptionLabel, groupAccountsByType, type AccountForPicker } from "@/lib/account-groups";

export function AccountOptions({ accounts }: { accounts: AccountForPicker[] }) {
  const groups = groupAccountsByType(accounts);

  // One group is no group: with a single type present the header is pure noise.
  if (!groups) {
    return (
      <>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>{accountOptionLabel(a)}</option>
        ))}
      </>
    );
  }

  return (
    <>
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.items.map((a) => (
            <option key={a.id} value={a.id}>{accountOptionLabel(a)}</option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
