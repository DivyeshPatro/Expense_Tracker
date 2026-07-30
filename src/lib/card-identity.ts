// Card number identity: validation, network detection, last-4 and masking.
//
// Pure functions, no crypto and no I/O, so both the server (on save) and the
// client (live feedback while typing) can use the same logic and cannot
// disagree about what network a number is.

export type CardNetwork = "VISA" | "MASTERCARD" | "RUPAY" | "AMEX" | "DINERS" | "OTHER";

export const CARD_NETWORKS: { value: CardNetwork; label: string }[] = [
  { value: "VISA", label: "Visa" },
  { value: "MASTERCARD", label: "Mastercard" },
  { value: "RUPAY", label: "RuPay" },
  { value: "AMEX", label: "Amex" },
  { value: "DINERS", label: "Diners" },
  { value: "OTHER", label: "Other" },
];

export function networkLabel(network: CardNetwork): string {
  return CARD_NETWORKS.find((n) => n.value === network)?.label ?? "Other";
}

/** Strips spaces and dashes — people paste card numbers in every format. */
export function normalizeCardNumber(input: string): string {
  return input.replace(/[\s-]/g, "");
}

/**
 * Luhn check digit — the standard mod-10 algorithm every issuer's numbers
 * satisfy. Catches transposed and mistyped digits; it is not a claim that the
 * card exists or is active.
 */
export function isValidLuhn(cardNumber: string): boolean {
  const digits = normalizeCardNumber(cardNumber);
  if (!/^\d+$/.test(digits)) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Network from the issuer identification number (leading digits).
 *
 * Ranges are the published IIN assignments. RuPay is checked before the generic
 * Mastercard 2-series because RuPay's 60/65/81/82 ranges and Maestro/Mastercard
 * ranges are distinct but easy to conflate, and an Indian deployment sees RuPay
 * far more often than Maestro. Anything unrecognised returns OTHER rather than
 * guessing — the user can always set it by hand.
 */
export function detectNetwork(cardNumber: string): CardNetwork {
  const n = normalizeCardNumber(cardNumber);
  if (!/^\d{2,}$/.test(n)) return "OTHER";

  const two = Number(n.slice(0, 2));
  const four = n.length >= 4 ? Number(n.slice(0, 4)) : NaN;
  const six = n.length >= 6 ? Number(n.slice(0, 6)) : NaN;

  if (n.startsWith("4")) return "VISA";
  if (two === 34 || two === 37) return "AMEX";
  if (two === 36 || two === 38 || two === 39) return "DINERS";
  if (n.length >= 4 && four >= 3000 && four <= 3059) return "DINERS";
  // RuPay: 60, 65, 81, 82, plus the 6521/6522 co-badged ranges and 508xxx.
  if (two === 60 || two === 65 || two === 81 || two === 82) return "RUPAY";
  if (!Number.isNaN(six) && six >= 508500 && six <= 508999) return "RUPAY";
  if (two >= 51 && two <= 55) return "MASTERCARD";
  if (!Number.isNaN(four) && four >= 2221 && four <= 2720) return "MASTERCARD";
  return "OTHER";
}

/** Digit-count rules per network — Amex is 15, Diners 14, the rest 16. */
export function isPlausibleLength(cardNumber: string, network?: CardNetwork): boolean {
  const n = normalizeCardNumber(cardNumber);
  const net = network ?? detectNetwork(n);
  if (net === "AMEX") return n.length === 15;
  if (net === "DINERS") return n.length === 14 || n.length === 16;
  // 13 covers legacy Visa; otherwise the modern 16, and 19 for extended ranges.
  return n.length === 13 || n.length === 16 || n.length === 19;
}

export function lastFour(cardNumber: string): string {
  return normalizeCardNumber(cardNumber).slice(-4);
}

/**
 * Display mask. Amex groups 4-6-5 as printed on the card; everything else in
 * groups of four. Only the final four digits are ever revealed.
 */
export function maskCardNumber(cardNumber: string): string {
  const n = normalizeCardNumber(cardNumber);
  const last = n.slice(-4);
  if (detectNetwork(n) === "AMEX") return `•••• •••••• •${last}`;
  return `•••• •••• •••• ${last}`;
}

/**
 * The display mask when only the last four digits are known.
 *
 * The gallery never receives a full card number — it isn't in the payload at
 * all — so it can't mask one. This builds the mask from last4 and the network
 * directly, which is the only information the gallery actually has.
 */
export function maskFromLast4(network: CardNetwork, last4: string): string {
  const tail = last4.slice(-4).padStart(4, "•");
  return network === "AMEX" ? `•••• •••••• •${tail}` : `•••• •••• •••• ${tail}`;
}

/** Groups a revealed number for readability, matching the printed layout. */
export function formatCardNumber(cardNumber: string): string {
  const n = normalizeCardNumber(cardNumber);
  if (detectNetwork(n) === "AMEX") {
    return [n.slice(0, 4), n.slice(4, 10), n.slice(10)].filter(Boolean).join(" ");
  }
  return (n.match(/.{1,4}/g) ?? []).join(" ");
}

export interface ExpiryParts {
  month: number;
  year: number;
}

/**
 * Validates an expiry and reports whether it has already passed.
 *
 * `now` is injected so tests don't depend on the clock. Expired is returned
 * rather than rejected: a card that expired last month is still worth keeping
 * while you wait for the replacement, and the UI can flag it.
 */
export function parseExpiry(
  month: string | number,
  year: string | number,
  now = new Date()
): { ok: true; parts: ExpiryParts; expired: boolean } | { ok: false; error: string } {
  const m = Number(month);
  const y = Number(year);
  if (!Number.isInteger(m) || m < 1 || m > 12) return { ok: false, error: "Expiry month must be 1–12" };
  if (!Number.isInteger(y)) return { ok: false, error: "Enter a four-digit expiry year" };

  // Four digits only: a two-digit year is ambiguous for a card that could
  // plausibly be 2029 or 1929, and guessing silently is worse than asking.
  if (y < 2000 || y > 2099) return { ok: false, error: "Expiry year must be between 2000 and 2099" };

  // Cards are valid through the END of their expiry month.
  const endOfMonth = new Date(Date.UTC(y, m, 1) - 1);
  return { ok: true, parts: { month: m, year: y }, expired: endOfMonth.getTime() < now.getTime() };
}

/** "09 / 29" — the form printed on the card, for display and copying. */
export function formatExpiry(month: number, year: number): string {
  return `${String(month).padStart(2, "0")} / ${String(year).slice(-2)}`;
}

/** Stored form, unambiguous about the century. */
export function serializeExpiry(month: number, year: number): string {
  return `${String(month).padStart(2, "0")}/${year}`;
}

export function deserializeExpiry(stored: string): ExpiryParts | null {
  const m = /^(\d{2})\/(\d{4})$/.exec(stored.trim());
  if (!m) return null;
  return { month: Number(m[1]), year: Number(m[2]) };
}

/** Amex CVVs are 4 digits, everyone else 3. */
export function isValidCvv(cvv: string, network?: CardNetwork): boolean {
  const v = cvv.trim();
  if (!/^\d+$/.test(v)) return false;
  return network === "AMEX" ? v.length === 4 : v.length === 3;
}
