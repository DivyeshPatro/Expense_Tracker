// Lending import adapters (mapping profiles).
//
// Khatabook is the only one today. To add OkCredit / Vyapar / a generic ledger
// later, append an adapter here — no engine changes. Keep detection signatures
// distinct enough that two adapters don't both claim the same file with high
// confidence; `detectLendingSource` picks the highest score and falls back to a
// manual choice when the best is weak.

import { norm } from "../detect-columns";
import type { LendingSourceAdapter } from "./types";

/**
 * Khatabook exports. Real-world headers vary a lot ("You Gave" vs "Debit(-)"
 * vs "Given", party column called "Name"/"Customer"/"Party"), so the aliases
 * are deliberately broad and matched by `norm()` rather than exact text.
 */
export const khatabookAdapter: LendingSourceAdapter = {
  id: "khatabook",
  label: "Khatabook Lending Import",
  aliases: {
    contact: ["name", "customer", "customername", "party", "partyname", "contact", "account", "person"],
    date: ["date", "entrydate", "transactiondate", "txndate"],
    gave: ["yougave", "gave", "given", "debit", "debitamount", "dr", "youpaid", "paid"],
    got: ["yougot", "got", "received", "credit", "creditamount", "cr", "yoursreceived", "receivedamount"],
    amount: ["amount", "amt"],
    type: ["type", "entrytype", "transactiontype", "gavegot", "inout", "cashinout", "direction"],
    note: ["note", "notes", "details", "description", "remark", "remarks", "narration", "particulars"],
    balance: ["balance", "runningbalance", "closingbalance", "netbalance"],
  },
  detect(headers) {
    const set = new Set(headers.map(norm));
    const has = (syns: string[]) => syns.some((s) => set.has(s));
    // The signature of a lending ledger (vs. an expense CSV) is a party/contact
    // column plus directional gave/got — either the two-column shape or a
    // single amount with a type column.
    const hasContact = has(khatabookAdapter.aliases.contact);
    const hasDirection =
      (has(khatabookAdapter.aliases.gave ?? []) && has(khatabookAdapter.aliases.got ?? [])) ||
      (has(khatabookAdapter.aliases.amount ?? []) && has(khatabookAdapter.aliases.type ?? []));
    const hasDate = has(khatabookAdapter.aliases.date);
    if (!hasContact || !hasDirection) return 0;
    // Contact + direction is a strong signal; date pushes it to near-certain.
    return hasDate ? 0.95 : 0.75;
  },
};

/** The adapter registry. Order is irrelevant; detection scores decide. */
export const LENDING_ADAPTERS: LendingSourceAdapter[] = [khatabookAdapter];

export function lendingAdapterById(id: string): LendingSourceAdapter | undefined {
  return LENDING_ADAPTERS.find((a) => a.id === id);
}
