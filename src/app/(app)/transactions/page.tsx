import { queryTransactions } from "@/server/services/ledger";
import { requireUser } from "@/server/session";
import { TransactionsList } from "./tx-list";

export const dynamic = "force-dynamic";

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tab?: string; month?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const type = (params.tab as "EXPENSE" | "INCOME" | "TRANSFER" | undefined) || undefined;
  const initialPage = await queryTransactions(user.id, { type, monthKey: params.month, textQuery: params.q }, 0);

  return (
    <TransactionsList
      initialRows={initialPage.rows}
      initialHasMore={initialPage.hasMore}
      initialQ={params.q ?? ""}
      initialTab={type ?? null}
      initialMonth={params.month ?? null}
    />
  );
}
