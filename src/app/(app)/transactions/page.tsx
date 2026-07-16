import { prisma } from "@/server/db";
import { queryTransactions } from "@/server/services/ledger";
import { requireUser } from "@/server/session";
import { TransactionsList } from "./tx-list";

export const dynamic = "force-dynamic";

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tab?: string; month?: string; category?: string; batch?: string; p?: string; from?: string; to?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const type = (params.tab as "EXPENSE" | "INCOME" | "TRANSFER" | undefined) || undefined;
  const categoryId = params.category || null;
  const batchId = params.batch || null;
  const period = { p: params.p, from: params.from, to: params.to };
  const [initialPage, category] = await Promise.all([
    queryTransactions(user.id, { type, monthKey: params.month, categoryId, period, textQuery: params.q, importBatchId: batchId }, 0),
    categoryId ? prisma.category.findFirst({ where: { id: categoryId, userId: user.id }, select: { name: true, icon: true } }) : null,
  ]);

  return (
    <TransactionsList
      initialRows={initialPage.rows}
      initialHasMore={initialPage.hasMore}
      initialQ={params.q ?? ""}
      initialTab={type ?? null}
      initialMonth={params.month ?? null}
      initialCategory={categoryId ? { id: categoryId, name: category?.name ?? "Category", icon: category?.icon ?? "📦" } : null}
      initialBatch={batchId}
      period={period}
    />
  );
}
