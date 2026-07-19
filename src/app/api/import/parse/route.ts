// Parses an uploaded CSV/XLS/XLSX file server-side and returns headers + all
// rows + a suggested column mapping. The wizard then holds rows in client
// state and drives preview/commit via server actions (stateless — no
// server-side session cache, so this works the same locally and on Vercel).

import { NextResponse } from "next/server";
import { suggestMapping } from "@/lib/import/detect-columns";
import { parseSpreadsheet } from "@/lib/import/parse-file";
import { requireUser } from "@/server/session";

export const runtime = "nodejs";

export async function POST(req: Request) {
  await requireUser();
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }
  if (file.size > 15 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 15 MB)" }, { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const preset = (form.get("preset") as string | null) ?? undefined;
  let sheet;
  try {
    sheet = await parseSpreadsheet(buffer);
  } catch (e) {
    const message = e instanceof Error && e.message.includes(".xls") ? e.message : "Couldn't read this file — is it a valid CSV or Excel file?";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  if (sheet.rows.length === 0) {
    return NextResponse.json({ error: "No rows found in the file" }, { status: 400 });
  }
  const mapping = suggestMapping(sheet.headers, sheet.rows.slice(0, 20), preset);
  return NextResponse.json({ headers: sheet.headers, rows: sheet.rows, mapping, fileName: file.name, preset });
}
