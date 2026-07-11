import { OpenModalButton } from "@/components/shell/buttons";
import { friendlyDay } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { parsePeriod } from "@/lib/period";
import { soft } from "@/lib/tx-display";
import { listAccounts } from "@/server/services/accounts";
import { loadLedgerAggRange } from "@/server/services/ledger";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function AccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const now = new Date();
  const sp = await searchParams;
  const { range, label } = parsePeriod(sp, now);

  const [accounts, rows] = await Promise.all([listAccounts(user.id, range, now), loadLedgerAggRange(user.id, range.start, range.end)]);
  const transfers = rows.filter((r) => r.type === "TRANSFER");

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      <div className="flex justify-end gap-2">
        <OpenModalButton type="account" className="px-3.5 py-2 rounded-lg border border-line2 bg-card text-[12.5px] font-semibold text-acc cursor-pointer hover:bg-accsoft">
          ＋ Add account
        </OpenModalButton>
        <OpenModalButton type="tr" className="btn-primary">⇄ Transfer money</OpenModalButton>
      </div>
      <div className="flex flex-wrap gap-3.5">
        {accounts.map((a) => (
          <div key={a.id} className="card flex-[1_1_220px] p-[var(--pad)]">
            <div className="flex items-center gap-2.5">
              <div className="w-[38px] h-[38px] rounded-[11px] grid place-items-center text-[17px]" style={{ background: soft(a.color) }}>{a.icon}</div>
              <div>
                <div className="text-[13px] font-bold">{a.name}</div>
                <div className="text-[11px] text-mut2 font-semibold">{a.typeLabel}</div>
              </div>
            </div>
            <div className="text-[23px] font-extrabold tracking-tight mt-3.5" style={{ color: a.balance < 0 ? "var(--red)" : "var(--ink)" }}>
              {a.balance < 0 ? "−" : ""}{formatPaise(a.balance)}
            </div>
            <div className="text-[11.5px] text-mut2 mt-[5px]">
              {label}: {a.periodNet < 0 ? "−" : "+"}{formatPaise(a.periodNet)}
            </div>
          </div>
        ))}
      </div>
      <div className="card p-[var(--pad)]">
        <div className="flex justify-between items-baseline mb-2.5">
          <h2 className="text-[13.5px] font-bold m-0">Transfers</h2>
          <div className="text-[11.5px] text-mut2">{label}</div>
        </div>
        {transfers.length === 0 && <div className="text-[12.5px] text-mut2 py-2">No transfers in this period — move money between accounts with ⇄ Transfer.</div>}
        {transfers.map((t) => (
          <div key={t.id} className="flex items-center gap-3 py-[9px] border-b border-line last:border-b-0">
            <div className="w-8 h-8 rounded-[10px] grid place-items-center text-[13px] bg-accsoft">⇄</div>
            <div className="flex-1">
              <div className="text-[12.5px] font-semibold">{t.merchant}</div>
              <div className="text-[11px] text-mut2">{friendlyDay(t.ymd)}</div>
            </div>
            <div className="text-[12.5px] font-bold text-mut">{formatPaise(t.amount)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
