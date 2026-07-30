// Encryption for stored card details (Phase 3.1).
//
// AES-256-GCM via Node's built-in crypto — a standard, audited, authenticated
// cipher. Nothing here is bespoke: no custom construction, no hand-rolled
// padding, no home-made KDF. GCM is chosen over CBC specifically because it
// authenticates: a tampered ciphertext fails to decrypt instead of silently
// producing garbage that might be shown to the user as a card number.
//
// Threat model, stated plainly so nobody mistakes what this buys:
//   Defends  — database dumps, Supabase snapshots, a leaked SQL export, an
//              injection that reads rows. The realistic exposures for a
//              self-hosted app, and what "never store in plain text" means.
//   Does not — an attacker with the server environment can read
//              CARD_ENCRYPTION_KEY and decrypt. Server compromise is game over
//              by design; that is the accepted tradeoff of server-side keys.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
/** 96 bits — the size GCM is specified for; longer IVs get re-hashed internally. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

export const CARD_KEY_VERSION = 1;

/**
 * Ciphertext with its GCM auth tag appended, plus the IV that produced it.
 * Stored as two columns per field so a fresh IV is structurally guaranteed —
 * reusing an IV under the same key breaks GCM catastrophically.
 */
export interface SealedField {
  // Uint8Array, not Buffer: Prisma maps `Bytes` columns to Uint8Array, and
  // Buffer is a subclass, so this type flows both into and out of the database
  // without conversion at every call site.
  cipher: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
}

let cachedKey: Buffer | null = null;
let cachedKeySource: string | null = null;

/**
 * Reads and validates CARD_ENCRYPTION_KEY: 64 hex characters (32 bytes).
 *
 * Deliberately throws rather than falling back to a derived or default key. A
 * silent fallback would mean cards encrypted under a key nobody recorded, which
 * is indistinguishable from data loss the first time the process restarts.
 */
export function getCardKey(): Buffer {
  const raw = process.env.CARD_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "CARD_ENCRYPTION_KEY is not set — the Credit Cards module cannot encrypt or decrypt without it. Generate one with: openssl rand -hex 32"
    );
  }
  if (cachedKey && cachedKeySource === raw) return cachedKey;

  if (!/^[0-9a-fA-F]{64}$/.test(raw.trim())) {
    throw new Error("CARD_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32");
  }
  const key = Buffer.from(raw.trim(), "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(`CARD_ENCRYPTION_KEY decoded to ${key.length} bytes, expected ${KEY_BYTES}`);
  }
  cachedKey = key;
  cachedKeySource = raw;
  return key;
}

/**
 * A short, non-secret fingerprint of the active key.
 *
 * Stored alongside each card so a backup restored onto an instance with a
 * different key reports "encrypted with a different key" instead of failing
 * decryption with an opaque error. Truncated SHA-256 of the key bytes — a
 * one-way digest, and 8 bytes is far too little to attack the key with.
 */
export function cardKeyFingerprint(key: Buffer = getCardKey()): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** Encrypts one field. A fresh random IV per call — never derived, never reused. */
export function sealField(plaintext: string, key: Buffer = getCardKey()): SealedField {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  // Tag appended rather than stored separately: it belongs to this ciphertext
  // and splitting them across columns invites pairing the wrong two.
  // Copied into plain Uint8Arrays so the type matches Prisma's Bytes columns
  // exactly (Buffer.concat yields ArrayBufferLike, which Prisma rejects).
  return {
    cipher: new Uint8Array(Buffer.concat([body, cipher.getAuthTag()])),
    iv: new Uint8Array(iv),
  };
}

/**
 * Decrypts one field. Throws if the ciphertext or IV has been altered — GCM's
 * tag check is what makes that detectable rather than silent.
 */
export function openField(sealed: SealedField, key: Buffer = getCardKey()): string {
  if (sealed.cipher.length < TAG_BYTES + 1) {
    throw new Error("Ciphertext is too short to contain an auth tag");
  }
  const stored = Buffer.from(sealed.cipher);
  const body = stored.subarray(0, stored.length - TAG_BYTES);
  const tag = stored.subarray(stored.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/** Optional fields: absent stays absent rather than becoming an encrypted "". */
export function sealOptional(plaintext: string | null | undefined, key?: Buffer): SealedField | null {
  const v = plaintext?.trim();
  return v ? sealField(v, key) : null;
}

export function openOptional(sealed: Partial<SealedField> | null | undefined, key?: Buffer): string | null {
  if (!sealed?.cipher || !sealed.iv) return null;
  return openField({ cipher: sealed.cipher, iv: sealed.iv }, key);
}
