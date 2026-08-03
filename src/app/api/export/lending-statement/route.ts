// Excel download for a lending contact's statement (v2.1 Lending 2.0 #58).
// GET /api/export/lending-statement?participant=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD
import { exportContactStatementXlsx } from "@/server/services/export";
import { requireUser } from "@/server/session";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const user = await requireUser();
  const url = new URL(req.url);
  const participant = url.searchParams.get("participant");
  if (!participant) return new Response("Missing participant", { status: 400 });
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const { buffer, name } = await exportContactStatementXlsx(user.id, participant, {
    from: from && YMD_RE.test(from) ? from : undefined,
    to: to && YMD_RE.test(to) ? to : undefined,
  });
  const safe = name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "contact";

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="ledgerly-statement-${safe}.xlsx"`,
    },
  });
}
