"use client";

// Rename / remove for an active account, and the archived list with restore.
//
// "Remove" is one button with two outcomes — the server decides whether the
// account can be deleted outright or has to be archived, because only it can see
// everything still pointing at the account. The confirmation says which will
// happen so the outcome is never a surprise.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { removeAccountAction, renameAccountAction, unarchiveAccountAction } from "@/app/actions";
import { useUI } from "@/components/shell/ui-context";
import { formatPaise } from "@/lib/money";
import type { ArchivedAccountView } from "@/server/services/accounts";

function useAction() {
  const { showToast } = useUI();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, fallback: string) {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    showToast(res.ok ? res.message ?? fallback : res.error ?? "Something went wrong");
    if (res.ok) router.refresh();
    return res.ok;
  }

  return { busy, run };
}

export function AccountCardActions({ id, name, hasHistory }: { id: string; name: string; hasHistory: boolean }) {
  const { busy, run } = useAction();
  const [mode, setMode] = useState<"idle" | "rename" | "confirm">("idle");
  const [draft, setDraft] = useState(name);

  if (mode === "rename") {
    return (
      <div className="flex items-center gap-2 mt-2.5 pt-2.5 border-t border-line">
        <input
          className="field !py-1.5 text-[12px]"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={`Rename ${name}`}
          autoFocus
        />
        <SmallButton
          disabled={busy}
          onClick={async () => {
            if (await run(() => renameAccountAction(id, draft), "Account renamed")) setMode("idle");
          }}
        >
          Save
        </SmallButton>
        <SmallButton onClick={() => { setDraft(name); setMode("idle"); }}>Cancel</SmallButton>
      </div>
    );
  }

  if (mode === "confirm") {
    return (
      <div className="mt-2.5 pt-2.5 border-t border-line flex flex-col gap-2">
        <div className="text-[11.5px] text-mut2">
          {hasHistory
            ? "This account has financial history, so it will be archived — hidden from pickers, with its transactions and balance kept. You can restore it any time."
            : "Nothing references this account, so it will be permanently deleted."}
        </div>
        <div className="flex gap-2">
          <SmallButton
            disabled={busy}
            tone="danger"
            onClick={async () => {
              if (await run(() => removeAccountAction(id), "Account removed")) setMode("idle");
            }}
          >
            {hasHistory ? "Archive" : "Delete"}
          </SmallButton>
          <SmallButton onClick={() => setMode("idle")}>Cancel</SmallButton>
        </div>
      </div>
    );
  }

  // #209: Rename and Archive used to sit alongside "Transactions →" as three
  // equal buttons on every card — 15 controls across five accounts, with rare
  // admin actions weighted the same as the one people actually use. The row
  // itself now opens transactions; these live behind a ⋯ menu.
  return (
    <details className="relative ml-auto">
      <summary
        aria-label={`More actions for ${name}`}
        className="list-none cursor-pointer w-11 h-11 grid place-items-center rounded-lg text-mut2 hover:bg-accsoft hover:text-ink select-none"
      >
        <span aria-hidden className="text-[16px] leading-none tracking-widest">⋯</span>
      </summary>
      <div
        className="absolute right-0 top-11 z-20 min-w-[150px] rounded-[11px] border border-line2 bg-card p-1 flex flex-col"
        style={{ boxShadow: "var(--shLg)" }}
      >
        <button
          onClick={() => setMode("rename")}
          className="text-left px-3 min-h-[44px] rounded-lg text-[13px] font-semibold text-ink bg-transparent border-none cursor-pointer hover:bg-accsoft"
        >
          Rename
        </button>
        <button
          onClick={() => setMode("confirm")}
          className="text-left px-3 min-h-[44px] rounded-lg text-[13px] font-semibold text-red bg-transparent border-none cursor-pointer hover:bg-redsoft"
        >
          {hasHistory ? "Archive" : "Delete"}
        </button>
      </div>
    </details>
  );
}

export function ArchivedAccounts({ accounts }: { accounts: ArchivedAccountView[] }) {
  const [open, setOpen] = useState(false);
  if (accounts.length === 0) return null;

  return (
    <div className="card p-[var(--pad)]">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex justify-between items-center w-full bg-transparent border-none p-0 cursor-pointer text-left"
      >
        <h2 className="text-[13.5px] font-bold m-0">Archived accounts</h2>
        <span className="text-[11.5px] text-mut2 font-semibold">
          {accounts.length} hidden {open ? "▲" : "▼"}
        </span>
      </button>
      {open && (
        <div className="mt-3 flex flex-col gap-1">
          <div className="text-[11.5px] text-mut2 mb-1">
            Hidden from pickers and lists; their transactions and balances are untouched. Recurring rules funded by an
            archived account stay paused until you resume them in Settings.
          </div>
          {accounts.map((a) => (
            <ArchivedRow key={a.id} account={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function ArchivedRow({ account }: { account: ArchivedAccountView }) {
  const { busy, run } = useAction();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(account.name);

  return (
    <div className="flex items-center gap-3 py-2 border-b border-line last:border-b-0 text-[12.5px]">
      <div className="w-8 h-8 rounded-[10px] grid place-items-center text-[13px] bg-accsoft flex-none">{account.icon}</div>
      <div className="flex-1 min-w-0">
        {renaming ? (
          <input
            className="field !py-1.5 text-[12px]"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={`Rename ${account.name}`}
            autoFocus
          />
        ) : (
          <>
            <div className="font-semibold truncate">{account.name}</div>
            <div className="text-mut2">
              {account.typeLabel} · {formatPaise(account.balance)} ·{" "}
              {account.transactionCount} transaction{account.transactionCount === 1 ? "" : "s"}
            </div>
          </>
        )}
      </div>
      <div className="flex items-center gap-2 flex-none">
        {renaming ? (
          <>
            <SmallButton
              disabled={busy}
              onClick={async () => {
                if (await run(() => renameAccountAction(account.id, draft), "Account renamed")) setRenaming(false);
              }}
            >
              Save
            </SmallButton>
            <SmallButton onClick={() => { setDraft(account.name); setRenaming(false); }}>Cancel</SmallButton>
          </>
        ) : (
          <>
            <Link
              href={`/transactions?account=${account.id}`}
              className="text-[11px] font-semibold text-acc no-underline hover:underline"
            >
              Transactions
            </Link>
            <SmallButton onClick={() => setRenaming(true)}>Rename</SmallButton>
            <SmallButton disabled={busy} onClick={() => run(() => unarchiveAccountAction(account.id), "Account restored")}>
              Restore
            </SmallButton>
          </>
        )}
      </div>
    </div>
  );
}

function SmallButton({
  children,
  onClick,
  disabled,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "danger";
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        tone === "danger"
          ? "px-2.5 py-1.5 rounded-lg border-none bg-red text-white text-[11px] font-semibold cursor-pointer disabled:opacity-60"
          : "px-2.5 py-1.5 rounded-lg border border-line2 text-[11px] font-semibold text-acc cursor-pointer bg-transparent hover:bg-accsoft disabled:opacity-60"
      }
    >
      {children}
    </button>
  );
}
