// Matching a card against what someone typed into the gallery search box.
//
// Everything matched against is already visible on the card face — nickname,
// bank, network, last four, cardholder name. Nothing encrypted is searchable,
// deliberately: a search that could match the full number would be an oracle
// for guessing it four digits at a time, and would need the number decrypted on
// every keystroke to work at all.

import { networkLabel } from "./card-identity";
import type { CreditCardListItem } from "@/server/services/credit-cards";

/** The fields a card is searchable by, as one lowercase haystack. */
function haystack(card: CreditCardListItem): string {
  return [card.nickname, card.bank, card.last4, networkLabel(card.network), card.cardholderName ?? ""]
    .join(" ")
    .toLowerCase();
}

export function cardMatchesQuery(card: CreditCardListItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = haystack(card);
  // Every whitespace-separated term must appear, so "hdfc 4242" narrows rather
  // than failing — the two words are never adjacent in any single field.
  return q.split(/\s+/).every((term) => hay.includes(term));
}
