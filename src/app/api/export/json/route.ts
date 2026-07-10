import { exportFullJson } from "@/server/services/export";
import { requireUser } from "@/server/session";
import { todayYMD } from "@/lib/dates";

export async function GET() {
  const user = await requireUser();
  const data = await exportFullJson(user.id);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="ledgerly-export-${todayYMD()}.json"`,
    },
  });
}
