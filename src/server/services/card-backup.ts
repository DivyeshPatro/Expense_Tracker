// Credit cards in the backup file.
//
// The ciphertext is carried across verbatim. Nothing is decrypted to export it
// and nothing is decrypted to restore it — CARD_ENCRYPTION_KEY is not needed by
// either path, which is the point: a backup is a file that gets copied to
// places you'd rather your card number wasn't, and the only thing in it is the
// same sealed bytes that were in the database.
//
// Each row keeps the fingerprint of the key that sealed it. Restore onto an
// instance with a different key therefore produces cards the gallery shows as
// "encrypted with a different key" rather than rows that fail obscurely on
// first read — the key travels separately, by design, and the backup says
// plainly which one it needs.

import type { CreditCard } from "@prisma/client";

interface SealedPair {
  cipher: string;
  iv: string;
}

export interface BackupCreditCard {
  nickname: string;
  bank: string;
  network: string;
  last4: string;
  color: string | null;
  isDefault: boolean;
  keyVersion: number;
  keyFingerprint: string;
  number: SealedPair;
  holder: SealedPair;
  expiry: SealedPair;
  cvv: SealedPair;
  notes: SealedPair | null;
  createdAt: string;
}

// Base64, not JSON's default treatment of a Uint8Array — which is an object
// with numeric keys ({"0":31,"1":114,…}), several times the size and silently
// lossy if anything downstream normalises it.
const enc = (b: Uint8Array): string => Buffer.from(b).toString("base64");
const dec = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(s, "base64"));

export function toBackupCard(row: CreditCard): BackupCreditCard {
  return {
    nickname: row.nickname,
    bank: row.bank,
    network: row.network,
    last4: row.last4,
    color: row.color,
    isDefault: row.isDefault,
    keyVersion: row.keyVersion,
    keyFingerprint: row.keyFingerprint,
    number: { cipher: enc(row.numberCipher), iv: enc(row.numberIv) },
    holder: { cipher: enc(row.holderCipher), iv: enc(row.holderIv) },
    expiry: { cipher: enc(row.expiryCipher), iv: enc(row.expiryIv) },
    cvv: { cipher: enc(row.cvvCipher), iv: enc(row.cvvIv) },
    notes: row.notesCipher && row.notesIv ? { cipher: enc(row.notesCipher), iv: enc(row.notesIv) } : null,
    createdAt: row.createdAt.toISOString(),
  };
}

const NETWORKS = new Set(["VISA", "MASTERCARD", "RUPAY", "AMEX", "DINERS", "OTHER"]);

function pair(v: unknown): SealedPair | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.cipher !== "string" || typeof o.iv !== "string" || !o.cipher || !o.iv) return null;
  return { cipher: o.cipher, iv: o.iv };
}

/** The row data a restore would write, or null if the entry is unusable. */
export type RestorableCard = Omit<BackupCreditCard, "number" | "holder" | "expiry" | "cvv" | "notes" | "createdAt" | "network"> & {
  network: "VISA" | "MASTERCARD" | "RUPAY" | "AMEX" | "DINERS" | "OTHER";
  numberCipher: Uint8Array<ArrayBuffer>;
  numberIv: Uint8Array<ArrayBuffer>;
  holderCipher: Uint8Array<ArrayBuffer>;
  holderIv: Uint8Array<ArrayBuffer>;
  expiryCipher: Uint8Array<ArrayBuffer>;
  expiryIv: Uint8Array<ArrayBuffer>;
  cvvCipher: Uint8Array<ArrayBuffer>;
  cvvIv: Uint8Array<ArrayBuffer>;
  notesCipher: Uint8Array<ArrayBuffer> | null;
  notesIv: Uint8Array<ArrayBuffer> | null;
};

/**
 * Validates one backup entry into insertable row data.
 *
 * A card missing any of its four required sealed fields is rejected outright
 * rather than restored partially: a card row without a CVV is a card you'd
 * still have to fetch your wallet for, which is worse than one that plainly
 * didn't restore.
 */
export function fromBackupCard(v: unknown): RestorableCard | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;

  const nickname = typeof o.nickname === "string" ? o.nickname.trim() : "";
  const bank = typeof o.bank === "string" ? o.bank.trim() : "";
  const last4 = typeof o.last4 === "string" ? o.last4.trim() : "";
  const keyFingerprint = typeof o.keyFingerprint === "string" ? o.keyFingerprint : "";
  if (!nickname || !bank || !last4 || !keyFingerprint) return null;

  const number = pair(o.number);
  const holder = pair(o.holder);
  const expiry = pair(o.expiry);
  const cvv = pair(o.cvv);
  if (!number || !holder || !expiry || !cvv) return null;
  const notes = pair(o.notes);

  const network = typeof o.network === "string" && NETWORKS.has(o.network) ? o.network : "OTHER";

  return {
    nickname,
    bank,
    network: network as RestorableCard["network"],
    last4,
    color: typeof o.color === "string" ? o.color : null,
    isDefault: o.isDefault === true,
    keyVersion: typeof o.keyVersion === "number" ? o.keyVersion : 1,
    keyFingerprint,
    numberCipher: dec(number.cipher),
    numberIv: dec(number.iv),
    holderCipher: dec(holder.cipher),
    holderIv: dec(holder.iv),
    expiryCipher: dec(expiry.cipher),
    expiryIv: dec(expiry.iv),
    cvvCipher: dec(cvv.cipher),
    cvvIv: dec(cvv.iv),
    notesCipher: notes ? dec(notes.cipher) : null,
    notesIv: notes ? dec(notes.iv) : null,
  };
}

/** Restoring the same backup twice shouldn't leave you with two of each card. */
export function cardKey(nickname: string, last4: string): string {
  return `${nickname.trim().toLowerCase()}|${last4.trim()}`;
}
