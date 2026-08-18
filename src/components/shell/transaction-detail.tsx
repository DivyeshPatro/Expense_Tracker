"use client";

// Tap-to-view/edit for a single transaction. Reuses the same bottom-sheet
// shell as every other modal (rendered by <Modals> for modal.type==="txDetail")
// so mobile gets the existing bottom-sheet visual language for free and
// desktop gets the same centered dialog every other modal already uses.
//
// Default state is read-only; Edit switches the same sheet into a form
// (reusing Field/AmountInput/SubmitButton/SplitEditor — the same building
// blocks the Add Expense/Income/Transfer forms use) pre-filled from the
// transaction. Delete lives here now instead of always-visible on the list
// row, with the same confirm-then-5s-undo pattern the row used to have.
//
// Offline-sync Phase 3 (spec §17): edit/delete of an already-synced solo
// record now flows through the SAME outbox as creates (universal write-behind,
// preserved from Phase 2) — enqueueMutation() enqueues instantly and drains in
// the background instead of awaiting the network. This sheet cross-references
// the outbox by entityId to show the spec §6/§7 status line and Fix/Discard
// actions when this transaction has a queued (not-yet-synced) edit or delete.
// Split expenses stay online-required (Phase 1/2's exact same restriction —
// they touch other participants' balances, out of "solo" scope).
//
// Migration step 5 (collaboration-architecture-rfc.md §6/§7/§8): a
// collaborative (cross-person) edit/delete now ALSO flows through this same
// outbox — the "online-required, direct call" restriction step 4 deliberately
// used as a stopgap is gone now that checkOverride is actor-aware (server
// distinguishes "same person, different device" from "different authorized
// member") and can safely produce CONFLICT instead of blindly overwriting a
// real second writer. NOT_AUTHORIZED/GROUP_DELETED/CONFLICT are handled
// BEFORE the loading/"no longer exists" checks below, because a removed
// member can no longer even READ the row (assertCanRead fails the same way
// for them) — the only thing left to show them is their own queued intent's
// remembered data, never a fresh server read.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  entityHistoryAction,
  getTransactionDetailAction,
  undoDeleteAction,
  rehomeExpenseAction,
  updateExpenseAction,
} from "@/app/actions";
import { formatDiffRow, type TimelineEvent } from "@/lib/activity";
import { amountToPaise } from "@/lib/expression";
import { friendlyDay } from "@/lib/dates";
import { inferGroupForMembers } from "@/lib/group-inference";
import { formatPaise } from "@/lib/money";
import type { TransactionDetail } from "@/server/services/transactions";
import { DateField } from "./date-field";
import { EmptyState } from "@/components/shell/empty-state";
import { AmountInput, ErrorNote, Field, SubmitButton, useSubmit } from "./form-primitives";
import { GroupCategorySelect } from "./group-category-select";
import { intentLabel, useOffline, type MutationKind } from "./offline-context";
import { FAILURE_COPY } from "./pending-detail";
import { buildSplitPayload, participantsForGroup, SplitEditor, type SplitEditorState } from "./split-editor";
import { useUI } from "./ui-context";
import { ensureDeviceId, getDeviceName, type OutboxIntent } from "@/lib/offline/db";

const cleanCopy = (msg: string) => msg.charAt(0).toUpperCase() + msg.slice(1);

export function TransactionDetailSheet({ transactionId }: { transactionId: string }) {
  const { closeModal, showToast, openModal } = useUI();
  const { pending, needsAttention, enqueueMutation, cancelPending, restorePending } = useOffline();
  const router = useRouter();
  // undefined = still loading, null = fetched but gone (e.g. deleted elsewhere)
  const [detail, setDetail] = useState<TransactionDetail | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [discardBusy, setDiscardBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getTransactionDetailAction(transactionId).then((d) => {
      if (!cancelled) setDetail(d);
    });
    return () => {
      cancelled = true;
    };
  }, [transactionId]);

  // at most one outstanding intent per entity (spec §11) — this is either a
  // still-queued edit or a still-queued delete of THIS transaction
  const queued = [...pending, ...needsAttention].find((i) => i.entityId === transactionId);
  const queuedIsDelete = queued?.kind === "tx.delete";
  const attention = queued?.status === "needs-attention";

  // these three read ONLY from the queued intent's own remembered data —
  // never from `detail`, which a removed member can no longer fetch at all
  if (attention && queued.lastErrorCode === "CONFLICT" && queued.conflict) {
    return <ConflictCard queued={queued} />;
  }
  if (attention && queued.lastErrorCode === "NOT_AUTHORIZED") {
    return <NotAuthorizedCard queued={queued} />;
  }
  if (attention && queued.lastErrorCode === "GROUP_DELETED") {
    return <GroupDeletedCard queued={queued} />;
  }

  async function handleDelete() {
    if (!detail) return;
    setDeleteBusy(true);
    const res = await enqueueMutation(
      "tx.delete",
      transactionId,
      { merchant: detail.merchant, amount: String(detail.amount / 100) },
      detail.version,
      detail.groupName ?? undefined
    );
    setDeleteBusy(false);
    if (!res.ok) {
      showToast(res.error);
      return;
    }
    closeModal();
    const intentId = res.intentId;
    showToast("Transaction deleted", async () => {
      // still sitting in the outbox (the common case — drains take well under
      // a second, but the 5s undo window doesn't require it to have landed)?
      // cancel it locally — nothing was ever sent. Otherwise it already
      // synced (or was a direct collaborative delete, which is always
      // already-synced); fall back to a real server-side restore.
      const restoredLocally = intentId ? await cancelPending(intentId) : null;
      if (restoredLocally) {
        showToast("Restored");
        router.refresh();
        return;
      }
      const undo = await undoDeleteAction(transactionId);
      showToast(undo.ok ? "Restored" : "Could not restore");
      router.refresh();
    });
  }

  async function handleCancelQueuedDelete() {
    if (!queued) return;
    setDeleteBusy(true);
    await cancelPending(queued.intentId);
    setDeleteBusy(false);
    closeModal();
    showToast("Delete cancelled");
  }

  async function handleDiscard() {
    if (!queued) return;
    setDiscardBusy(true);
    const removed = await cancelPending(queued.intentId);
    setDiscardBusy(false);
    if (!removed) return;
    closeModal();
    showToast(queuedIsDelete ? "Delete discarded" : "Edit discarded", () => void restorePending(removed));
  }

  if (detail === undefined) {
    return (
      <div className="flex flex-col gap-2.5" aria-busy="true" aria-label="Loading transaction">
        <div className="skeleton h-6 w-32 rounded" />
        <div className="skeleton h-[92px] rounded-[14px]" />
        <div className="skeleton h-[92px] rounded-[14px]" />
      </div>
    );
  }
  if (detail === null) {
    return <EmptyState icon="🧾" title="This transaction no longer exists." />;
  }

  if (editing) {
    // prefill from the queued (not-yet-synced) edit if one exists, so a
    // second edit builds on the latest local state rather than stale server
    // data — enqueueMutation() coalesces this into the SAME intent (spec §11)
    const prefill = queued && !queuedIsDelete ? (queued.payload as Record<string, unknown>) : undefined;
    // collaboration-architecture-rfc migration step 4: a non-owner's edit is
    // a different, deliberately-simpler form — see CollaborativeEditForm's
    // own comment for exactly which fields and why
    if (!detail.isOwner) return <CollaborativeEditForm detail={detail} onCancel={() => setEditing(false)} />;
    if (detail.type === "EXPENSE") return <EditExpenseForm detail={detail} prefill={prefill} onCancel={() => setEditing(false)} />;
    if (detail.type === "INCOME") return <EditIncomeForm detail={detail} prefill={prefill} onCancel={() => setEditing(false)} />;
    return <EditTransferForm detail={detail} prefill={prefill} onCancel={() => setEditing(false)} />;
  }

  const amtColor = detail.type === "INCOME" ? "var(--green)" : detail.type === "TRANSFER" ? "var(--mut)" : "var(--ink)";
  const amtPrefix = detail.type === "INCOME" ? "+" : detail.type === "TRANSFER" ? "" : "−";

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl grid place-items-center text-lg flex-none bg-accsoft">
          {detail.type === "TRANSFER" ? "⇄" : (detail.categoryIcon ?? "📦")}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-bold truncate">{detail.merchant}</div>
          <div className="text-[12px] text-mut2">{friendlyDay(detail.ymd)}</div>
        </div>
        <div className="text-[19px] font-extrabold flex-none" style={{ color: amtColor }}>
          {amtPrefix}
          {formatPaise(detail.amount)}
        </div>
      </div>

      {detail.groupId && (
        <div className="flex items-center gap-2 text-[12px] text-mut2 bg-accsoft rounded-[9px] px-3 py-2">
          <span aria-hidden="true">🏠</span>
          <span className="flex-1">
            {detail.groupName}
            {!detail.isOwner && detail.ownerName && <> · recorded by {detail.ownerName}</>}
          </span>
          {detail.viewerRole && <span className="font-semibold text-acc">{detail.viewerRole}</span>}
        </div>
      )}

      {/* v2.1 repair affordance: a split expense sitting outside any group is
          the exact shape of the production bug — the group dashboard cannot
          see it. Offered here, in read mode, so fixing it is one tap and does
          not require opening the editor (which would rewrite the split rows). */}
      {!detail.groupId && detail.type === "EXPENSE" && detail.splits.length > 0 && detail.isOwner && (
        <RehomePrompt detail={detail} />
      )}

      {queued && (
        <div
          className="text-[13px] font-semibold rounded-[10px] px-3.5 py-3"
          style={{ background: attention ? "var(--redSoft)" : "var(--accSoft)", color: attention ? "var(--red)" : "var(--mut)" }}
        >
          {attention
            ? `⚠ ${(queued.lastErrorCode && FAILURE_COPY[queued.lastErrorCode]) || (queued.lastError ? cleanCopy(queued.lastError) : "This couldn't be synced.")}`
            : queuedIsDelete
              ? "⏳ Removing · will happen automatically"
              : "⏳ Waiting to sync · will happen automatically"}
        </div>
      )}

      <div className="card p-[var(--pad)] flex flex-col gap-2.5">
        {detail.type !== "TRANSFER" && (
          <DetailRow label="Category" value={detail.categoryName ? `${detail.categoryIcon ?? "📦"} ${detail.categoryName}` : "Uncategorized"} />
        )}
        {detail.type === "TRANSFER" ? (
          <>
            <DetailRow label="From" value={detail.accountName ?? "—"} />
            <DetailRow label="To" value={detail.toAccountName ?? "—"} />
          </>
        ) : (
          <DetailRow label="Account" value={detail.paidByParticipantId ? "Paid by a friend" : (detail.accountName ?? "Unassigned")} />
        )}
        <DetailRow label="Date" value={friendlyDay(detail.ymd)} />
        {detail.notes && <DetailRow label="Notes" value={detail.notes} />}
        {detail.isRecurring && <DetailRow label="Recurring" value="Yes" />}
      </div>

      {detail.splits.length > 0 && (
        <div className="card p-[var(--pad)] flex flex-col gap-2">
          <div className="text-[11px] font-bold text-mut2 tracking-[.06em] uppercase">Split</div>
          {detail.splits.map((s) => {
            // resolved server-side (participantName) — never matched against
            // the VIEWER's own refData.participants, which is the wrong
            // namespace the instant a non-owning group member is looking
            // (collaboration-architecture-rfc §10)
            const name = s.participantId ? (s.participantName ?? "Removed friend") : detail.isOwner ? "You" : (detail.ownerName ?? "Owner");
            const isPayer = s.participantId === detail.paidByParticipantId;
            return (
              <div key={s.participantId ?? "me"} className="flex items-center justify-between text-[13px]">
                {/* Phase 2.5 cross-navigation: a real friend (not "You"/the
                    owner, and not a removed friend with no id left to link
                    to) opens their Lending contact instead of being plain text */}
                {s.participantId ? (
                  <button
                    onClick={() => openModal("lendingContact", { participantId: s.participantId! })}
                    className="font-semibold text-acc bg-transparent border-none cursor-pointer p-0 hover:underline text-left"
                  >
                    {name}
                    {isPayer ? " · paid" : ""}
                  </button>
                ) : (
                  <span className="font-semibold">
                    {name}
                    {isPayer ? " · paid" : ""}
                  </span>
                )}
                <span className="font-bold">{formatPaise(s.owedAmount)}</span>
              </div>
            );
          })}
        </div>
      )}

      <HistoryCard transactionId={transactionId} />

      {attention ? (
        <div className="flex gap-2.5">
          {!queuedIsDelete && (
            <button
              onClick={() => setEditing(true)}
              className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border border-line2 bg-card hover:bg-accsoft"
            >
              Fix
            </button>
          )}
          <button
            onClick={handleDiscard}
            disabled={discardBusy}
            className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border-none text-white hover:brightness-108 disabled:opacity-60"
            style={{ background: "var(--red)" }}
          >
            {discardBusy ? "…" : "Discard"}
          </button>
        </div>
      ) : queuedIsDelete ? (
        <button
          onClick={handleCancelQueuedDelete}
          disabled={deleteBusy}
          className="w-full p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border border-line2 bg-card hover:bg-accsoft disabled:opacity-60"
        >
          {deleteBusy ? "…" : "Cancel delete"}
        </button>
      ) : !confirmingDelete ? (
        // collaboration-architecture-rfc migration step 4: never render a
        // control the viewer can't actually use — canEditFields/canDelete are
        // re-derived server-side every load, never assumed from viewerRole here
        <div className="flex gap-2.5">
          {detail.canEditFields && (
            <button
              onClick={() => setEditing(true)}
              className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border border-line2 bg-card hover:bg-accsoft"
            >
              Edit
            </button>
          )}
          <button
            onClick={() => {
              closeModal();
              const modalType = detail.type === "EXPENSE" ? "exp" : detail.type === "INCOME" ? "inc" : "tr";
              openModal(modalType, {
                dupAmountRupees: String(detail.amount / 100),
                dupAccountId: detail.accountId,
                dupToAccountId: detail.toAccountId,
                dupCategoryId: detail.categoryId,
                dupMerchant: detail.merchant,
                dupNotes: detail.notes ?? undefined,
                dupGroupId: detail.groupId,
              });
            }}
            className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border border-line2 bg-card hover:bg-accsoft"
          >
            Duplicate
          </button>
          {detail.canDelete ? (
            <button
              onClick={() => setConfirmingDelete(true)}
              className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border-none text-white hover:brightness-108"
              style={{ background: "var(--red)" }}
            >
              Delete
            </button>
          ) : (
            !detail.isOwner && (
              <button
                disabled
                title="Only the group owner or an admin can delete this"
                className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center border border-line2 bg-card opacity-50 cursor-not-allowed"
              >
                Delete · admins only
              </button>
            )
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2.5 bg-redsoft rounded-[10px] px-3.5 py-3">
          <span className="flex-1 text-[13px] font-semibold text-red">Delete this transaction?</span>
          <button
            onClick={() => setConfirmingDelete(false)}
            className="px-3 py-1.5 rounded-lg border border-line2 text-[12px] font-semibold cursor-pointer bg-card"
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            disabled={deleteBusy}
            className="px-3 py-1.5 rounded-lg text-[12px] font-bold cursor-pointer border-none text-white disabled:opacity-60"
            style={{ background: "var(--red)" }}
          >
            {deleteBusy ? "…" : "Delete"}
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────── Conflict / removed-member / group-deleted recovery (rfc §7/§8) ───────────

/** All three cards below read ONLY from the queued OutboxIntent's own
 * remembered payload/groupName — never `detail` (a fresh server read), since
 * a removed member's assertCanRead fails identically to a non-owner reading
 * a nonexistent row, and a CONFLICT still shouldn't assume `detail` resolved
 * before the drain that produced the conflict. */

function recoveryHeader(queued: OutboxIntent) {
  const isDelete = queued.kind === "tx.delete";
  return (
    <div className="flex items-center gap-3">
      <div className="w-11 h-11 rounded-xl grid place-items-center text-lg flex-none bg-redsoft" aria-hidden="true">
        {isDelete ? "🗑" : "⚠"}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-bold truncate">{intentLabel(queued)}</div>
        {isDelete && <div className="text-[12px] text-mut2">Delete</div>}
      </div>
    </div>
  );
}

function NotAuthorizedCard({ queued }: { queued: OutboxIntent }) {
  const { closeModal, showToast } = useUI();
  const { cancelPending } = useOffline();
  const [busy, setBusy] = useState(false);
  const group = queued.groupName ?? "that group";

  async function handleDiscard() {
    setBusy(true);
    await cancelPending(queued.intentId);
    setBusy(false);
    closeModal();
    showToast("Discarded");
  }

  return (
    <div className="flex flex-col gap-3.5">
      {recoveryHeader(queued)}
      <div className="text-[13px] font-semibold rounded-[10px] px-3.5 py-3 bg-redsoft text-red">
        You&apos;re no longer part of <strong>{group}</strong>, so <strong>{intentLabel(queued)}</strong> couldn&apos;t be saved.
      </div>
      {/* rfc §8: "no guided fix exists, since re-gaining access requires being
          re-invited, which isn't something the failed edit can trigger itself" */}
      <button
        onClick={handleDiscard}
        disabled={busy}
        className="w-full p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border-none text-white hover:brightness-108 disabled:opacity-60"
        style={{ background: "var(--red)" }}
      >
        {busy ? "…" : "Discard"}
      </button>
    </div>
  );
}

function GroupDeletedCard({ queued }: { queued: OutboxIntent }) {
  const { closeModal, showToast } = useUI();
  const { cancelPending } = useOffline();
  const [busy, setBusy] = useState(false);
  const group = queued.groupName ?? "The group";

  async function handleDiscard() {
    setBusy(true);
    await cancelPending(queued.intentId);
    setBusy(false);
    closeModal();
    showToast("Discarded");
  }

  return (
    <div className="flex flex-col gap-3.5">
      {recoveryHeader(queued)}
      <div className="text-[13px] font-semibold rounded-[10px] px-3.5 py-3 bg-redsoft text-red">
        <strong>{group}</strong> was deleted, so this couldn&apos;t be saved.
      </div>
      <button
        onClick={handleDiscard}
        disabled={busy}
        className="w-full p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border-none text-white hover:brightness-108 disabled:opacity-60"
        style={{ background: "var(--red)" }}
      >
        {busy ? "…" : "Discard"}
      </button>
    </div>
  );
}

/** rfc §7: whole-record conflict — two stacked versions, changed fields
 * implicitly evident from the side-by-side amounts/merchant/notes (no
 * per-field highlighting machinery; the two cards are compact enough that
 * a difference is visually obvious without one). [Keep mine] resubmits
 * against the version that just conflicted; [Keep theirs] discards locally —
 * the server already reflects "theirs," no call needed. */
function ConflictCard({ queued }: { queued: OutboxIntent }) {
  const { closeModal, showToast } = useUI();
  const { resolveConflictKeepMine, resolveConflictKeepTheirs } = useOffline();
  const [busy, setBusy] = useState<"mine" | "theirs" | null>(null);
  const conflict = queued.conflict!;
  const mine = queued.payload as { amount?: unknown; merchant?: string; notes?: string; fromAccountId?: string; toAccountId?: string };
  const isDelete = queued.kind === "tx.delete";
  const myAmount = Math.round((Number(mine.amount) || 0) * 100);
  const theirActorFirst = conflict.serverActorName.split(" ")[0] || conflict.serverActorName;

  async function keepMine() {
    setBusy("mine");
    await resolveConflictKeepMine(queued.intentId);
    setBusy(null);
    closeModal();
    showToast("Keeping your version — syncing…");
  }

  async function keepTheirs() {
    setBusy("theirs");
    await resolveConflictKeepTheirs(queued.intentId);
    setBusy(null);
    closeModal();
    showToast(`Kept ${theirActorFirst}'s version`);
  }

  return (
    <div className="flex flex-col gap-3.5">
      {recoveryHeader(queued)}
      <div className="text-[13px] font-semibold rounded-[10px] px-3.5 py-3 bg-redsoft text-red">This changed while you were away.</div>

      <div className="card p-[var(--pad)] flex flex-col gap-1.5" style={{ border: "1.5px solid var(--acc)" }}>
        <div className="text-[11px] font-bold text-acc tracking-[.06em] uppercase">Yours · from this device</div>
        {isDelete ? (
          <div className="text-[13.5px] font-bold">Delete</div>
        ) : (
          <>
            <div className="text-[15px] font-extrabold">{formatPaise(myAmount)}</div>
            {mine.merchant && <div className="text-[13px] font-semibold">{mine.merchant}</div>}
            {mine.notes && <div className="text-[12px] text-mut2">{mine.notes}</div>}
          </>
        )}
      </div>

      <div className="card p-[var(--pad)] flex flex-col gap-1.5">
        <div className="text-[11px] font-bold text-mut2 tracking-[.06em] uppercase">{conflict.serverActorName}&apos;s</div>
        <div className="text-[15px] font-extrabold">{formatPaise(conflict.amount)}</div>
        <div className="text-[13px] font-semibold">{conflict.merchant}</div>
        {conflict.categoryName && <div className="text-[12px] text-mut2">{conflict.categoryName}</div>}
        {conflict.notes && <div className="text-[12px] text-mut2">{conflict.notes}</div>}
        <div className="text-[11px] text-mut2">{friendlyDay(conflict.ymd)}</div>
      </div>

      <div className="flex gap-2.5">
        <button
          onClick={keepMine}
          disabled={busy !== null}
          className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border-none text-white hover:brightness-108 disabled:opacity-60"
          style={{ background: "var(--acc)" }}
        >
          {busy === "mine" ? "…" : "Keep mine"}
        </button>
        <button
          onClick={keepTheirs}
          disabled={busy !== null}
          className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border border-line2 bg-card hover:bg-accsoft disabled:opacity-60"
        >
          {busy === "theirs" ? "…" : `Keep ${theirActorFirst}'s`}
        </button>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12px] text-mut2">{label}</span>
      <span className="text-[13px] font-semibold text-right">{value}</span>
    </div>
  );
}

// ─────────── History (RFC §4: per-entity slice of the activity projection) ───────────

/** friendlyDay over the event's LOCAL date — slicing the ISO string would use UTC */
function historyDayLabel(iso: string): string {
  const d = new Date(iso);
  return friendlyDay(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
}

function HistoryCard({ transactionId }: { transactionId: string }) {
  const { closeModal } = useUI();
  const [history, setHistory] = useState<{ events: TimelineEvent[]; more: boolean } | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    entityHistoryAction(transactionId).then((h) => {
      if (!cancelled) setHistory(h);
    });
    return () => {
      cancelled = true;
    };
  }, [transactionId]);

  if (!history || history.events.length === 0) return null;
  const related = history.events[history.events.length - 1]?.related ?? [];

  return (
    <div className="card p-[var(--pad)] flex flex-col gap-2">
      <div className="text-[11px] font-bold text-mut2 tracking-[.06em] uppercase">History</div>
      <div className="flex flex-col">
        {history.events.map((ev, i) => (
          <div key={ev.activityId} className="flex gap-2.5">
            <div className="flex flex-col items-center w-3 flex-none" aria-hidden="true">
              <span className="w-[7px] h-[7px] rounded-full mt-[5px] flex-none" style={{ background: "var(--acc)" }} />
              {i < history.events.length - 1 && <span className="w-px flex-1 bg-line2" />}
            </div>
            <div className="flex-1 min-w-0 pb-2.5">
              <div className="flex items-baseline gap-2">
                <span className="text-[12.5px] font-semibold flex-1">
                  {ev.summary}
                  {/* collaboration-architecture-rfc §5: only ever set when a
                      different authorized group member acted — the row's own
                      owner editing their own transaction shows no attribution,
                      exactly as before collaboration existed */}
                  {ev.actorName && <span className="text-acc font-semibold"> · {ev.actorName}</span>}
                </span>
                <time dateTime={ev.ts} className="text-[11px] text-mut2 flex-none">
                  {historyDayLabel(ev.ts)},{" "}
                  {new Date(ev.ts).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}
                </time>
              </div>
              {ev.diff.length === 0 && ev.detail && <div className="text-[11.5px] text-mut2">{ev.detail}</div>}
              {ev.diff.map((d) => (
                <div key={d.field} className="text-[11.5px] text-mut2">
                  <span className="font-semibold text-mut">{d.fieldLabel}</span> {formatDiffRow(d)}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {history.more && (
        <Link
          href={`/activity?entity=${transactionId}`}
          onClick={closeModal}
          className="text-[12px] font-semibold text-acc no-underline self-start"
        >
          Full history →
        </Link>
      )}
      {related.length > 0 && (
        <div className="flex gap-1.5 flex-wrap pt-1 border-t border-line">
          {related.map((r) => (
            <Link
              key={r.href}
              href={r.href}
              onClick={closeModal}
              className="px-2.5 py-1 rounded-full bg-accsoft text-acc text-[11.5px] font-semibold no-underline"
            >
              {r.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────── Edit: Collaborative (non-owner) ───────────

/** Migration step 4: a non-owner's edit is deliberately a narrower form than
 * the owner's. accountId is rendered read-only text, never a live <select> —
 * refData.accounts is the VIEWER's own accounts, not the row owner's, so a
 * functional picker here would let someone move a friend's money into an
 * account of theirs that doesn't exist. Category options come from
 * GroupCategorySelect (the group's own category namespace — group-expenses-
 * sprint), never refData.expenseCategories/incomeCategories. The amount locks
 * whenever a split exists:
 * safely recomputing shares needs the interactive split editor plus a
 * group-scoped participant picker, both explicitly out of scope this phase.
 * Any existing split is resubmitted byte-for-byte from detail.splits' own
 * server-resolved participantId/owedAmount — never matched against
 * refData.participants (the viewer's own contact list), which would silently
 * corrupt the split onto unrelated ids. */
function CollaborativeEditForm({ detail, onCancel }: { detail: TransactionDetail; onCancel: () => void }) {
  const { enqueueMutation } = useOffline();
  const { run, busy, error } = useSubmit();
  const [amount, setAmount] = useState(String(detail.amount / 100));
  const [categoryId, setCategoryId] = useState(detail.categoryId ?? "");
  const [merchant, setMerchant] = useState(detail.merchant);
  const [date, setDate] = useState(detail.ymd);
  const [notes, setNotes] = useState(detail.notes ?? "");
  const hasSplit = detail.splits.length > 0;
  const groupId = detail.groupId;

  function existingSplitPayload() {
    if (!hasSplit) return undefined;
    const friends = detail.splits.filter((s) => s.participantId);
    // PERCENT/RATIO weights can't be losslessly rebuilt from owedAmount alone
    // — same EXACT fallback EditExpenseForm uses when reopening one of these
    const mode: "EQUAL" | "EXACT" = detail.splits[0]?.method === "EQUAL" ? "EQUAL" : "EXACT";
    return {
      mode,
      participantIds: friends.map((s) => s.participantId as string),
      payerParticipantId: detail.paidByParticipantId,
      exactAmounts:
        mode === "EXACT" ? Object.fromEntries(friends.map((s) => [s.participantId as string, s.owedAmount])) : undefined,
    };
  }

  // migration step 5: goes through the SAME outbox every solo edit uses now
  // that checkOverride is actor-aware — online or offline, this device's
  // edit queues instantly and drains in the background, exactly like the
  // owner's own edits already do (rfc §6).
  function save() {
    const payload =
      detail.type === "EXPENSE"
        ? {
            amount,
            accountId: detail.accountId, // unchanged — locked (rfc §1)
            categoryId: categoryId || null,
            merchant,
            date,
            notes: notes || undefined,
            split: existingSplitPayload(),
          }
        : detail.type === "INCOME"
          ? { amount, accountId: detail.accountId ?? "", categoryId: categoryId || null, merchant, date, notes: notes || undefined }
          : { amount, fromAccountId: detail.accountId ?? "", toAccountId: detail.toAccountId ?? "", date, notes: notes || undefined };
    const kind: MutationKind = detail.type === "EXPENSE" ? "expense.update" : detail.type === "INCOME" ? "income.update" : "transfer.update";
    return enqueueMutation(kind, detail.id, payload, detail.version, detail.groupName ?? undefined);
  }

  return (
    <div className="flex flex-col gap-3">
      <Field label="AMOUNT (₹)">
        <AmountInput value={amount} onChange={setAmount} autoFocus={!hasSplit} disabled={hasSplit} />
        {hasSplit && <div className="text-[11px] text-mut2 mt-1">🔒 Locked — this transaction is split with friends</div>}
      </Field>
      <div className="flex gap-2.5 flex-wrap">
        {detail.type === "TRANSFER" ? (
          <>
            <Field label="FROM">
              <div className="field flex items-center !bg-accsoft !text-mut2 !cursor-not-allowed">{detail.accountName ?? "—"}</div>
            </Field>
            <Field label="TO">
              <div className="field flex items-center !bg-accsoft !text-mut2 !cursor-not-allowed">{detail.toAccountName ?? "—"}</div>
            </Field>
          </>
        ) : (
          <>
            <Field label="ACCOUNT">
              <div className="field flex items-center !bg-accsoft !text-mut2 !cursor-not-allowed">
                {detail.paidByParticipantId ? "Paid by a friend" : (detail.accountName ?? "Unassigned")}
              </div>
            </Field>
            <Field label="CATEGORY">
              {groupId ? (
                <GroupCategorySelect groupId={groupId} value={categoryId} onChange={setCategoryId} />
              ) : (
                <select className="field" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                  <option value="">Uncategorized</option>
                </select>
              )}
            </Field>
          </>
        )}
      </div>
      {detail.type !== "TRANSFER" && (
        <Field label={detail.type === "INCOME" ? "DESCRIPTION" : "MERCHANT"}>
          <input
            className="field"
            value={merchant}
            onChange={(e) => setMerchant(e.target.value)}
            placeholder={detail.type === "INCOME" ? "e.g. Salary · Acme Corp" : "e.g. Swiggy"}
          />
        </Field>
      )}
      <Field label="DATE">
        <DateField value={date} onChange={setDate} />
      </Field>
      <Field label="NOTES">
        <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
      </Field>
      <div className="text-[11.5px] text-mut2 bg-accsoft rounded-lg px-3 py-2">
        🔒 Account is locked — only {detail.ownerName ?? "the owner"} can change which account this uses.
      </div>
      <ErrorNote error={error} />
      <div className="flex gap-2.5">
        <button
          onClick={onCancel}
          className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border border-line2 bg-card hover:bg-accsoft"
        >
          Cancel
        </button>
        <div className="flex-[2]">
          <SubmitButton busy={busy} onClick={() => run(save, "Transaction updated")}>
            Save changes
          </SubmitButton>
        </div>
      </div>
    </div>
  );
}

/** v2.1: "this split isn't in a group — should it be?"
 *
 *  Moving from here calls rehomeExpenseAction, which issues a single-column
 *  UPDATE on Transaction.groupId. No amount, payer, participant or split row is
 *  rewritten, so every balance is arithmetically identical afterwards — only
 *  which dashboard can see the expense changes. That guarantee is stated on
 *  screen because the user is being asked to trust it. */
function RehomePrompt({ detail }: { detail: TransactionDetail }) {
  const { refData } = useUI();
  const { run, busy, error } = useSubmit();
  const [open, setOpen] = useState(false);

  const memberIds = detail.splits.map((s) => s.participantId).filter((id): id is string => !!id);
  const inference = inferGroupForMembers(memberIds, refData.groups);
  if (refData.groups.length === 0) return null;

  const suggested = inference.kind === "one" ? inference : null;

  return (
    <div className="rounded-[9px] px-3 py-2.5 flex flex-col gap-2" style={{ background: "var(--accSoft)" }}>
      <div className="text-[12px] font-semibold" style={{ color: "var(--acc)" }}>
        {suggested
          ? `Everyone in this split is in ${suggested.groupName}, but this expense isn't — so it's missing from that group's totals.`
          : "This split isn't part of any group, so it won't appear on a group's dashboard."}
      </div>
      {!open ? (
        <div className="flex gap-1.5 flex-wrap">
          {suggested && (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => rehomeExpenseAction({ id: detail.id, groupId: suggested.groupId }), `Moved to ${suggested.groupName}`)}
              className="px-3 py-1.5 rounded-full text-[12px] font-bold cursor-pointer border-none text-white disabled:opacity-60"
              style={{ background: "var(--acc)" }}
            >
              Move to {suggested.groupName}
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="px-3 py-1.5 rounded-full text-[12px] font-semibold cursor-pointer border bg-card"
            style={{ borderColor: "var(--acc)", color: "var(--acc)" }}
          >
            {suggested ? "Choose another group" : "Move to a group"}
          </button>
        </div>
      ) : (
        <select
          className="field"
          aria-label="Move to group"
          defaultValue=""
          disabled={busy}
          onChange={(e) => {
            const gid = e.target.value;
            if (!gid) return;
            const name = refData.groups.find((g) => g.id === gid)?.name ?? "the group";
            run(() => rehomeExpenseAction({ id: detail.id, groupId: gid }), `Moved to ${name}`);
          }}
        >
          <option value="">Pick a group…</option>
          {refData.groups.map((g) => (
            <option key={g.id} value={g.id}>🏠 {g.name}</option>
          ))}
        </select>
      )}
      <div className="text-[11px] text-mut2">
        Only the group changes — the amount, who paid and every person&apos;s share stay exactly the same.
      </div>
      <ErrorNote error={error} />
    </div>
  );
}

// ─────────── Edit: Expense ───────────

function EditExpenseForm({ detail, prefill, onCancel }: { detail: TransactionDetail; prefill?: Record<string, unknown>; onCancel: () => void }) {
  const { refData } = useUI();
  // v2.1: Lending contacts are no longer excluded here — see the matching note
  // in modals.tsx. Hiding them is what forced a duplicate person into being,
  // and the edit form must offer the same roster as the create form or a split
  // could not be edited back to the contact it should have used.
  const sharedParticipants = refData.participants;
  const { enqueueMutation } = useOffline();
  const { run, busy, error } = useSubmit();
  const pre = prefill as { amount?: string; accountId?: string | null; categoryId?: string | null; merchant?: string; date?: string; notes?: string } | undefined;
  const [amount, setAmount] = useState(pre?.amount ?? String(detail.amount / 100));
  const [accountId, setAccountId] = useState(pre?.accountId ?? detail.accountId ?? refData.accounts[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState(pre?.categoryId ?? detail.categoryId ?? refData.expenseCategories[0]?.id ?? "");
  const [merchant, setMerchant] = useState(pre?.merchant ?? detail.merchant);
  const [date, setDate] = useState(pre?.date ?? detail.ymd);
  const [notes, setNotes] = useState(pre?.notes ?? detail.notes ?? "");
  // v2.1 repair path: an expense's group is now editable. Unlike the create
  // form this never auto-applies an inferred group — quietly re-homing a row
  // the user only opened to fix a typo would be its own nasty surprise. It
  // suggests, and the user decides.
  const [groupId, setGroupId] = useState(detail.groupId ?? "");

  const hadSplit = detail.splits.length > 0;
  // PERCENT/RATIO store only the resulting paise amount, not the original
  // weights — those can't be losslessly reconstructed, so a split that was
  // created as percent/ratio reopens as EXACT with today's exact amounts
  // pre-filled (accurate) rather than guessing at weights (which would be
  // wrong unless the user happened to re-enter them before saving).
  const initialMode: "EQUAL" | "EXACT" = detail.splits[0]?.method === "EQUAL" ? "EQUAL" : "EXACT";
  const [split, setSplit] = useState(hadSplit);
  const [mode, setMode] = useState<"EQUAL" | "EXACT" | "PERCENT" | "RATIO">(initialMode);
  const [parts, setParts] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(detail.splits.filter((s) => s.participantId).map((s) => [s.participantId as string, true]))
  );
  const [exact, setExact] = useState<Record<string, string>>(() =>
    Object.fromEntries(detail.splits.filter((s) => s.participantId).map((s) => [s.participantId as string, String(s.owedAmount / 100)]))
  );
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [payerId, setPayerId] = useState<string | null>(detail.paidByParticipantId);

  const splitState: SplitEditorState = { split, setSplit, mode, setMode, parts, setParts, exact, setExact, weights, setWeights, payerId, setPayerId };
  // Same rule as the add-expense form: once this row belongs to a group, only
  // that group's members are offered. Anyone already on the split stays listed
  // even if they have since left, so editing never drops them silently.
  const pickerParticipants = participantsForGroup(sharedParticipants, groupId, refData.groups, parts);
  const selected = sharedParticipants.filter((p) => parts[p.id]);
  const selectedIds = selected.map((p) => p.id);
  // Expression-aware, so the submitted value never depends on whether blur
  // fired before the tap on Save — see amountToPaise.
  const amtPaise = amountToPaise(amount);

  // The repair affordance for an expense split among a group's members but
  // saved as personal: offered as a one-tap suggestion, never applied for you.
  const inference = inferGroupForMembers(selectedIds, refData.groups);
  const suggestedGroup = !groupId && split && inference.kind === "one" ? inference : null;

  function changeGroup(id: string) {
    setGroupId(id);
    // Categories are namespaced per group (group-expenses-sprint §10) and the
    // server rejects a category from the wrong one, so the pick is reset and
    // the picker below switches namespace with it.
    setCategoryId("");
  }

  return (
    <div className="flex flex-col gap-3">
      <Field label="AMOUNT (₹)">
        <AmountInput value={amount} onChange={setAmount} autoFocus />
      </Field>
      <div className="flex gap-2.5 flex-wrap">
        <Field label="ACCOUNT">
          <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {refData.accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.icon} {a.name}</option>
            ))}
          </select>
        </Field>
        <Field label="CATEGORY">
          {/* group-expenses-sprint: a group-tagged expense is labeled from the
              group's own category namespace, not the owner's personal list —
              "group expenses should not use personal categories" applies
              regardless of who's editing, owner included.
              v2.1: follows the live `groupId`, not `detail.groupId`, so
              re-homing swaps the namespace in the same edit. */}
          {groupId ? (
            <GroupCategorySelect groupId={groupId} value={categoryId} onChange={setCategoryId} />
          ) : (
            <select className="field" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              {refData.expenseCategories.map((c) => (
                <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <div className="flex gap-2.5 flex-wrap">
        <Field label="MERCHANT">
          <input className="field" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="e.g. Swiggy" />
        </Field>
        <Field label="DATE">
          <DateField value={date} onChange={setDate} />
        </Field>
      </div>
      <Field label="NOTES">
        <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
      </Field>

      <SplitEditor state={splitState} amtPaise={amtPaise} participants={pickerParticipants} />

      {/* v2.1: the group is editable here — this is the repair path for an
          expense that was split with a group's members but saved as personal.
          Shown whenever the row already has a group or is a split, since those
          are the only cases where the answer matters. */}
      {refData.groups.length > 0 && (split || !!detail.groupId) && (
        <Field label="GROUP">
          <select className="field" aria-label="Group" value={groupId} onChange={(e) => changeGroup(e.target.value)}>
            <option value="">Personal (not in a group)</option>
            {refData.groups.map((g) => (
              <option key={g.id} value={g.id}>🏠 {g.name}</option>
            ))}
          </select>
          {suggestedGroup && (
            <button
              type="button"
              onClick={() => changeGroup(suggestedGroup.groupId)}
              className="text-[11.5px] font-semibold mt-1.5 rounded-lg px-2.5 py-2 w-full text-left cursor-pointer border-none"
              style={{ color: "var(--acc)", background: "var(--accSoft)" }}
            >
              Everyone in this split is in <strong>{suggestedGroup.groupName}</strong> — move it there?
            </button>
          )}
          {groupId !== (detail.groupId ?? "") && (
            <div className="text-[11.5px] font-semibold text-mut mt-1.5">
              Only the group changes. Amount, who paid and every person&apos;s share stay exactly as they are.
            </div>
          )}
        </Field>
      )}

      <ErrorNote error={error} />
      <div className="flex gap-2.5">
        <button onClick={onCancel} className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border border-line2 bg-card hover:bg-accsoft">
          Cancel
        </button>
        <div className="flex-[2]">
          <SubmitButton
            busy={busy}
            onClick={() =>
              run(() => {
                const payload = {
                  amount,
                  accountId: accountId || null,
                  categoryId: categoryId || null,
                  merchant,
                  date,
                  notes: notes || undefined,
                  split: buildSplitPayload(splitState, selectedIds),
                  // v2.1: sent explicitly so re-homing works. Unchanged in the
                  // common case, and the server keeps the existing value when
                  // this equals it — an ordinary edit never moves the row.
                  groupId: groupId || null,
                };
                // a split touches other participants' balances — needs the
                // server's validation, same restriction as creating one (Phase 1/2)
                if (split) {
                  if (typeof navigator !== "undefined" && !navigator.onLine) {
                    return Promise.resolve({ ok: false as const, error: "Split expenses need internet — try again when you're back online." });
                  }
                  // production audit §1.2/§PhaseA.2: this direct call used to
                  // carry no intent/baseVersion at all, so checkOverride
                  // could never see it — it applied blindly regardless of
                  // what changed underneath it, and left no Intent row for
                  // any LATER conflict check on this transaction to find.
                  return (async () => {
                    const deviceId = await ensureDeviceId().catch(() => crypto.randomUUID());
                    const deviceName = await getDeviceName().catch(() => undefined);
                    return updateExpenseAction({
                      id: detail.id,
                      ...payload,
                      intent: { intentId: crypto.randomUUID(), deviceId, deviceName, clientTs: new Date().toISOString(), baseVersion: detail.version },
                    });
                  })();
                }
                return enqueueMutation("expense.update", detail.id, payload, detail.version);
              }, "Transaction updated")
            }
          >
            Save changes
          </SubmitButton>
        </div>
      </div>
    </div>
  );
}

// ─────────── Edit: Income ───────────

function EditIncomeForm({ detail, prefill, onCancel }: { detail: TransactionDetail; prefill?: Record<string, unknown>; onCancel: () => void }) {
  const { refData } = useUI();
  const { enqueueMutation } = useOffline();
  const { run, busy, error } = useSubmit();
  const pre = prefill as { amount?: string; accountId?: string; categoryId?: string | null; merchant?: string; date?: string; notes?: string } | undefined;
  const [amount, setAmount] = useState(pre?.amount ?? String(detail.amount / 100));
  const [accountId, setAccountId] = useState(pre?.accountId ?? detail.accountId ?? refData.accounts[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState(pre?.categoryId ?? detail.categoryId ?? refData.incomeCategories[0]?.id ?? "");
  const [merchant, setMerchant] = useState(pre?.merchant ?? detail.merchant);
  const [date, setDate] = useState(pre?.date ?? detail.ymd);
  const [notes, setNotes] = useState(pre?.notes ?? detail.notes ?? "");

  return (
    <div className="flex flex-col gap-3">
      <Field label="AMOUNT (₹)">
        <AmountInput value={amount} onChange={setAmount} autoFocus />
      </Field>
      <div className="flex gap-2.5 flex-wrap">
        <Field label="INTO ACCOUNT">
          <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {refData.accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.icon} {a.name}</option>
            ))}
          </select>
        </Field>
        <Field label="SOURCE">
          <select className="field" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            {refData.incomeCategories.map((c) => (
              <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="flex gap-2.5 flex-wrap">
        <Field label="DESCRIPTION">
          <input className="field" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="e.g. Salary · Acme Corp" />
        </Field>
        <Field label="DATE">
          <DateField value={date} onChange={setDate} />
        </Field>
      </div>
      <Field label="NOTES">
        <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
      </Field>
      <ErrorNote error={error} />
      <div className="flex gap-2.5">
        <button onClick={onCancel} className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border border-line2 bg-card hover:bg-accsoft">
          Cancel
        </button>
        <div className="flex-[2]">
          <SubmitButton
            busy={busy}
            color="var(--green)"
            onClick={() =>
              run(
                () => enqueueMutation("income.update", detail.id, { amount, accountId, categoryId: categoryId || null, merchant, date, notes: notes || undefined }, detail.version),
                "Transaction updated"
              )
            }
          >
            Save changes
          </SubmitButton>
        </div>
      </div>
    </div>
  );
}

// ─────────── Edit: Transfer ───────────

function EditTransferForm({ detail, prefill, onCancel }: { detail: TransactionDetail; prefill?: Record<string, unknown>; onCancel: () => void }) {
  const { refData } = useUI();
  const { enqueueMutation } = useOffline();
  const { run, busy, error } = useSubmit();
  const pre = prefill as { amount?: string; fromAccountId?: string; toAccountId?: string; date?: string; notes?: string } | undefined;
  const [amount, setAmount] = useState(pre?.amount ?? String(detail.amount / 100));
  const [from, setFrom] = useState(pre?.fromAccountId ?? detail.accountId ?? refData.accounts[0]?.id ?? "");
  const [to, setTo] = useState(pre?.toAccountId ?? detail.toAccountId ?? refData.accounts[1]?.id ?? refData.accounts[0]?.id ?? "");
  const [date, setDate] = useState(pre?.date ?? detail.ymd);
  const [notes, setNotes] = useState(pre?.notes ?? detail.notes ?? "");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2.5 flex-wrap">
        <Field label="FROM">
          <select className="field" value={from} onChange={(e) => setFrom(e.target.value)}>
            {refData.accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.icon} {a.name}</option>
            ))}
          </select>
        </Field>
        <Field label="TO">
          <select className="field" value={to} onChange={(e) => setTo(e.target.value)}>
            {refData.accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.icon} {a.name}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="AMOUNT (₹)">
        <AmountInput value={amount} onChange={setAmount} autoFocus />
      </Field>
      <Field label="DATE">
        <DateField value={date} onChange={setDate} />
      </Field>
      <Field label="NOTES">
        <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
      </Field>
      <ErrorNote error={error} />
      <div className="flex gap-2.5">
        <button onClick={onCancel} className="flex-1 p-3 rounded-[10px] text-[13.5px] font-bold text-center cursor-pointer border border-line2 bg-card hover:bg-accsoft">
          Cancel
        </button>
        <div className="flex-[2]">
          <SubmitButton
            busy={busy}
            onClick={() =>
              run(
                () => enqueueMutation("transfer.update", detail.id, { amount, fromAccountId: from, toAccountId: to, date, notes: notes || undefined }, detail.version),
                "Transaction updated"
              )
            }
          >
            Save changes
          </SubmitButton>
        </div>
      </div>
    </div>
  );
}
