import { ModuleActivity } from "@/components/shell/module-activity";
import { prisma } from "@/server/db";
import { queryTransactions, txTotals } from "@/server/services/ledger";
import { requireUser } from "@/server/session";
import { TransactionsList } from "./tx-list";

export const dynamic = "force-dynamic";

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tab?: string; month?: string; category?: string; account?: string; batch?: string; p?: string; from?: string; to?: string; tx?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const type = (params.tab as "EXPENSE" | "INCOME" | "TRANSFER" | undefined) || undefined;
  const categoryId = params.category || null;
  const accountId = params.account || null;
  const batchId = params.batch || null;
  const period = { p: params.p, from: params.from, to: params.to };
  const filter = { type, monthKey: params.month, categoryId, accountId, period, textQuery: params.q, importBatchId: batchId };
  const [initialPage, initialTotals, category, account] = await Promise.all([
    queryTransactions(user.id, filter, 0),
    txTotals(user.id, filter),
    categoryId ? prisma.category.findFirst({ where: { id: categoryId, userId: user.id }, select: { name: true, icon: true } }) : null,
    // Deliberately not filtered by isArchived: reaching an archived account's
    // history is the main reason this filter exists.
    accountId ? prisma.account.findFirst({ where: { id: accountId, userId: user.id }, select: { name: true, icon: true } }) : null,
  ]);

  return (
    <div className="flex flex-col gap-3.5">
      <TransactionsList
        initialRows={initialPage.rows}
        initialHasMore={initialPage.hasMore}
        initialTotals={initialTotals}
        initialQ={params.q ?? ""}
        initialTab={type ?? null}
        initialMonth={params.month ?? null}
        initialCategory={categoryId ? { id: categoryId, name: category?.name ?? "Category", icon: category?.icon ?? "📦" } : null}
        initialAccount={accountId ? { id: accountId, name: account?.name ?? "Account", icon: account?.icon ?? "🏦" } : null}
        initialBatch={batchId}
        period={period}
        initialOpenTransactionId={params.tx || null}
      />
      <ModuleActivity entities={["Transaction"]} />
    </div>
  );
}
