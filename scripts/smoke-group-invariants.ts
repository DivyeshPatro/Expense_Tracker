// Production-safe smoke check: do the group screens still add up?
//
// READ ONLY. It imports the read model and nothing that writes — no fixtures,
// no seeding, no settlements, no cleanup. Safe to point at production, which is
// the reason it exists: the three-viewer suite proves the viewer-perspective
// work against local fixtures, and until somebody links their account there is
// no member view in production to test. What CAN be checked from the owner's
// own seat is that the arithmetic still reconciles, on every group, every time.
//
// This is a deliberate exception to the db-local guard, in the same spirit as
// `prisma migrate deploy`: it targets whatever DATABASE_URL says, and refuses
// to touch a non-local one without an explicit flag so it can never run against
// production by accident.
//
//   npm run smoke:groups                      → local
//   npm run smoke:groups -- --production      → whatever .env points at
//   npm run smoke:groups -- --email a@b.com   → pick the account
//
// Exits non-zero if any invariant breaks, so it can gate a deploy.

import { parsePeriod } from "@/lib/period";
import { OWNER_SENTINEL, SETTLED_THRESHOLD } from "@/lib/group-dashboard";
import { groupDashboard, listGroupSummaries } from "../src/server/services/group-dashboard";
import { prisma } from "../src/server/db";

const ALL = parsePeriod({ p: "all" });
const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : (argv[i + 1] ?? "");
};
const allowRemote = argv.includes("--production");

const rupees = (paise: number) => `${paise < 0 ? "−" : ""}₹${(Math.abs(paise) / 100).toFixed(2)}`;
const isLocal = (url: string) => /@(127\.0\.0\.1|localhost|host\.docker\.internal|\[::1\])[:/]/.test(url);
const redact = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "(default)"}${u.pathname}`;
  } catch {
    return "(unparseable)";
  }
};

const failures: string[] = [];
const check = (group: string, name: string, ok: boolean, detail: string) => {
  if (!ok) failures.push(`${group} · ${name} — ${detail}`);
  return ok;
};

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL is not set — nothing to check.");
  if (!isLocal(url) && !allowRemote) {
    console.error(`✗ Refusing to run against ${redact(url)} without --production.`);
    console.error("  This check only reads, but pointing it at production should be a decision, not a default.");
    process.exit(1);
  }
  console.log(`→ reading ${redact(url)}${isLocal(url) ? "" : "  (PRODUCTION — read only)"}\n`);

  const email = flag("email");
  const user = email
    ? await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true, email: true } })
    : await (async () => {
        const all = await prisma.user.findMany({ select: { id: true, email: true }, take: 2 });
        if (all.length === 0) throw new Error("No accounts found.");
        if (all.length > 1) throw new Error("Several accounts — pass --email to choose one.");
        return all[0];
      })();
  console.log(`   account: ${user.email}\n`);

  const groups = await listGroupSummaries(user.id);
  if (groups.length === 0) {
    console.log("   no groups — nothing to check.");
    return;
  }

  for (const summary of groups) {
    const g = await groupDashboard(user.id, summary.id, ALL);
    if (!g) {
      failures.push(`${summary.name} — listed but not readable`);
      continue;
    }
    const label = g.name;
    const me = g.viewerParticipantId ?? OWNER_SENTINEL;

    // The viewer's own two sides, exactly as the settlement section derives
    // them: a filter over the group-wide obligations, never a recalculation.
    const sum = (rows: typeof g.detailed) => rows.reduce((s, o) => s + o.amount, 0);
    const receive = sum(g.detailed.filter((o) => o.toId === me && o.amount > SETTLED_THRESHOLD));
    const pay = sum(g.detailed.filter((o) => o.fromId === me && o.amount > SETTLED_THRESHOLD));

    // Members are stored as "owes the group"; their sum is the owner's own
    // standing with the sign already the right way round.
    const memberSum = g.members.filter((m) => m.participantId !== null).reduce((s, m) => s + m.net, 0);

    const results = [
      check(label, "receive − pay = net", receive - pay === g.youNet, `${rupees(receive)} − ${rupees(pay)} ≠ ${rupees(g.youNet)}`),
      check(label, "owed − owe = net", g.youAreOwed - g.youOwe === g.youNet, `${rupees(g.youAreOwed)} − ${rupees(g.youOwe)} ≠ ${rupees(g.youNet)}`),
      check(label, "member balances sum to your net", memberSum === g.youNet, `${rupees(memberSum)} ≠ ${rupees(g.youNet)}`),
      check(label, "every plan row is actionable or explained", g.suggestions.every((s) => !g.canRecordSettlements || s.settle || s.settleMembers), "a plan row has no way to record it"),
      // P1-2: settled asks whether any PERSON is outside the threshold, not
      // whether the two sums cancel — a group where one member owes ₹600 and
      // another is owed ₹600 nets to zero and is emphatically not settled.
      check(
        label,
        "settled means nobody is outstanding",
        summary.settled === g.members.every((m) => m.participantId === null || Math.abs(m.net) <= SETTLED_THRESHOLD),
        `flag says ${summary.settled}, rows say otherwise`
      ),
    ];

    const ok = results.every(Boolean);
    console.log(
      `   ${ok ? "✓" : "✗"} ${label.padEnd(18)} receive ${rupees(receive).padStart(12)}  pay ${rupees(pay).padStart(12)}  net ${rupees(g.youNet).padStart(12)}  ` +
        `${summary.settled ? "settled" : `${g.suggestions.length} payment${g.suggestions.length === 1 ? "" : "s"} to settle`}`
    );
  }
}

main()
  .catch((e) => {
    failures.push(`fatal — ${e instanceof Error ? e.message : String(e)}`);
  })
  .finally(async () => {
    await prisma.$disconnect();
    console.log("");
    if (failures.length) {
      console.error(`✗ ${failures.length} invariant${failures.length === 1 ? "" : "s"} broken:`);
      for (const f of failures) console.error(`   ${f}`);
      process.exit(1);
    }
    console.log("✓ every group reconciles");
  });
