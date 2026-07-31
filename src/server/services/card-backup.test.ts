import { describe, expect, it } from "vitest";
import type { CreditCard } from "@prisma/client";
import { cardKey, fromBackupCard, toBackupCard } from "./card-backup";

const bytes = (...n: number[]) => new Uint8Array(n);

function row(over: Partial<CreditCard> = {}): CreditCard {
  return {
    id: "card-1",
    userId: "user-1",
    nickname: "Amazon Card",
    bank: "HDFC Bank",
    network: "VISA",
    last4: "4242",
    color: "#1e3a8a",
    isDefault: true,
    numberCipher: bytes(1, 2, 3, 250),
    numberIv: bytes(9, 8, 7),
    holderCipher: bytes(4, 5),
    holderIv: bytes(6, 7),
    expiryCipher: bytes(10, 11),
    expiryIv: bytes(12, 13),
    cvvCipher: bytes(14, 15),
    cvvIv: bytes(16, 17),
    notesCipher: bytes(18, 19),
    notesIv: bytes(20, 21),
    keyVersion: 1,
    keyFingerprint: "edc6e395a249946d",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-02T00:00:00Z"),
    ...over,
  } as CreditCard;
}

describe("toBackupCard", () => {
  it("base64-encodes the sealed bytes rather than letting JSON stringify them", () => {
    const out = toBackupCard(row());
    // JSON.stringify of a Uint8Array is {"0":1,"1":2,…} — bigger and easy to
    // corrupt downstream. This must be a plain string.
    expect(typeof out.number.cipher).toBe("string");
    expect(out.number.cipher).toBe(Buffer.from([1, 2, 3, 250]).toString("base64"));
  });

  it("carries the key fingerprint so a restore knows which key it needs", () => {
    expect(toBackupCard(row()).keyFingerprint).toBe("edc6e395a249946d");
  });

  it("keeps an absent note absent", () => {
    expect(toBackupCard(row({ notesCipher: null, notesIv: null })).notes).toBeNull();
  });
});

describe("round trip", () => {
  it("returns the exact same bytes it started with", () => {
    const original = row();
    const restored = fromBackupCard(toBackupCard(original));
    expect(restored).not.toBeNull();

    expect(Buffer.from(restored!.numberCipher).equals(Buffer.from(original.numberCipher))).toBe(true);
    expect(Buffer.from(restored!.numberIv).equals(Buffer.from(original.numberIv))).toBe(true);
    expect(Buffer.from(restored!.cvvCipher).equals(Buffer.from(original.cvvCipher))).toBe(true);
    expect(Buffer.from(restored!.notesCipher!).equals(Buffer.from(original.notesCipher!))).toBe(true);
    expect(restored!.keyFingerprint).toBe(original.keyFingerprint);
    expect(restored!.network).toBe("VISA");
  });

  // A backup goes through JSON.stringify/parse on its way to disk and back.
  it("survives a real JSON serialisation", () => {
    const original = row();
    const parsed = JSON.parse(JSON.stringify(toBackupCard(original)));
    const restored = fromBackupCard(parsed);
    expect(Buffer.from(restored!.numberCipher).equals(Buffer.from(original.numberCipher))).toBe(true);
  });
});

describe("fromBackupCard", () => {
  it("rejects entries that aren't objects", () => {
    for (const bad of [null, "x", 3, []]) expect(fromBackupCard(bad)).toBeNull();
  });

  // Partial restore would leave a card you still have to fetch your wallet for,
  // which is worse than one that plainly didn't restore.
  it("rejects a card missing any required sealed field", () => {
    for (const field of ["number", "holder", "expiry", "cvv"]) {
      const entry = toBackupCard(row()) as unknown as Record<string, unknown>;
      delete entry[field];
      expect(fromBackupCard(entry), field).toBeNull();
    }
  });

  it("rejects a card missing its metadata", () => {
    for (const field of ["nickname", "bank", "last4", "keyFingerprint"]) {
      const entry = toBackupCard(row()) as unknown as Record<string, unknown>;
      entry[field] = "";
      expect(fromBackupCard(entry), field).toBeNull();
    }
  });

  it("falls back to OTHER for an unknown network rather than rejecting the card", () => {
    const entry = { ...toBackupCard(row()), network: "SOMETHING_NEW" };
    expect(fromBackupCard(entry)?.network).toBe("OTHER");
  });
});

describe("cardKey", () => {
  it("ignores case and surrounding space so a re-restore matches", () => {
    expect(cardKey(" Amazon Card ", "4242")).toBe(cardKey("amazon card", "4242"));
  });

  it("distinguishes two cards at the same bank by their last four", () => {
    expect(cardKey("Amazon Card", "4242")).not.toBe(cardKey("Amazon Card", "1111"));
  });
});
