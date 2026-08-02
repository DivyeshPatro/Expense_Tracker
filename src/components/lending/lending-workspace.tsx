"use client";

// Lending module Phase 1.5, item #12 (desktop polish): desktop has room for
// a two-pane layout — Contacts (left) + the selected contact's ledger
// (right) — instead of forcing a modal just to view a contact. Mobile has
// no room for two panes, so a row tap there opens the existing modal sheet
// instead; the split is decided by matchMedia at click time (not tracked in
// state), so it always reflects the actual viewport at the moment of the
// tap, including across a resize between renders.

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { friendlyDay } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import type { LendingParticipantView, LoanEntryRow } from "@/server/services/lending";
import { useUI } from "@/components/shell/ui-context";
import { ContactLedgerView } from "./contact-ledger";
import { LendingContactsList } from "./contacts-list";
import { EmptyState } from "@/components/shell/empty-state";

const DESKTOP_QUERY = "(min-width: 768px)"; // Tailwind's md breakpoint

export function LendingWorkspace({
  contacts,
  recentEntries,
  importedContacts,
}: {
  contacts: LendingParticipantView[];
  recentEntries: LoanEntryRow[];
  /** participantId → source label ("Khatabook") for contacts an import created. */
  importedContacts?: Record<string, string>;
}) {
  const { openModal } = useUI();
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const searchParams = useSearchParams();
  const consumedDeepLink = useRef(false);

  function handleSelect(contact: { id: string; name: string }) {
    const isDesktop = typeof window !== "undefined" && window.matchMedia(DESKTOP_QUERY).matches;
    if (isDesktop) {
      setSelected({ id: contact.id, name: contact.name });
    } else {
      openModal("lendingContact", { participantId: contact.id });
    }
  }

  // Phase 2.5 cross-navigation: /lending?contact=<participantId> deep-links
  // straight into that contact's ledger (Activity Timeline related chips and
  // the unified search both navigate here). Consumed once on mount — later
  // in-page selection changes shouldn't be overridden by a stale URL param.
  const deepLinkContactId = searchParams.get("contact");
  useEffect(() => {
    if (consumedDeepLink.current || !deepLinkContactId) return;
    consumedDeepLink.current = true;
    const contact = contacts.find((c) => c.id === deepLinkContactId);
    if (contact) handleSelect(contact);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkContactId]);

  return (
    <div className="flex flex-wrap gap-3.5 items-start">
      <LendingContactsList contacts={contacts} onSelect={handleSelect} selectedId={selected?.id} importedContacts={importedContacts} />

      {selected ? (
        <section className="card flex-[1.3_1_320px] p-[var(--pad)]" style={{ animation: "rise .2s ease" }}>
          <ContactLedgerView participantId={selected.id} onClose={() => setSelected(null)} />
        </section>
      ) : (
        <section className="card flex-[1.3_1_320px] px-4 py-1.5">
          <RecentEntriesPanel entries={recentEntries} onSelect={handleSelect} />
        </section>
      )}
    </div>
  );
}

function RecentEntriesPanel({
  entries,
  onSelect,
}: {
  entries: LoanEntryRow[];
  onSelect: (contact: { id: string; name: string }) => void;
}) {
  const groups: { label: string; items: LoanEntryRow[] }[] = [];
  for (const e of entries) {
    const label = friendlyDay(e.ymd);
    const g = groups[groups.length - 1];
    if (!g || g.label !== label) groups.push({ label, items: [e] });
    else g.items.push(e);
  }

  return (
    <div>
      <h2 className="text-[13.5px] font-bold pt-3 pb-1.5 m-0">Recent entries</h2>
      {entries.length === 0 && (
        <div className="pb-3">
          <EmptyState icon="📭" title="No lending history yet" detail='Record what you gave or got to see it here.' compact />
        </div>
      )}
      {groups.map((g) => (
        <div key={g.label}>
          <div className="text-[11px] font-bold text-mut2 tracking-[.06em] mt-2 mb-1 uppercase">{g.label}</div>
          {g.items.map((e) => {
            const gave = e.kind === "GAVE";
            return (
              <button
                key={e.id}
                onClick={() => onSelect({ id: e.participantId, name: e.participantName })}
                className="flex items-center gap-3 py-[11px] border-b border-line last:border-b-0 bg-transparent border-x-0 border-t-0 cursor-pointer text-left w-full hover:bg-accsoft -mx-1 px-1 rounded-lg"
              >
                <div className="w-9 h-9 rounded-[11px] grid place-items-center text-[15px] flex-none" style={{ background: gave ? "var(--accSoft)" : "var(--greenSoft)" }}>
                  {gave ? "💸" : "💰"}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold truncate">{gave ? `You gave ${e.participantName}` : `${e.participantName} gave you`}</div>
                  <div className="text-[11.5px] text-mut2 truncate">{e.reason || (e.accountName ? `via ${e.accountName}` : "Untracked")}</div>
                </div>
                <div className="text-[13px] font-bold flex-none" style={{ color: gave ? "var(--ink)" : "var(--green)" }}>{formatPaise(e.amount)}</div>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
