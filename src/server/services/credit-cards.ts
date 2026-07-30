// Credit Cards module (Phase 3.1) — storing your own cards so you never have to
// fetch the physical one to pay online.
//
// Entirely separate from Account.cardNetwork/cardLast4/statementDay/dueDay,
// which serve Lending and Card Recovery and are untouched.
//
// The rule that shapes this whole file: secrets are decrypted only when someone
// explicitly asks for them, and only the field they asked for. Listing cards
// never decrypts a card number.

import type { CardNetwork } from "@prisma/client";
import { verifyPassword } from "better-auth/crypto";
import {
  cardKeyFingerprint,
  CARD_KEY_VERSION,
  openField,
  openOptional,
  sealField,
  sealOptional,
} from "../card-crypto";
import {
  deserializeExpiry,
  detectNetwork,
  lastFour,
  parseExpiry,
  serializeExpiry,
} from "@/lib/card-identity";
import { prisma } from "../db";
import { audit } from "./audit";

export interface CreditCardInput {
  nickname: string;
  bank: string;
  cardholderName: string;
  cardNumber: string;
  expiryMonth: number;
  expiryYear: number;
  cvv: string;
  network?: CardNetwork;
  color?: string | null;
  notes?: string | null;
  isDefault?: boolean;
}

/**
 * What the gallery shows. Deliberately contains no card number, no CVV and no
 * expiry date — `isExpired` is computed server-side from the decrypted expiry
 * so the UI can badge an expired card without ever receiving the date.
 */
export interface CreditCardListItem {
  id: string;
  nickname: string;
  bank: string;
  network: CardNetwork;
  last4: string;
  color: string | null;
  isDefault: boolean;
  cardholderName: string | null;
  isExpired: boolean;
  /** False when this row was sealed by a different CARD_ENCRYPTION_KEY. */
  keyMatches: boolean;
}

/** Returned only by an explicit, authenticated reveal. Never rendered into a page. */
export interface RevealedCreditCard {
  cardNumber: string;
  expiryMonth: number;
  expiryYear: number;
  cvv: string;
  cardholderName: string;
  notes: string | null;
}

function sealAll(input: CreditCardInput, network: CardNetwork) {
  const number = sealField(input.cardNumber);
  const holder = sealField(input.cardholderName);
  const expiry = sealField(serializeExpiry(input.expiryMonth, input.expiryYear));
  const cvv = sealField(input.cvv);
  const notes = sealOptional(input.notes);
  return {
    nickname: input.nickname,
    bank: input.bank,
    network,
    last4: lastFour(input.cardNumber),
    color: input.color?.trim() || null,
    numberCipher: number.cipher,
    numberIv: number.iv,
    holderCipher: holder.cipher,
    holderIv: holder.iv,
    expiryCipher: expiry.cipher,
    expiryIv: expiry.iv,
    cvvCipher: cvv.cipher,
    cvvIv: cvv.iv,
    notesCipher: notes?.cipher ?? null,
    notesIv: notes?.iv ?? null,
    keyVersion: CARD_KEY_VERSION,
    keyFingerprint: cardKeyFingerprint(),
  };
}

/**
 * Exactly one default card. Done inside the caller's transaction so there is no
 * window where two cards are both default, or none is.
 */
async function clearOtherDefaults(db: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], userId: string, keepId?: string) {
  await db.creditCard.updateMany({
    where: { userId, isDefault: true, ...(keepId ? { id: { not: keepId } } : {}) },
    data: { isDefault: false },
  });
}

export async function listCreditCards(userId: string, now = new Date()): Promise<CreditCardListItem[]> {
  const rows = await prisma.creditCard.findMany({
    where: { userId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  const fingerprint = cardKeyFingerprint();

  return rows.map((r) => {
    // A row sealed under a different key can't be decrypted, and trying would
    // throw mid-render. Degrade to metadata instead — the plaintext columns are
    // still meaningful, and the UI can explain why the rest is unavailable.
    if (r.keyFingerprint !== fingerprint) {
      return {
        id: r.id,
        nickname: r.nickname,
        bank: r.bank,
        network: r.network,
        last4: r.last4,
        color: r.color,
        isDefault: r.isDefault,
        cardholderName: null,
        isExpired: false,
        keyMatches: false,
      };
    }

    // The expiry is decrypted only to answer "is this card still valid?" — the
    // date itself stays server-side and is not part of this shape.
    const stored = deserializeExpiry(openField({ cipher: r.expiryCipher, iv: r.expiryIv }));
    const expired = stored ? parseExpiry(stored.month, stored.year, now) : null;

    return {
      id: r.id,
      nickname: r.nickname,
      bank: r.bank,
      network: r.network,
      last4: r.last4,
      color: r.color,
      isDefault: r.isDefault,
      cardholderName: openField({ cipher: r.holderCipher, iv: r.holderIv }),
      isExpired: expired?.ok ? expired.expired : false,
      keyMatches: true,
    };
  });
}

export async function createCreditCard(userId: string, input: CreditCardInput): Promise<string> {
  const network = input.network ?? detectNetwork(input.cardNumber);
  const data = sealAll(input, network);

  return prisma.$transaction(async (db) => {
    const isFirst = (await db.creditCard.count({ where: { userId } })) === 0;
    // The first card becomes the default automatically — with one card, having
    // no default is a distinction without a difference.
    const isDefault = input.isDefault ?? isFirst;
    if (isDefault) await clearOtherDefaults(db, userId);

    const card = await db.creditCard.create({ data: { ...data, userId, isDefault } });
    // Audit records metadata only. Writing card details into the audit log would
    // put them back in plaintext in the very place this module encrypts to avoid.
    await audit(db, userId, "create", "CreditCard", card.id, undefined, {
      nickname: card.nickname,
      bank: card.bank,
      network: card.network,
      last4: card.last4,
    });
    return card.id;
  });
}

export async function updateCreditCard(userId: string, id: string, input: CreditCardInput): Promise<void> {
  const before = await prisma.creditCard.findFirst({ where: { id, userId } });
  if (!before) throw new Error("Card not found");

  const network = input.network ?? detectNetwork(input.cardNumber);
  const data = sealAll(input, network);

  await prisma.$transaction(async (db) => {
    const isDefault = input.isDefault ?? before.isDefault;
    if (isDefault) await clearOtherDefaults(db, userId, id);
    await db.creditCard.update({ where: { id }, data: { ...data, isDefault } });
    await audit(
      db,
      userId,
      "update",
      "CreditCard",
      id,
      { nickname: before.nickname, bank: before.bank, network: before.network, last4: before.last4 },
      { nickname: data.nickname, bank: data.bank, network: data.network, last4: data.last4 }
    );
  });
}

export async function deleteCreditCard(userId: string, id: string): Promise<void> {
  const card = await prisma.creditCard.findFirst({ where: { id, userId } });
  if (!card) throw new Error("Card not found");

  await prisma.$transaction(async (db) => {
    await db.creditCard.delete({ where: { id } });
    // Deleting the default promotes the oldest remaining card, so the user is
    // never left with cards but no default.
    if (card.isDefault) {
      const next = await db.creditCard.findFirst({ where: { userId }, orderBy: { createdAt: "asc" } });
      if (next) await db.creditCard.update({ where: { id: next.id }, data: { isDefault: true } });
    }
    await audit(db, userId, "delete", "CreditCard", id, { nickname: card.nickname, bank: card.bank, last4: card.last4 }, undefined);
  });
}

export async function setDefaultCreditCard(userId: string, id: string): Promise<void> {
  const card = await prisma.creditCard.findFirst({ where: { id, userId } });
  if (!card) throw new Error("Card not found");
  await prisma.$transaction(async (db) => {
    await clearOtherDefaults(db, userId, id);
    await db.creditCard.update({ where: { id }, data: { isDefault: true } });
  });
}

/**
 * Confirms the caller knows the account password.
 *
 * A valid session is not enough to reveal card details: a borrowed unlocked
 * laptop is exactly the case this guards, and it is the one place in Ledgerly
 * where a session alone shouldn't be sufficient.
 *
 * Verified against the stored hash with better-auth's own verifyPassword, so
 * this uses the same hashing scheme as sign-in rather than a second opinion
 * about how passwords work. Credential accounts only — providerId "credential"
 * is the row better-auth writes for email+password.
 */
export async function verifyAccountPassword(userId: string, password: string): Promise<boolean> {
  if (!password) return false;
  const credential = await prisma.authAccount.findFirst({
    where: { userId, providerId: "credential" },
    select: { password: true },
  });
  if (!credential?.password) return false;
  return verifyPassword({ hash: credential.password, password });
}

/**
 * A wrong-password reveal is a guess at the account password with the card
 * details as the prize, so it needs a limit. The middleware's rate limiter is
 * keyed by request path and every server action shares one, so it can't help
 * here — this counts recent failures from the audit log instead, which is
 * already the durable record of what happened and needs no new storage.
 */
const MAX_FAILED_REVEALS = 5;
const FAILED_REVEAL_WINDOW_MS = 15 * 60 * 1000;

export type RevealDenial = "wrong-password" | "too-many-attempts";

export async function revealWithPassword(
  userId: string,
  cardId: string,
  password: string,
  now = new Date()
): Promise<{ ok: true; card: RevealedCreditCard } | { ok: false; reason: RevealDenial }> {
  const since = new Date(now.getTime() - FAILED_REVEAL_WINDOW_MS);
  const recentFailures = await prisma.auditLog.count({
    where: { userId, entity: "CreditCard", action: "reveal-denied", at: { gte: since } },
  });
  if (recentFailures >= MAX_FAILED_REVEALS) return { ok: false, reason: "too-many-attempts" };

  if (!(await verifyAccountPassword(userId, password))) {
    // Recorded so the count above means something, and so a run of failures is
    // visible in the activity trail rather than invisible.
    await audit(prisma, userId, "reveal-denied", "CreditCard", cardId, undefined, { reason: "wrong-password" });
    return { ok: false, reason: "wrong-password" };
  }

  return { ok: true, card: await revealCreditCard(userId, cardId) };
}

/**
 * Decrypts a card's secrets.
 *
 * Callers must have confirmed the password first — revealCreditCardAction does
 * exactly that. Every call is audited, because a reveal is the moment card
 * details leave the database, and that is worth a record.
 */
export async function revealCreditCard(userId: string, id: string): Promise<RevealedCreditCard> {
  const card = await prisma.creditCard.findFirst({ where: { id, userId } });
  if (!card) throw new Error("Card not found");

  if (card.keyFingerprint !== cardKeyFingerprint()) {
    throw new Error("This card was encrypted with a different key and can't be read on this instance");
  }

  const expiry = deserializeExpiry(openField({ cipher: card.expiryCipher, iv: card.expiryIv }));
  if (!expiry) throw new Error("Stored expiry is unreadable");

  await audit(prisma, userId, "reveal", "CreditCard", id, undefined, { last4: card.last4, nickname: card.nickname });

  return {
    cardNumber: openField({ cipher: card.numberCipher, iv: card.numberIv }),
    expiryMonth: expiry.month,
    expiryYear: expiry.year,
    cvv: openField({ cipher: card.cvvCipher, iv: card.cvvIv }),
    cardholderName: openField({ cipher: card.holderCipher, iv: card.holderIv }),
    notes: openOptional({ cipher: card.notesCipher ?? undefined, iv: card.notesIv ?? undefined }),
  };
}
