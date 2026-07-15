import { exportTransactionsXlsx } from "@/server/services/export";
import { requireUser } from "@/server/session";
import { todayYMD } from "@/lib/dates";

export async function GET() {
  const user = await requireUser();
  const buf = await exportTransactionsXlsx(user.id);
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="ledgerly-transactions-${todayYMD()}.xlsx"`,
    },
  });
}
