// Daily job (Vercel Cron → 00:30 IST): materialize recurring transactions and
// generated bills. Idempotent — nextRunAt advances atomically with each write.

import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { materializeDueRules } from "@/server/services/recurring";
import { reconcileAll } from "@/server/services/accounts";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // length mismatch is safe to short-circuit on — the secret's length isn't
  // itself sensitive, only byte-by-byte comparison of equal-length inputs is
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get("authorization");
  if (!secret || !header || !safeEqual(header, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const created = await materializeDueRules();
  const drift = await reconcileAll();
  if (drift.length > 0) {
    console.error("[cron/daily] balance drift detected", drift);
  }
  return NextResponse.json({ ok: true, created, drift });
}
