// Deterministic settlement engine (no AI, by design — Architecture doc §5).
// Greedy max-debtor → max-creditor; produces at most n−1 transfers.

export interface NetBalance {
  id: string; // participant id, or "me" for the owner
  net: number; // paise: positive ⇒ is owed money, negative ⇒ owes money
}

export interface SettleTransfer {
  fromId: string;
  toId: string;
  amount: number; // paise
}

/**
 * Suggest the minimum set of transfers that zeroes all net balances.
 * Balances must (approximately) sum to zero; any dust below `epsilon` is ignored.
 */
export function minimizeSettlements(balances: NetBalance[], epsilon = 0): SettleTransfer[] {
  const debtors = balances
    .filter((b) => b.net < -epsilon)
    .map((b) => ({ id: b.id, amt: -b.net }))
    .sort((a, b) => b.amt - a.amt);
  const creditors = balances
    .filter((b) => b.net > epsilon)
    .map((b) => ({ id: b.id, amt: b.net }))
    .sort((a, b) => b.amt - a.amt);

  const transfers: SettleTransfer[] = [];
  let di = 0;
  let ci = 0;
  while (di < debtors.length && ci < creditors.length) {
    const d = debtors[di];
    const c = creditors[ci];
    const amount = Math.min(d.amt, c.amt);
    if (amount > epsilon) transfers.push({ fromId: d.id, toId: c.id, amount });
    d.amt -= amount;
    c.amt -= amount;
    if (d.amt <= epsilon) di++;
    if (c.amt <= epsilon) ci++;
  }
  return transfers;
}
