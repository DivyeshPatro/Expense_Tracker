import Link from "next/link";
import { OpenModalButton } from "@/components/shell/buttons";
import { ModuleHero } from "@/components/shell/module-hero";
import { EmptyState } from "@/components/shell/empty-state";
import { AccountCardActions, ArchivedAccounts } from "./account-actions";
import { friendlyDay } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { parsePeriod } from "@/lib/period";
import { soft } from "@/lib/tx-display";
import { listAccounts, listArchivedAccounts, referencedAccountIds } from "@/server/services/accounts";
import { loadLedgerAggRange } from "@/server/services/ledger";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function AccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const now = new Date();
  const sp = await searchParams;
  const { range, label } = parsePeriod(sp, now);

  const [accounts, rows, archived, referenced] = await Promise.all([
    listAccounts(user.id, range, now),
    loadLedgerAggRange(user.id, range.start, range.end),
    listArchivedAccounts(user.id),
    referencedAccountIds(user.id),
  ]);
  const transfers = rows.filter((r) => r.type === "TRANSFER");
  // #209: the total the screen never showed, plus the by-type split
  const accountsTotal = accounts.reduce((s, a) => s + a.balance, 0);
  const sumType = (...types: string[]) => accounts.filter((a) => types.includes(a.type)).reduce((s, a) => s + a.balance, 0);
  const cashTotal = sumType("CASH", "WALLET");
  const bankTotal = sumType("BANK", "INVESTMENT");
  const cardTotal = Math.abs(sumType("CREDIT_CARD"));

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      {/* #209: the screen that lists your money never told you how much money
          you have — five cards, no sum, and the user left adding
          ₹52,030 + ₹1,84,210 + ₹2,450 + ₹4,320 − ₹12,450 in their head. */}
      {accounts.length > 0 && (
        <ModuleHero
          eyebrow="Total balance"
          value={`${accountsTotal < 0 ? "−" : ""}${formatPaise(accountsTotal)}`}
          valueColor={accountsTotal < 0 ? "var(--red)" : undefined}
          sub={`across ${accounts.length} account${accounts.length === 1 ? "" : "s"}`}
          secondary={[
            ...(cashTotal !== 0 ? [{ label: "Cash", value: `${cashTotal < 0 ? "−" : ""}${formatPaise(cashTotal)}` }] : []),
            ...(bankTotal !== 0 ? [{ label: "Banks", value: `${bankTotal < 0 ? "−" : ""}${formatPaise(bankTotal)}` }] : []),
            ...(cardTotal !== 0 ? [{ label: "Cards", value: `−${formatPaise(cardTotal)}`, color: "var(--red)" }] : []),
          ]}
        />
      )}

      {accounts.length === 0 && (
        <div className="card px-4 py-1.5">
          <EmptyState
            icon="🏦"
            title="Add your accounts and wallets"
            detail="Track balances across your bank, cash, and UPI wallets so every expense knows where the money came from."
            action={<OpenModalButton type="account" className="btn-primary">Add your first account</OpenModalButton>}
          />
        </div>
      )}

      {/* One row per account, the row itself the tap target into its history. */}
      <ul className="flex flex-col gap-2 list-none p-0 m-0">
        {accounts.map((a) => (
          <li key={a.id} className="relative flex items-center gap-3 p-3 rounded-[14px] bg-card border border-line">
            <Link
              href={`/transactions?account=${a.id}`}
              className="flex items-center gap-3 flex-1 min-w-0 no-underline text-ink min-h-[44px]"
            >
              <span className="w-10 h-10 rounded-[12px] grid place-items-center text-[17px] flex-none" style={{ background: soft(a.color) }}>{a.icon}</span>
              <span className="flex-1 min-w-0">
                <span className="block text-[13.5px] font-bold truncate">{a.name}</span>
                <span className="block text-[11.5px] text-mut2 truncate">
                  {a.typeLabel}
                  {a.type === "CREDIT_CARD" && (a.cardNetwork || a.cardLast4)
                    ? ` · ${a.cardNetwork ?? ""}${a.cardLast4 ? ` •••• ${a.cardLast4}` : ""}`.trimEnd()
                    : ""}
                  {a.periodNet !== 0 && ` · ${label} ${a.periodNet < 0 ? "−" : "+"}${formatPaise(a.periodNet)}`}
                </span>
              </span>
              <span className="text-[15px] font-extrabold tabular-nums flex-none" style={{ color: a.balance < 0 ? "var(--red)" : "var(--ink)" }}>
                {a.balance < 0 ? "−" : ""}{formatPaise(a.balance)}
              </span>
            </Link>
            <AccountCardActions id={a.id} name={a.name} hasHistory={referenced.has(a.id)} />
          </li>
        ))}
      </ul>

      <ArchivedAccounts accounts={archived} />
      <div className="card p-[var(--pad)]">
        <div className="flex justify-between items-baseline mb-2.5">
          <h2 className="text-[13.5px] font-bold m-0">Transfers</h2>
          <div className="text-[11.5px] text-mut2">{label}</div>
        </div>
        {transfers.length === 0 && <div className="text-[12px] text-mut2 py-2">No transfers in this period — move money between accounts with ⇄ Transfer.</div>}
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
