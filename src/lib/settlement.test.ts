import { describe, expect, it } from "vitest";
import { minimizeSettlements } from "./settlement";

describe("settlement engine (greedy max-debtor → max-creditor)", () => {
  it("suggests at most n−1 transfers and zeroes every balance", () => {
    const balances = [
      { id: "me", net: 90000 },
      { id: "p1", net: -50000 },
      { id: "p2", net: -30000 },
      { id: "p3", net: -10000 },
    ];
    const transfers = minimizeSettlements(balances);
    expect(transfers.length).toBeLessThanOrEqual(3);
    const nets = new Map(balances.map((b) => [b.id, b.net]));
    for (const t of transfers) {
      nets.set(t.fromId, nets.get(t.fromId)! + t.amount);
      nets.set(t.toId, nets.get(t.toId)! - t.amount);
    }
    for (const v of nets.values()) expect(v).toBe(0);
  });

  it("pairs largest debtor with largest creditor first", () => {
    const transfers = minimizeSettlements([
      { id: "a", net: 70000 },
      { id: "b", net: 30000 },
      { id: "c", net: -60000 },
      { id: "d", net: -40000 },
    ]);
    expect(transfers[0]).toEqual({ fromId: "c", toId: "a", amount: 60000 });
    expect(transfers).toHaveLength(3);
  });

  it("handles already-settled groups", () => {
    expect(minimizeSettlements([{ id: "a", net: 0 }, { id: "b", net: 0 }])).toEqual([]);
  });

  it("ignores paise dust below epsilon", () => {
    expect(minimizeSettlements([{ id: "a", net: 1 }, { id: "b", net: -1 }], 1)).toEqual([]);
  });
});
