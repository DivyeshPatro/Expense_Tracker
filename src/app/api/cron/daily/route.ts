// Daily job (Vercel Cron → 00:30 IST): materialize recurring transactions and
// generated bills. Idempotent — nextRunAt advances atomically with each write.

import { NextResponse } from "next/server";
import { materializeDueRules } from "@/server/services/recurring";
import { reconcileAll } from "@/server/services/accounts";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get("authorization");
  if (!secret || header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const created = await materializeDueRules();
  const drift = await reconcileAll();
  if (drift.length > 0) {
    console.error("[cron/daily] balance drift detected", drift);
  }
  return NextResponse.json({ ok: true, created, drift });
}
