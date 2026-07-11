import { loadLedger } from "@/server/services/ledger";
import { requireUser } from "@/server/session";
import { TransactionsList, type TxListRow } from "./tx-list";

export const dynamic = "force-dynamic";

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tab?: string; month?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  // full history, unbounded — this is the "see everything" screen (imports can span years)
  const rows = await loadLedger(user.id, null);

  const listRows: TxListRow[] = rows.map((r) => ({
    id: r.id,
    type: r.type,
    amount: r.amount,
    accountName: r.accountName,
    toAccountName: r.toAccountName,
    category: r.category,
    icon: r.icon,
    color: r.color,
    merchant: r.merchant,
    ymd: r.ymd,
    notes: r.notes,
    isRecurring: r.isRecurring,
    hasReceipt: r.hasReceipt,
    split: r.split,
  }));

  return (
    <TransactionsList
      rows={listRows}
      initialQ={params.q ?? ""}
      initialTab={(params.tab as TxListRow["type"]) ?? null}
      initialMonth={params.month ?? null}
    />
  );
}
