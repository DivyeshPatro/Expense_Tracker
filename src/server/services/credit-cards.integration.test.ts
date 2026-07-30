// Database-backed tests for the Credit Cards module.
//
// The test that matters most is "stores no plaintext anywhere": it reads the
// raw table with SQL, bypassing the service entirely, and asserts the card
// number and CVV appear nowhere in it. Everything else in this module is built
// on that promise holding.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cardKeyFingerprint } from "../card-crypto";
import {
  createCreditCard,
  deleteCreditCard,
  listCreditCards,
  revealCreditCard,
  revealWithPassword,
  setDefaultCreditCard,
  updateCreditCard,
  verifyAccountPassword,
  type CreditCardInput,
} from "./credit-cards";
import { prisma } from "../db";

const EMAIL = "cards-test@ledgerly.app";
let userId: string;

const PAN = "4111111111111111";
const CVV = "123";

function input(over: Partial<CreditCardInput> = {}): CreditCardInput {
  return {
    nickname: "Amazon Card",
    bank: "Axis Bank",
    cardholderName: "DIVYESH PATRO",
    cardNumber: PAN,
    expiryMonth: 9,
    expiryYear: 2029,
    cvv: CVV,
    ...over,
  };
}

describe("credit cards", () => {
  beforeAll(async () => {
    const existing = await prisma.user.findUnique({ where: { email: EMAIL } });
    if (existing) await prisma.user.delete({ where: { id: existing.id } });
    const user = await prisma.user.create({ data: { name: "Cards", email: EMAIL, emailVerified: true } });
    userId = user.id;
  });

  beforeEach(async () => {
    await prisma.creditCard.deleteMany({ where: { userId } });
  });

  it("creates a card and derives network and last4 from the number", async () => {
    await createCreditCard(userId, input());
    const [card] = await listCreditCards(userId);

    expect(card.nickname).toBe("Amazon Card");
    expect(card.bank).toBe("Axis Bank");
    expect(card.network).toBe("VISA");
    expect(card.last4).toBe("1111");
    expect(card.cardholderName).toBe("DIVYESH PATRO");
    expect(card.keyMatches).toBe(true);
  });

  // The whole module rests on this.
  it("stores no plaintext card number or CVV in any column", async () => {
    await createCreditCard(userId, input({ notes: "Primary shopping card" }));

    // Read the raw row with SQL — no service, no decryption.
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "CreditCard" WHERE "userId" = $1`,
      userId
    );
    expect(rows).toHaveLength(1);

    const row = rows[0];
    const dump = Object.entries(row)
      .map(([k, v]) => `${k}=${v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : String(v)}`)
      .join("|");

    // Long, distinctive secrets: a substring search over the whole row is
    // reliable for these.
    expect(dump).not.toContain(PAN);
    expect(dump).not.toContain("DIVYESH PATRO");
    expect(dump).not.toContain("Primary shopping card");

    // A 3-digit CVV is too short to search for across binary ciphertext without
    // occasionally matching by chance, so it gets an exact check instead: it
    // must not appear in any text column, and the sealed value must not be the
    // CVV itself (GCM also appends a 16-byte tag, so lengths can't coincide).
    const textColumns = ["nickname", "bank", "network", "last4", "color", "keyFingerprint"]
      .map((k) => String(row[k] ?? ""))
      .join("|");
    expect(textColumns).not.toContain(CVV);
    expect(Buffer.from(row.cvvCipher as Uint8Array).toString("utf8")).not.toBe(CVV);
    expect((row.cvvCipher as Uint8Array).length).toBeGreaterThan(CVV.length);

    // Metadata is plaintext by design and should still be there.
    expect(dump).toContain("Axis Bank");
    expect(dump).toContain("1111");
  });

  it("keeps the card number out of the list view entirely", async () => {
    await createCreditCard(userId, input());
    const list = await listCreditCards(userId);
    const serialized = JSON.stringify(list);

    expect(serialized).not.toContain(PAN);
    expect(serialized).not.toContain(CVV);
    // Not even the expiry date — only whether it has passed.
    expect(serialized).not.toContain("2029");
    expect(list[0]).toHaveProperty("isExpired", false);
  });

  it("reveals the full details on explicit request", async () => {
    await createCreditCard(userId, input({ notes: "Use for subscriptions" }));
    const [card] = await listCreditCards(userId);

    const revealed = await revealCreditCard(userId, card.id);

    expect(revealed.cardNumber).toBe(PAN);
    expect(revealed.cvv).toBe(CVV);
    expect(revealed.cardholderName).toBe("DIVYESH PATRO");
    expect(revealed.expiryMonth).toBe(9);
    expect(revealed.expiryYear).toBe(2029);
    expect(revealed.notes).toBe("Use for subscriptions");
  });

  it("records an audit row for every reveal", async () => {
    await createCreditCard(userId, input());
    const [card] = await listCreditCards(userId);
    await prisma.auditLog.deleteMany({ where: { userId } });

    await revealCreditCard(userId, card.id);

    const logs = await prisma.auditLog.findMany({ where: { userId, entity: "CreditCard", action: "reveal" } });
    expect(logs).toHaveLength(1);
    // The audit trail must not itself become a plaintext store.
    expect(JSON.stringify(logs[0])).not.toContain(PAN);
  });

  it("treats an absent CVV-less note as absent rather than an empty string", async () => {
    await createCreditCard(userId, input({ notes: null }));
    const [card] = await listCreditCards(userId);
    const revealed = await revealCreditCard(userId, card.id);
    expect(revealed.notes).toBeNull();
  });

  it("re-encrypts with a fresh IV on update", async () => {
    await createCreditCard(userId, input());
    const before = await prisma.creditCard.findFirstOrThrow({ where: { userId } });

    await updateCreditCard(userId, before.id, input({ nickname: "Renamed Card" }));

    const after = await prisma.creditCard.findFirstOrThrow({ where: { id: before.id } });
    expect(after.nickname).toBe("Renamed Card");
    // Same plaintext, but a new IV — so the ciphertext must differ.
    expect(Buffer.from(after.numberIv).equals(Buffer.from(before.numberIv))).toBe(false);
    expect(Buffer.from(after.numberCipher).equals(Buffer.from(before.numberCipher))).toBe(false);
    expect((await revealCreditCard(userId, before.id)).cardNumber).toBe(PAN);
  });

  it("detects each network from the number without being told", async () => {
    const cases: [string, string, string][] = [
      ["5555555555554444", "MASTERCARD", "4444"],
      ["378282246310005", "AMEX", "0005"],
      ["6521123412341234", "RUPAY", "1234"],
      ["36227206271667", "DINERS", "1667"],
    ];
    for (const [number, network, last4] of cases) {
      await prisma.creditCard.deleteMany({ where: { userId } });
      // Amex CVVs are 4 digits; the rest are 3.
      await createCreditCard(userId, input({ cardNumber: number, cvv: network === "AMEX" ? "1234" : "123" }));
      const [card] = await listCreditCards(userId);
      expect(card.network).toBe(network);
      expect(card.last4).toBe(last4);
    }
  });

  it("flags an expired card without exposing its expiry", async () => {
    await createCreditCard(userId, input({ expiryMonth: 1, expiryYear: 2020 }));
    const [card] = await listCreditCards(userId, new Date("2026-07-30T00:00:00Z"));
    expect(card.isExpired).toBe(true);
    expect(JSON.stringify(card)).not.toContain("2020");
  });

  describe("default card", () => {
    it("makes the first card default automatically", async () => {
      await createCreditCard(userId, input({ nickname: "First" }));
      const [card] = await listCreditCards(userId);
      expect(card.isDefault).toBe(true);
    });

    it("keeps exactly one default when another is promoted", async () => {
      await createCreditCard(userId, input({ nickname: "First" }));
      await createCreditCard(userId, input({ nickname: "Second", cardNumber: "5555555555554444" }));
      const second = (await listCreditCards(userId)).find((c) => c.nickname === "Second")!;

      await setDefaultCreditCard(userId, second.id);

      const list = await listCreditCards(userId);
      expect(list.filter((c) => c.isDefault)).toHaveLength(1);
      expect(list.find((c) => c.isDefault)!.nickname).toBe("Second");
    });

    it("promotes the next card when the default is deleted", async () => {
      await createCreditCard(userId, input({ nickname: "First" }));
      await createCreditCard(userId, input({ nickname: "Second", cardNumber: "5555555555554444" }));
      const first = (await listCreditCards(userId)).find((c) => c.nickname === "First")!;
      expect(first.isDefault).toBe(true);

      await deleteCreditCard(userId, first.id);

      const list = await listCreditCards(userId);
      expect(list).toHaveLength(1);
      expect(list[0].isDefault).toBe(true);
    });

    it("leaves no default behind when the last card goes", async () => {
      await createCreditCard(userId, input());
      const [card] = await listCreditCards(userId);
      await deleteCreditCard(userId, card.id);
      expect(await listCreditCards(userId)).toEqual([]);
    });
  });

  describe("key mismatch", () => {
    it("degrades to metadata and refuses to reveal a card sealed by another key", async () => {
      await createCreditCard(userId, input());
      // Simulate a backup restored onto an instance with a different key.
      await prisma.creditCard.updateMany({ where: { userId }, data: { keyFingerprint: "deadbeefdeadbeef" } });

      const [card] = await listCreditCards(userId);
      expect(card.keyMatches).toBe(false);
      expect(card.cardholderName).toBeNull();
      // Metadata still renders, so the card doesn't silently vanish.
      expect(card.last4).toBe("1111");
      expect(card.bank).toBe("Axis Bank");

      await expect(revealCreditCard(userId, card.id)).rejects.toThrow(/different key/);
    });

    it("stamps new cards with the current key fingerprint", async () => {
      await createCreditCard(userId, input());
      const row = await prisma.creditCard.findFirstOrThrow({ where: { userId } });
      expect(row.keyFingerprint).toBe(cardKeyFingerprint());
      expect(row.keyVersion).toBe(1);
    });
  });

  describe("password re-authentication", () => {
    const PASSWORD = "cards-test-password-1";
    let authUserId: string;

    beforeAll(async () => {
      // A real credential row, hashed by better-auth itself — verifying against
      // a hash we produced ourselves would only prove our own helper agrees
      // with itself.
      const email = "cards-reauth@ledgerly.app";
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) await prisma.user.delete({ where: { id: existing.id } });
      process.env.ALLOW_SIGNUP = "true";
      const { auth } = await import("../auth");
      await auth.api.signUpEmail({ body: { name: "Reauth", email, password: PASSWORD } });
      authUserId = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
    });

    beforeEach(async () => {
      await prisma.auditLog.deleteMany({ where: { userId: authUserId } });
      await prisma.creditCard.deleteMany({ where: { userId: authUserId } });
    });

    it("accepts the account password", async () => {
      expect(await verifyAccountPassword(authUserId, PASSWORD)).toBe(true);
    });

    it("rejects a wrong or empty password", async () => {
      expect(await verifyAccountPassword(authUserId, "not-the-password")).toBe(false);
      expect(await verifyAccountPassword(authUserId, "")).toBe(false);
    });

    it("reveals the card when the password is right", async () => {
      await createCreditCard(authUserId, input());
      const [card] = await listCreditCards(authUserId);

      const res = await revealWithPassword(authUserId, card.id, PASSWORD);

      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("expected ok");
      expect(res.card.cardNumber).toBe(PAN);
      expect(res.card.cvv).toBe(CVV);
    });

    it("refuses and returns no card data when the password is wrong", async () => {
      await createCreditCard(authUserId, input());
      const [card] = await listCreditCards(authUserId);

      const res = await revealWithPassword(authUserId, card.id, "wrong-password");

      expect(res).toEqual({ ok: false, reason: "wrong-password" });
      expect(JSON.stringify(res)).not.toContain(PAN);
    });

    it("records a denial so failures are visible in the trail", async () => {
      await createCreditCard(authUserId, input());
      const [card] = await listCreditCards(authUserId);
      await revealWithPassword(authUserId, card.id, "wrong-password");

      const denials = await prisma.auditLog.findMany({
        where: { userId: authUserId, entity: "CreditCard", action: "reveal-denied" },
      });
      expect(denials).toHaveLength(1);
    });

    // A wrong-password reveal is a guess at the account password, so it needs a
    // ceiling — the middleware's path-keyed limiter can't see server actions.
    it("locks out after repeated wrong passwords, even if the password is then correct", async () => {
      await createCreditCard(authUserId, input());
      const [card] = await listCreditCards(authUserId);

      for (let i = 0; i < 5; i++) {
        expect((await revealWithPassword(authUserId, card.id, "wrong-password")).ok).toBe(false);
      }

      const locked = await revealWithPassword(authUserId, card.id, PASSWORD);
      expect(locked).toEqual({ ok: false, reason: "too-many-attempts" });
    });

    it("lets the user back in once the window has passed", async () => {
      await createCreditCard(authUserId, input());
      const [card] = await listCreditCards(authUserId);
      for (let i = 0; i < 5; i++) await revealWithPassword(authUserId, card.id, "wrong-password");

      // 16 minutes later, outside the 15-minute window.
      const later = new Date(Date.now() + 16 * 60 * 1000);
      const res = await revealWithPassword(authUserId, card.id, PASSWORD, later);

      expect(res.ok).toBe(true);
    });

    // Knowing your own password gets you your own cards and nothing else. The
    // ownership check is inside the query, so someone else's card is simply not
    // found — it doesn't reach the point of being decrypted and rejected.
    it("will not reveal another user's card even with the right password", async () => {
      await createCreditCard(userId, input({ nickname: "Not theirs" }));
      const victim = (await listCreditCards(userId))[0];

      await expect(revealWithPassword(authUserId, victim.id, PASSWORD)).rejects.toThrow(/not found/i);

      // And the attempt leaves the victim's card untouched.
      expect((await listCreditCards(userId))[0].nickname).toBe("Not theirs");
    });
  });

  it("will not touch another user's card", async () => {
    const other = await prisma.user.create({ data: { name: "Other", email: "other-cards@ledgerly.app", emailVerified: true } });
    await createCreditCard(other.id, input({ nickname: "Theirs" }));
    const theirs = (await listCreditCards(other.id))[0];

    await expect(revealCreditCard(userId, theirs.id)).rejects.toThrow(/not found/);
    await expect(deleteCreditCard(userId, theirs.id)).rejects.toThrow(/not found/);
    await expect(updateCreditCard(userId, theirs.id, input())).rejects.toThrow(/not found/);
    await expect(setDefaultCreditCard(userId, theirs.id)).rejects.toThrow(/not found/);
    expect(await listCreditCards(userId)).toEqual([]);

    await prisma.user.delete({ where: { id: other.id } });
  });
});
