// The preview and the stored rows must be the same numbers.
//
// This is the check the whole P2-1 change exists for. The expense form used to
// compute its summary with its own arithmetic and the writer computed the
// stored shares with another, so "Your share: ₹421.69" and the ExpenseSplit
// rows were two independent claims that happened to agree — until a weighted
// split, where the form showed nothing at all about the person carrying double
// and ₹843.33 went to the database unannounced.
//
// Both sides now call computeShares. This asserts that end to end: take what
// the breakdown would render, save through addExpense, and compare every row.
// If the two ever diverge again, this fails.

import { beforeEach, describe, expect, it } from "vitest";
import { computeShares, computeSplitPreview, type SplitInput } from "@/lib/split-shares";
import { addExpense, updateExpense } from "./transactions";
import { prisma } from "../db";

const EMAIL = "split-parity@ledgerly.app";
const rup = (n: number) => Math.round(n * 100);

let userId: string, categoryId: string, accountId: string, groupId: string;
let srikant: string, baldev: string, abhisekh: string, nitya: string;

/** The real trip: ₹2,530, Srikant counting double. */
const srisailam = (payer: string | null = null): SplitInput => ({
  mode: "RATIO",
  participantIds: [srikant, baldev, abhisekh, nitya],
  payerParticipantId: payer,
  weights: { me: 1, [srikant]: 2, [baldev]: 1, [abhisekh]: 1, [nitya]: 1 },
});

/** What the ExpenseSplit rows actually hold, keyed the way the preview keys them. */
async function savedShares(txId: string) {
  const rows = await prisma.expenseSplit.findMany({ where: { txId } });
  return new Map(rows.map((r) => [r.participantId, Number(r.owedAmount)]));
}

async function save(split: SplitInput, amount = rup(2530)) {
  return addExpense(userId, { amount, accountId, categoryId, merchant: "Nawab", date: "2026-08-16", groupId, split });
}

describe("what the breakdown shows is what gets stored", () => {
  beforeEach(async () => {
    const ex = await prisma.user.findUnique({ where: { email: EMAIL } });
    if (ex) await prisma.user.delete({ where: { id: ex.id } });
    userId = (await prisma.user.create({ data: { name: "Owner", email: EMAIL, emailVerified: true } })).id;
    categoryId = (await prisma.category.create({ data: { userId, name: "Food", kind: "EXPENSE", icon: "🍔", color: "#000" } })).id;
    accountId = (await prisma.account.create({ data: { userId, name: "Cash", type: "CASH", openingBalance: 0, icon: "💵", color: "#000" } })).id;
    const mk = async (n: string) => (await prisma.participant.create({ data: { ownerId: userId, displayName: n } })).id;
    srikant = await mk("Srikant");
    baldev = await mk("Baldev");
    abhisekh = await mk("Abhisekh");
    nitya = await mk("Nitya");
    groupId = (
      await prisma.group.create({
        data: {
          name: "Srisailam",
          createdById: userId,
          members: { create: [srikant, baldev, abhisekh, nitya].map((participantId) => ({ participantId })) },
        },
      })
    ).id;
  });

  it("every participant's previewed amount equals their stored amount", async () => {
    const input = srisailam();
    const preview = computeSplitPreview(rup(2530), input);
    const id = await save(input);
    const stored = await savedShares(id);

    expect(preview.rows).toHaveLength(5);
    for (const row of preview.rows) {
      expect(stored.get(row.participantId)).toBe(row.owedAmount);
    }
    expect(stored.size).toBe(preview.rows.length);
  });

  it("the ₹843.33 the old form never showed is exactly what is stored", async () => {
    const preview = computeSplitPreview(rup(2530), srisailam());
    const id = await save(srisailam());
    const stored = await savedShares(id);

    expect(preview.rows.find((r) => r.participantId === srikant)!.owedAmount).toBe(84333);
    expect(stored.get(srikant)).toBe(84333);
    expect(stored.get(null)).toBe(42169); // the payer, carrying the 3 paise
    expect([...stored.values()].reduce((a, b) => a + b, 0)).toBe(rup(2530));
  });

  it("changing the payer moves the remainder in both the preview and the rows", async () => {
    const input = srisailam(srikant);
    const preview = computeSplitPreview(rup(2530), input);
    const id = await save(input);
    const stored = await savedShares(id);

    // the 3 paise follow the payer — engine policy, not a UI choice
    expect(preview.rows.find((r) => r.isPayer)!.participantId).toBe(srikant);
    expect(preview.rows.find((r) => r.participantId === srikant)!.owedAmount).toBe(84336);
    expect(stored.get(srikant)).toBe(84336);
    expect(stored.get(null)).toBe(42166);
    for (const row of preview.rows) expect(stored.get(row.participantId)).toBe(row.owedAmount);
  });

  it("holds for every split mode", async () => {
    const cases: [string, SplitInput, number][] = [
      ["equal, clean", { mode: "EQUAL", participantIds: [srikant, baldev], payerParticipantId: null }, rup(900)],
      ["equal, remainder", { mode: "EQUAL", participantIds: [srikant, baldev], payerParticipantId: null }, rup(10)],
      [
        "exact",
        { mode: "EXACT", participantIds: [srikant, baldev], payerParticipantId: null, exactAmounts: { [srikant]: rup(250), [baldev]: rup(400) } },
        rup(1000),
      ],
      ["percent", { mode: "PERCENT", participantIds: [srikant], payerParticipantId: null, weights: { me: 60, [srikant]: 40 } }, rup(1000)],
      ["ratio", srisailam(), rup(2530)],
    ];

    for (const [name, input, amount] of cases) {
      const preview = computeSplitPreview(amount, input);
      const id = await save(input, amount);
      const stored = await savedShares(id);
      for (const row of preview.rows) {
        expect(stored.get(row.participantId), `${name}: ${row.participantId ?? "you"}`).toBe(row.owedAmount);
      }
      expect([...stored.values()].reduce((a, b) => a + b, 0), `${name}: total`).toBe(amount);
      await prisma.transaction.delete({ where: { id } });
    }
  });

  it("holds after an edit too", async () => {
    const id = await save(srisailam());
    const edited: SplitInput = { ...srisailam(), weights: { me: 1, [srikant]: 3, [baldev]: 1, [abhisekh]: 1, [nitya]: 1 } };
    const preview = computeSplitPreview(rup(2530), edited);
    await updateExpense(userId, id, {
      amount: rup(2530), accountId, categoryId, merchant: "Nawab", date: "2026-08-16", groupId, split: edited,
    });
    const stored = await savedShares(id);
    for (const row of preview.rows) expect(stored.get(row.participantId)).toBe(row.owedAmount);
  });

  it("the preview never invents a number the engine would not store", async () => {
    // Belt and braces: computeShares is the only arithmetic, so a preview row
    // must be reproducible by calling it directly.
    const input = srisailam();
    const preview = computeSplitPreview(rup(2530), input);
    const direct = computeShares(rup(2530), input);
    for (const row of preview.rows) {
      expect(direct.find((s) => s.participantId === row.participantId)!.owedAmount).toBe(row.owedAmount);
    }
  });
});
