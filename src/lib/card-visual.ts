// How a card looks in the gallery.
//
// The point of the visual is recognition, not decoration: at a checkout page
// you are looking for *your* HDFC card among four, and you find it by colour
// and shape long before you read the text. So the palette is deliberately
// high-contrast and the gradient is derived from a single stored colour rather
// than being freely styled — every card stays legible in both themes.

import type { CardNetwork } from "./card-identity";

export interface CardColorOption {
  value: string;
  label: string;
}

/** The colours offered in the form. Stored as the hex string in `color`. */
export const CARD_COLORS: CardColorOption[] = [
  { value: "#1e3a8a", label: "Navy" },
  { value: "#0f766e", label: "Teal" },
  { value: "#7c2d12", label: "Rust" },
  { value: "#4c1d95", label: "Violet" },
  { value: "#166534", label: "Forest" },
  { value: "#9f1239", label: "Crimson" },
  { value: "#334155", label: "Slate" },
  { value: "#a16207", label: "Amber" },
];

/** Fallback when the user hasn't picked a colour, keyed by network so an
 *  unstyled gallery still looks intentional rather than uniformly grey. */
const NETWORK_DEFAULTS: Record<CardNetwork, string> = {
  VISA: "#1e3a8a",
  MASTERCARD: "#7c2d12",
  RUPAY: "#166534",
  AMEX: "#0f766e",
  DINERS: "#334155",
  OTHER: "#4c1d95",
};

export function cardColor(color: string | null, network: CardNetwork): string {
  return color?.trim() || NETWORK_DEFAULTS[network] || NETWORK_DEFAULTS.OTHER;
}

/**
 * The plastic. A diagonal wash from the base colour into a lighter mix of
 * itself — enough depth to read as a card without needing an image, and it
 * works for any base colour including ones typed in by hand.
 */
export function cardGradient(color: string | null, network: CardNetwork): string {
  const base = cardColor(color, network);
  return `linear-gradient(135deg, ${base} 0%, color-mix(in oklab, ${base} 72%, black) 100%)`;
}
