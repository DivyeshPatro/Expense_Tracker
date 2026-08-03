// Excel download for a shared-expense group's statement (v2.0 Group Dashboard).
// GET /api/export/group-statement?group=<id>
import { exportGroupStatementXlsx } from "@/server/services/export";
import { requireUser } from "@/server/session";

export async function GET(req: Request) {
  const user = await requireUser();
  const group = new URL(req.url).searchParams.get("group");
  if (!group) return new Response("Missing group", { status: 400 });

  const result = await exportGroupStatementXlsx(user.id, group);
  if (!result) return new Response("Group not found", { status: 404 });
  const safe = result.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "group";

  return new Response(new Uint8Array(result.buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="ledgerly-group-${safe}.xlsx"`,
    },
  });
}
