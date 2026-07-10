// Daily job (Vercel Cron → 00:30 IST): materialize recurring transactions and
// generated bills. Idempotent — nextRunAt advances atomically with each write.

import { NextResponse } from "next/server";
import { materializeDueRules } from "@/server/services/recurring";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get("authorization");
  if (!secret || header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const created = await materializeDueRules();
  return NextResponse.json({ ok: true, created });
}
