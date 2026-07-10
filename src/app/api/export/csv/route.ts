import { exportTransactionsCsv } from "@/server/services/export";
import { requireUser } from "@/server/session";
import { todayYMD } from "@/lib/dates";

export async function GET() {
  const user = await requireUser();
  const csv = await exportTransactionsCsv(user.id);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ledgerly-transactions-${todayYMD()}.csv"`,
    },
  });
}
