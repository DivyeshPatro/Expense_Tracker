// Printable account statement for one lending contact (v2.1 Lending 2.0).
// A clean, branded sheet — opening balance, You Gave / You Got columns with a
// running balance, and the closing balance — scoped to an optional ?from&to
// range. The app shell prints hidden, so window.print() → "Save as PDF"
// produces the shareable statement; Excel + share live in the action bar.
import { friendlyDay, todayYMD } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { contactStatement } from "@/server/services/lending";
import { requireUser } from "@/server/session";
import { StatementActions } from "./statement-actions";

export const dynamic = "force-dynamic";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function StatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ participantId: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const user = await requireUser();
  const { participantId } = await params;
  const sp = await searchParams;
  const from = sp.from && YMD_RE.test(sp.from) ? sp.from : undefined;
  const to = sp.to && YMD_RE.test(sp.to) ? sp.to : undefined;

  const st = await contactStatement(user.id, participantId, { from, to });
  const now = new Date();
  const periodLabel =
    from && to ? `${friendlyDay(from, now)} – ${friendlyDay(to, now)}` : from ? `Since ${friendlyDay(from, now)}` : to ? `Up to ${friendlyDay(to, now)}` : "All time";

  const net = st.closingBalancePaise;
  const netLabel = net > 0 ? "owes you" : net < 0 ? "you owe" : "settled up";
  const netColor = net > 0 ? "var(--green)" : net < 0 ? "var(--red)" : "var(--mut2)";

  const shareText = [
    `Ledgerly statement — ${st.contact.name}`,
    `Period: ${periodLabel}`,
    `You gave: ${formatPaise(st.totalGavePaise)} · You got: ${formatPaise(st.totalGotPaise)}`,
    `Closing balance: ${net < 0 ? "−" : ""}${formatPaise(Math.abs(net))} — ${st.contact.name.split(" ")[0]} ${netLabel}`,
  ].join("\n");

  return (
    <div className="max-w-[760px] mx-auto flex flex-col gap-3.5">
      <StatementActions participantId={participantId} from={from} to={to} today={todayYMD(now)} shareText={shareText} />

      <div className="card p-[clamp(18px,5vw,32px)] print:shadow-none print:border-0" id="statement-sheet">
        {/* Brand + title */}
        <div className="flex items-start justify-between gap-3 pb-4 border-b border-line">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-[10px] grid place-items-center text-white font-extrabold text-[17px]" style={{ background: "linear-gradient(150deg,#2a63f6,#6d3cf5)" }}>₹</div>
            <div>
              <div className="text-[15px] font-extrabold tracking-tight leading-none">Ledgerly</div>
              <div className="text-[11px] text-mut2 mt-0.5">Account statement</div>
            </div>
          </div>
          <div className="text-right text-[11px] text-mut2">
            Generated {friendlyDay(todayYMD(now), now)}
          </div>
        </div>

        {/* Contact + period */}
        <div className="flex flex-wrap justify-between gap-3 py-4">
          <div>
            <div className="text-[10.5px] uppercase tracking-wide font-bold text-mut2">Statement for</div>
            <div className="text-[17px] font-bold">{st.contact.name}</div>
            {st.contact.phone && <div className="text-[12px] text-mut">{st.contact.phone}</div>}
          </div>
          <div className="text-right">
            <div className="text-[10.5px] uppercase tracking-wide font-bold text-mut2">Period</div>
            <div className="text-[13px] font-semibold">{periodLabel}</div>
          </div>
        </div>

        {/* Opening balance */}
        <div className="flex justify-between items-center text-[12.5px] py-2 px-3 rounded-lg" style={{ background: "var(--side)" }}>
          <span className="font-semibold text-mut">Opening balance</span>
          <span className="font-bold tabular-nums">{st.openingBalancePaise < 0 ? "−" : ""}{formatPaise(Math.abs(st.openingBalancePaise))}</span>
        </div>

        {/* Entries table */}
        <div className="overflow-x-auto mt-3">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="text-mut2 text-[10.5px] uppercase tracking-wide">
                <th className="text-left font-bold py-2 pr-2">Date</th>
                <th className="text-left font-bold py-2 pr-2">Details</th>
                <th className="text-right font-bold py-2 px-2" style={{ color: "var(--acc)" }}>You Gave</th>
                <th className="text-right font-bold py-2 px-2" style={{ color: "var(--green)" }}>You Got</th>
                <th className="text-right font-bold py-2 pl-2">Balance</th>
              </tr>
            </thead>
            <tbody>
              {st.entries.length === 0 && (
                <tr><td colSpan={5} className="text-center text-mut2 py-6">No entries in this period.</td></tr>
              )}
              {st.entries.map((e) => (
                <tr key={e.id} className="border-t border-line">
                  <td className="py-2 pr-2 whitespace-nowrap tabular-nums">{friendlyDay(e.occurredAt, now)}</td>
                  <td className="py-2 pr-2 text-mut">{e.reason || (e.kind === "GAVE" ? "You gave" : "You got")}</td>
                  <td className="py-2 px-2 text-right tabular-nums font-semibold" style={{ color: "var(--acc)" }}>{e.kind === "GAVE" ? formatPaise(e.amount) : ""}</td>
                  <td className="py-2 px-2 text-right tabular-nums font-semibold" style={{ color: "var(--green)" }}>{e.kind === "GOT" ? formatPaise(e.amount) : ""}</td>
                  <td className="py-2 pl-2 text-right tabular-nums font-bold">{e.balanceAfterPaise < 0 ? "−" : ""}{formatPaise(Math.abs(e.balanceAfterPaise))}</td>
                </tr>
              ))}
            </tbody>
            {st.entries.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-line2 font-bold">
                  <td className="py-2 pr-2" colSpan={2}>Totals</td>
                  <td className="py-2 px-2 text-right tabular-nums" style={{ color: "var(--acc)" }}>{formatPaise(st.totalGavePaise)}</td>
                  <td className="py-2 px-2 text-right tabular-nums" style={{ color: "var(--green)" }}>{formatPaise(st.totalGotPaise)}</td>
                  <td className="py-2 pl-2"></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {/* Closing balance */}
        <div className="flex justify-between items-center mt-4 pt-3 border-t border-line">
          <span className="text-[13px] font-bold">Closing balance</span>
          <div className="text-right">
            <div className="text-[19px] font-extrabold tabular-nums" style={{ color: netColor }}>{net < 0 ? "−" : ""}{formatPaise(Math.abs(net))}</div>
            <div className="text-[11px] font-semibold" style={{ color: netColor }}>{st.contact.name.split(" ")[0]} {netLabel}</div>
          </div>
        </div>

        <div className="text-[10px] text-mut2 text-center mt-6 pt-3 border-t border-line">
          Generated by Ledgerly · a self-hosted personal finance tracker
        </div>
      </div>
    </div>
  );
}
