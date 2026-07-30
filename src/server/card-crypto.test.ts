import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cardKeyFingerprint, getCardKey, openField, openOptional, sealField, sealOptional } from "./card-crypto";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const original = process.env.CARD_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.CARD_ENCRYPTION_KEY = KEY_A;
});
afterEach(() => {
  if (original === undefined) delete process.env.CARD_ENCRYPTION_KEY;
  else process.env.CARD_ENCRYPTION_KEY = original;
});

describe("getCardKey", () => {
  it("refuses to run without a key rather than inventing one", () => {
    delete process.env.CARD_ENCRYPTION_KEY;
    expect(() => getCardKey()).toThrow(/CARD_ENCRYPTION_KEY is not set/);
  });

  it("rejects keys that are the wrong length or not hex", () => {
    for (const bad of ["", "abc", "z".repeat(64), "a".repeat(63), "a".repeat(65)]) {
      process.env.CARD_ENCRYPTION_KEY = bad;
      expect(() => getCardKey()).toThrow();
    }
  });

  it("accepts 64 hex characters and tolerates surrounding whitespace", () => {
    process.env.CARD_ENCRYPTION_KEY = `  ${KEY_A}\n`;
    expect(getCardKey()).toHaveLength(32);
  });
});

describe("sealField / openField", () => {
  it("round-trips a card number", () => {
    const sealed = sealField("4111111111111111");
    expect(openField(sealed)).toBe("4111111111111111");
  });

  it("never stores the plaintext in the ciphertext", () => {
    const pan = "4111111111111111";
    const sealed = sealField(pan);
    expect(Buffer.from(sealed.cipher).toString("utf8")).not.toContain(pan);
    expect(Buffer.from(sealed.cipher).toString("hex")).not.toContain(Buffer.from(pan).toString("hex"));
  });

  // Reusing an IV under one key breaks GCM catastrophically, so a fresh random
  // IV per call is the single most important property here.
  it("uses a different IV every time, so identical inputs differ", () => {
    const a = sealField("4111111111111111");
    const b = sealField("4111111111111111");
    expect(Buffer.from(a.iv).equals(Buffer.from(b.iv))).toBe(false);
    expect(Buffer.from(a.cipher).equals(Buffer.from(b.cipher))).toBe(false);
    expect(openField(a)).toBe(openField(b));
  });

  // GCM authenticates: this is what stops a tampered row being decrypted into
  // plausible-looking garbage and shown to the user as a card number.
  it("rejects tampered ciphertext instead of returning garbage", () => {
    const sealed = sealField("4111111111111111");
    const tampered = new Uint8Array(sealed.cipher);
    tampered[0] ^= 0xff;
    expect(() => openField({ cipher: tampered, iv: sealed.iv })).toThrow();
  });

  it("rejects a tampered IV", () => {
    const sealed = sealField("4111111111111111");
    const iv = new Uint8Array(sealed.iv);
    iv[0] ^= 0xff;
    expect(() => openField({ cipher: sealed.cipher, iv })).toThrow();
  });

  it("rejects a stripped auth tag", () => {
    const sealed = sealField("4111111111111111");
    const noTag = sealed.cipher.slice(0, sealed.cipher.length - 16);
    expect(() => openField({ cipher: noTag, iv: sealed.iv })).toThrow();
  });

  it("cannot be decrypted with a different key", () => {
    const sealed = sealField("4111111111111111");
    const other = Buffer.from(KEY_B, "hex");
    expect(() => openField(sealed, other)).toThrow();
  });

  it("handles unicode and long notes", () => {
    const notes = "Amazon card — ₹50,000 limit. Renewal ৳ 2029. 日本";
    expect(openField(sealField(notes))).toBe(notes);
  });

  it("handles the shortest realistic secret (a 3-digit CVV)", () => {
    expect(openField(sealField("123"))).toBe("123");
  });
});

describe("sealOptional / openOptional", () => {
  it("keeps absent fields absent rather than encrypting an empty string", () => {
    expect(sealOptional(null)).toBeNull();
    expect(sealOptional(undefined)).toBeNull();
    expect(sealOptional("")).toBeNull();
    expect(sealOptional("   ")).toBeNull();
  });

  it("round-trips a present value and trims it", () => {
    const sealed = sealOptional("  some notes  ");
    expect(sealed).not.toBeNull();
    expect(openOptional(sealed)).toBe("some notes");
  });

  it("returns null for a half-populated pair rather than throwing", () => {
    expect(openOptional(null)).toBeNull();
    expect(openOptional({ cipher: new Uint8Array([1]) })).toBeNull();
    expect(openOptional({ iv: new Uint8Array([1]) })).toBeNull();
  });
});

describe("cardKeyFingerprint", () => {
  it("is stable for a key and differs across keys", () => {
    const a = cardKeyFingerprint(Buffer.from(KEY_A, "hex"));
    const b = cardKeyFingerprint(Buffer.from(KEY_B, "hex"));
    expect(a).toBe(cardKeyFingerprint(Buffer.from(KEY_A, "hex")));
    expect(a).not.toBe(b);
  });

  it("does not leak the key", () => {
    const fp = cardKeyFingerprint(Buffer.from(KEY_A, "hex"));
    expect(fp).toHaveLength(16);
    expect(KEY_A).not.toContain(fp);
  });
});
