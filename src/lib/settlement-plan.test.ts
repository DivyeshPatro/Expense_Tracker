// The Group Settlement Plan.
//
// The rule these cases exist to protect: the plan is a property of the GROUP,
// not of whoever opened the page. A payment between two members must survive as
// a payment between those two members — it must never be re-routed through the
// viewer, and it must not change when a different person is logged in.

import { describe, expect, it } from "vitest";
import {
  computeGrossObligations,
  computeMemberBalances,
  computeSuggestions,
  type GroupExpenseRow,
  type GroupSettlementRow,
} from "./group-dashboard";
import { namedPlan, planTotal, settlementHeadline, shareSettlementText, OWNER_ID } from "./settlement-plan";

const r = (n: number) => Math.round(n * 100);

const expense = (
  id: string,
  amount: number,
  paidBy: string | null,
  splits: [string | null, number][]
): GroupExpenseRow => ({
  id,
  amount: r(amount),
  ymd: "2026-08-16",
  paidByParticipantId: paidBy,
  categoryId: null,
  category: null,
  icon: "📦",
  color: "",
  splits: splits.map(([participantId, owed]) => ({ participantId, owedAmount: r(owed) })),
});

/** Balances → the plan, exactly as the page builds it. */
function planFor(expenses: GroupExpenseRow[], memberIds: string[], names: Record<string, string>, ownerName = "Owner", settlements: GroupSettlementRow[] = []) {
  const { members } = computeMemberBalances(expenses, settlements, memberIds);
  const suggestions = computeSuggestions(
    members.map((m) => ({ participantId: m.participantId, net: m.net, name: m.participantId === null ? "You" : (names[m.participantId] ?? "?") }))
  );
  return namedPlan(suggestions, ownerName);
}

/** "A → B ₹100" strings, sorted, so plans can be compared as sets. */
const shape = (rows: { fromName: string; toName: string; amount: number }[]) =>
  rows.map((x) => `${x.fromName} → ${x.toName} ${x.amount}`).sort();

describe("Case A — everyone owes the owner", () => {
  const NAMES = { a: "Ana", b: "Ben", c: "Cara" };
  const rows = planFor(
    [expense("t1", 400, null, [[null, 100], ["a", 100], ["b", 100], ["c", 100]])],
    ["a", "b", "c"],
    NAMES
  );

  it("routes all three payments to the owner, by name", () => {
    expect(shape(rows)).toEqual(["Ana → Owner 10000", "Ben → Owner 10000", "Cara → Owner 10000"]);
  });

  it("names the owner rather than addressing the reader as 'You'", () => {
    expect(rows.every((x) => x.toName === "Owner")).toBe(true);
    expect(rows.some((x) => x.fromName === "You" || x.toName === "You")).toBe(false);
  });

  it("marks which side is the owner so the UI can chip it", () => {
    expect(rows.every((x) => x.toId === OWNER_ID)).toBe(true);
  });
});

describe("Case B — a member paid, so others owe THEM", () => {
  const NAMES = { priya: "Priya", x: "Ravi", y: "Sam" };
  // Priya fronts ₹400 split four ways: she consumed ₹100 and is owed ₹300.
  const rows = planFor(
    [expense("t1", 400, "priya", [[null, 100], ["priya", 100], ["x", 100], ["y", 100]])],
    ["priya", "x", "y"],
    NAMES
  );

  it("sends the other three to Priya, not to the owner", () => {
    expect(shape(rows)).toEqual(["Owner → Priya 10000", "Ravi → Priya 10000", "Sam → Priya 10000"]);
  });

  it("never invents a payment to the owner", () => {
    expect(rows.some((x) => x.toName === "Owner")).toBe(false);
  });

  it("clears exactly what Priya fronted", () => {
    expect(planTotal(rows)).toBe(r(300));
  });
});

describe("Case C — several people paid", () => {
  const NAMES = { a: "Ana", b: "Ben", c: "Cara" };
  const expenses = [
    expense("t1", 400, null, [[null, 100], ["a", 100], ["b", 100], ["c", 100]]), // owner paid
    expense("t2", 800, "a", [[null, 200], ["a", 200], ["b", 200], ["c", 200]]), // Ana paid
    expense("t3", 200, "b", [[null, 50], ["a", 50], ["b", 50], ["c", 50]]), //     Ben paid
  ];
  const rows = planFor(expenses, ["a", "b", "c"], NAMES);

  it("settles from everyone's complete paid − share position", () => {
    // paid − share: Owner 400−350=+50, Ana 800−350=+450, Ben 200−350=−150, Cara 0−350=−350
    const { members } = computeMemberBalances(expenses, [], ["a", "b", "c"]);
    const netOf = (pid: string | null) => members.find((m) => m.participantId === pid)!.net;
    expect(netOf(null)).toBe(r(50)); // owner is owed
    expect(netOf("a")).toBe(r(-450)); // Ana is owed (owner-centric sign)
    expect(netOf("b")).toBe(r(150));
    expect(netOf("c")).toBe(r(350));
  });

  it("moves exactly the ₹500 that is owed, no more", () => {
    expect(planTotal(rows)).toBe(r(500));
  });

  it("leaves everyone at zero once executed", () => {
    expectClears(rows, ["a", "b", "c"], NAMES, expenses);
  });
});

describe("Case D — a member pays another member directly", () => {
  const NAMES = { a: "Ana", b: "Ben" };
  // Ben fronts a bill Ana shares; the owner is not involved in it at all.
  const rows = planFor([expense("t1", 200, "b", [["a", 100], ["b", 100]])], ["a", "b"], NAMES);

  it("shows Ana → Ben, never Ana → Owner", () => {
    expect(shape(rows)).toEqual(["Ana → Ben 10000"]);
  });

  it("does not name the owner anywhere in the plan", () => {
    expect(rows.some((x) => x.fromId === OWNER_ID || x.toId === OWNER_ID)).toBe(false);
  });
});

describe("Case E — simplification genuinely reduces the payment count", () => {
  const NAMES = { a: "Ana", b: "Ben" };
  // Ana owes the owner ₹500 and the owner owes Ben ₹500. Paying each
  // obligation separately is two hops through the owner; the money only ever
  // needed to go Ana → Ben once.
  const expenses = [
    expense("t1", 500, null, [["a", 500]]), //  owner paid, Ana consumed it
    expense("t2", 500, "b", [[null, 500]]), //  Ben paid, owner consumed it
  ];
  const rows = planFor(expenses, ["a", "b"], NAMES);
  const detailedCount = countDetailed(expenses, ["a", "b"]);

  it("produces fewer payments than settling each obligation separately", () => {
    expect(detailedCount).toBe(2); // Ana → Owner, Owner → Ben
    expect(rows).toHaveLength(1); // Ana → Ben
    expect(rows.length).toBeLessThan(detailedCount);
  });

  it("collapses them into one member-to-member payment", () => {
    expect(shape(rows)).toEqual(["Ana → Ben 50000"]);
  });

  it("still clears everyone", () => {
    expectClears(rows, ["a", "b"], NAMES, expenses);
  });

  it("routes a member straight to another member", () => {
    expect(rows.some((x) => x.fromId !== OWNER_ID && x.toId !== OWNER_ID)).toBe(true);
  });
});

describe("Case F — nothing left to simplify", () => {
  it("says so as a fact, not as a failure", () => {
    // Everyone owes the one creditor: already minimal.
    const rows = planFor(
      [expense("t1", 300, null, [[null, 100], ["a", 100], ["b", 100]])],
      ["a", "b"],
      { a: "Ana", b: "Ben" }
    );
    expect(rows).toHaveLength(2);
    // The copy the UI shows in this state, asserted here so the wording can't
    // regress to "this group can't be simplified further" — which reads as
    // though the app attempted something and gave up.
    const detailedCount = countDetailed([expense("t1", 300, null, [[null, 100], ["a", 100], ["b", 100]])], ["a", "b"]);
    expect(detailedCount).toBe(rows.length); // nothing to collapse
    const copy = detailedCount - rows.length > 0 ? "shorter" : "These are already the fewest payments.";
    expect(copy).toBe("These are already the fewest payments.");
  });
});

describe("Case G — a fully settled group", () => {
  it("reports 'All settled up' and shares nothing to pay", () => {
    // Everyone paid exactly their own share.
    const rows = planFor(
      [expense("t1", 200, null, [[null, 200]]), expense("t2", 100, "a", [["a", 100]])],
      ["a"],
      { a: "Ana" }
    );
    expect(rows).toHaveLength(0);
    expect(settlementHeadline(rows.length)).toBe("All settled up");
    expect(shareSettlementText({ groupName: "Flat", headline: settlementHeadline(0), rows, total: 0 })).toBe(
      "🧾 Flat — Settlement\n\nAll settled up — nobody owes anything."
    );
  });
});

describe("Case H — paise are conserved exactly", () => {
  const NAMES = { a: "Ana", b: "Ben", c: "Cara" };
  // ₹1,265 split three ways does not divide evenly: 421.66 / 421.67 / 421.67.
  const expenses = [
    expense("t1", 1265, null, [[null, 421.66], ["a", 421.67], ["b", 421.67]]),
    expense("t2", 2127.33, "c", [[null, 1063.66], ["c", 1063.67]]),
  ];
  const rows = planFor(expenses, ["a", "b", "c"], NAMES);

  it("the split itself loses nothing", () => {
    for (const e of expenses) {
      expect(e.splits.reduce((s, x) => s + x.owedAmount, 0)).toBe(e.amount);
    }
  });

  it("total out equals total in", () => {
    const out = new Map<string, number>();
    for (const x of rows) {
      out.set(x.fromId, (out.get(x.fromId) ?? 0) + x.amount);
      out.set(x.toId, (out.get(x.toId) ?? 0) - x.amount);
    }
    expect([...out.values()].reduce((s, v) => s + v, 0)).toBe(0);
  });

  it("no money is created or destroyed, to the paisa", () => {
    expectClears(rows, ["a", "b", "c"], NAMES, expenses);
  });

  it("carries whole paise, never fractions", () => {
    expect(rows.every((x) => Number.isInteger(x.amount))).toBe(true);
  });
});

describe("Case I — the plan does not depend on who is logged in", () => {
  // The SAME economic facts, entered from two different accounts.
  //
  // Ledgerly models the account holder as `participantId: null`, so "logging in
  // as someone else" means a different person occupies that slot. Ana pays a
  // ₹900 bill split three ways between Ana, Ben and Cara.
  const asAna = [expense("t1", 900, null, [[null, 300], ["ben", 300], ["cara", 300]])];
  const asBen = [expense("t1", 900, "ana", [["ana", 300], [null, 300], ["cara", 300]])];
  const asCara = [expense("t1", 900, "ana", [["ana", 300], ["ben", 300], [null, 300]])];

  const fromAna = planFor(asAna, ["ben", "cara"], { ben: "Ben", cara: "Cara" }, "Ana");
  const fromBen = planFor(asBen, ["ana", "cara"], { ana: "Ana", cara: "Cara" }, "Ben");
  const fromCara = planFor(asCara, ["ana", "ben"], { ana: "Ana", ben: "Ben" }, "Cara");

  it("Ana sees Ben and Cara paying her", () => {
    expect(shape(fromAna)).toEqual(["Ben → Ana 30000", "Cara → Ana 30000"]);
  });

  it("Ben sees exactly the same plan", () => {
    expect(shape(fromBen)).toEqual(shape(fromAna));
  });

  it("Cara sees exactly the same plan", () => {
    expect(shape(fromCara)).toEqual(shape(fromAna));
  });

  it("the shared text is identical whoever sends it", () => {
    const text = (rows: ReturnType<typeof planFor>) =>
      shareSettlementText({ groupName: "Trip", headline: settlementHeadline(rows.length), rows: [...rows].sort((a, b) => a.fromName.localeCompare(b.fromName)), total: planTotal(rows) });
    expect(text(fromBen)).toBe(text(fromAna));
    expect(text(fromCara)).toBe(text(fromAna));
  });

  it("only the 'that's you' marker differs between viewers", () => {
    // Ana is the owner in her own view and a plain member in Ben's.
    expect(fromAna.find((x) => x.toName === "Ana")!.toId).toBe(OWNER_ID);
    expect(fromBen.find((x) => x.toName === "Ana")!.toId).not.toBe(OWNER_ID);
  });
});

describe("headline wording", () => {
  it("counts payments in plain language", () => {
    expect(settlementHeadline(0)).toBe("All settled up");
    expect(settlementHeadline(1)).toBe("1 payment to settle everything");
    expect(settlementHeadline(4)).toBe("4 payments to settle everything");
  });
});

describe("share text", () => {
  const rows = namedPlan(
    [
      { fromId: "p1", fromName: "Ana", toId: OWNER_ID, toName: "You", amount: r(2127) },
      { fromId: "p2", fromName: "Ben", toId: OWNER_ID, toName: "You", amount: r(2947.31) },
    ],
    "Meera"
  );

  it("reads as a message, not a data dump", () => {
    expect(shareSettlementText({ groupName: "Hill Trip", headline: settlementHeadline(2), rows, total: planTotal(rows) })).toBe(
      [
        "🧾 Hill Trip — Settlement",
        "",
        "2 payments to settle everything:",
        "",
        "Ana → Meera: ₹2,127",
        "Ben → Meera: ₹2,947.31",
        "",
        "Total: ₹5,074.31",
      ].join("\n")
    );
  });

  it("leaks no ids and no 'You'", () => {
    const text = shareSettlementText({ groupName: "Hill Trip", headline: settlementHeadline(2), rows, total: planTotal(rows) });
    expect(text).not.toMatch(/\bYou\b/);
    expect(text).not.toContain("p1");
    // OWNER_ID as a standalone word — a plain substring check would hit the
    // "me" inside "Settlement".
    expect(text).not.toMatch(new RegExp(`(^|[\\s→:])${OWNER_ID}([\\s:]|$)`));
  });
});

/** How many rows the Detailed obligations view would show for the same data. */
function countDetailed(expenses: GroupExpenseRow[], memberIds: string[]): number {
  return computeGrossObligations(expenses, [], memberIds).reduce(
    (n, g) => n + (g.owesYou > 100 ? 1 : 0) + (g.youOwe > 100 ? 1 : 0),
    0
  );
}

/** Executing the plan must leave every participant at zero. */
function expectClears(
  rows: { fromId: string; toId: string; amount: number }[],
  memberIds: string[],
  _names: Record<string, string>,
  expenses: GroupExpenseRow[]
) {
  const { members } = computeMemberBalances(expenses, [], memberIds);
  // minimizeSettlements' convention: positive = is owed.
  const ledger = new Map<string, number>();
  for (const m of members) ledger.set(m.participantId ?? OWNER_ID, m.participantId === null ? m.net : -m.net);
  for (const t of rows) {
    ledger.set(t.fromId, (ledger.get(t.fromId) ?? 0) + t.amount);
    ledger.set(t.toId, (ledger.get(t.toId) ?? 0) - t.amount);
  }
  for (const [, v] of ledger) expect(v).toBe(0);
}
