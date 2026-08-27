"use client";

// Lending module — Contact list requirement: search (name/phone/notes, with
// match highlighting) + sort by largest outstanding amount. Sorting already
// happens server-side (lendingDashboardSummary), so this only owns the live
// text filter. Rows show entry count, last-transaction recency, and a
// zero-balance "Settled up" treatment distinct from owed/owing (Phase 1.5).

import { useState } from "react";
import { friendlyDay } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import type { LendingParticipantView } from "@/server/services/lending";
import { EmptyState } from "@/components/shell/empty-state";
import { OpenModalButton } from "@/components/shell/buttons";
import { CONTACT_SORTS, DEFAULT_CONTACT_SORT, parseContactSort, sortLendingContacts, type ContactSort } from "@/lib/loan-sort";

function matches(c: LendingParticipantView, needle: string): boolean {
  return (
    c.name.toLowerCase().includes(needle) ||
    (c.phone?.toLowerCase().includes(needle) ?? false) ||
    (c.notes?.toLowerCase().includes(needle) ?? false)
  );
}

/** Wraps every case-insensitive occurrence of `needle` in <mark>. Plain text
 * in, plain text + highlighted spans out — never touches HTML, so this is
 * safe on user-entered names without any escaping concerns. */
function highlight(text: string, needle: string): React.ReactNode {
  if (!needle) return text;
  const lower = text.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-accsoft2 text-acc rounded-sm px-px">{text.slice(idx, idx + needle.length)}</mark>
      {text.slice(idx + needle.length)}
    </>
  );
}

/** A migrated contact still shows its badge only until the user fills in any
 * detail — photo, phone or a note (the exact follow-ups the migration report
 * suggests). Participant has no timestamp, so this emptiness is the "untouched"
 * signal; no schema change, and it clears itself the moment a detail is added. */
function freshlyImported(c: LendingParticipantView, importedContacts?: Record<string, string>): string | null {
  const source = importedContacts?.[c.id];
  if (!source) return null;
  if (c.photo || c.phone || (c.notes && c.notes.trim())) return null;
  return source;
}

export function LendingContactsList({
  contacts,
  onSelect,
  selectedId,
  importedContacts,
}: {
  contacts: LendingParticipantView[];
  /** Called on row click. The caller decides what "select" means — open the
   * mobile modal sheet, or set the desktop inline pane's selection — since
   * that depends on viewport, which this list has no reason to know about. */
  onSelect: (contact: LendingParticipantView) => void;
  /** Highlights the currently-selected row (desktop two-pane only). */
  selectedId?: string;
  /** participantId → source label for contacts an import created (badge source). */
  importedContacts?: Record<string, string>;
}) {
  const [q, setQ] = useState("");
  // Display order only. `contacts` carries balances the server already
  // computed; nothing here is sent anywhere, and FIFO reads the database, not
  // this array.
  const [sort, setSort] = useState<ContactSort>(DEFAULT_CONTACT_SORT);
  const needle = q.trim().toLowerCase();
  // Filter first, then order what survived — so the sort applies to what is
  // actually on screen rather than to rows the search has already removed.
  const filtered = sortLendingContacts(needle ? contacts.filter((c) => matches(c, needle)) : contacts, sort);

  return (
    <section className="card flex-[1_1_320px] p-[var(--pad)] flex flex-col gap-[13px]">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13.5px] font-bold m-0">Contacts</h2>
        {/* The list you scan for a person is also where you notice one is
            missing. Opens the same friend modal as /people and /shared. */}
        <OpenModalButton
          type="friend"
          className="text-[12px] font-bold text-acc bg-transparent border-none cursor-pointer min-h-[44px] px-1 -mr-1 hover:brightness-110"
        >
          &#65291; Add contact
        </OpenModalButton>
      </div>
      {contacts.length > 0 && (
        <div className="flex gap-1.5">
          <input
            className="field flex-1 min-w-0"
            placeholder="Search name, phone, or notes…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search contacts"
          />
          <select
            className="field w-auto flex-none min-h-[44px] text-[12.5px] font-semibold"
            value={sort}
            onChange={(e) => setSort(parseContactSort(e.target.value))}
            aria-label="Sort contacts"
            title="Sort contacts"
          >
            {CONTACT_SORTS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
      )}
      {contacts.length === 0 && (
        <EmptyState
          icon="🤝"
          title="You haven't started lending yet"
          detail='Record what you gave or got, or add the people first.'
          compact
          action={
            <OpenModalButton type="friend" className="btn-primary min-h-[44px] text-[12.5px] font-bold cursor-pointer">
              &#65291; Add contact
            </OpenModalButton>
          }
        />
      )}
      {contacts.length > 0 && filtered.length === 0 && <EmptyState icon="🔎" title={`No contacts match “${q}”`} compact />}
      {filtered.map((c) => {
        const owed = Math.abs(c.net) > 100;
        const state =
          c.net > 100
            ? { label: "You'll get", color: "var(--green)", bg: "var(--greenSoft)" }
            : c.net < -100
              ? { label: "You'll pay", color: "var(--red)", bg: "var(--redSoft)" }
              : { label: "All settled", color: "var(--mut2)", bg: "var(--accSoft)" };
        const isSelected = selectedId === c.id;
        return (
          <button
            key={c.id}
            onClick={() => onSelect(c)}
            aria-current={isSelected ? "true" : undefined}
            className="flex items-center gap-[11px] border-none cursor-pointer text-left p-2 -m-2 w-[calc(100%+16px)] rounded-[10px] hover:bg-accsoft"
            style={{ background: isSelected ? "var(--accSoft)" : "transparent" }}
          >
            <div
              className="w-10 h-10 rounded-full grid place-items-center text-[13px] font-bold text-white overflow-hidden flex-none"
              style={{ background: c.color }}
            >
              {c.photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.photo} alt="" className="w-full h-full object-cover" />
              ) : (
                c.initial
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-bold truncate">{highlight(c.name, needle)}</div>
              <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                <span className="text-[10px] font-bold px-[7px] py-px rounded-full" style={{ background: state.bg, color: state.color }}>
                  {state.label}
                </span>
                {c.overdueCount > 0 && (
                  <span className="text-[10px] font-bold px-[7px] py-px rounded-full" style={{ background: "var(--redSoft)", color: "var(--red)" }}>
                    {c.overdueCount} overdue
                  </span>
                )}
                {(() => {
                  const src = freshlyImported(c, importedContacts);
                  return src ? (
                    <span
                      className="text-[10px] font-bold px-[7px] py-px rounded-full"
                      style={{ background: "var(--accsoft)", color: "var(--acc)" }}
                      title={`Migrated from ${src} — add a photo, phone or note to clear this`}
                    >
                      📒 From {src}
                    </span>
                  ) : null;
                })()}
              </div>
              <div className="text-[11px] text-mut2 mt-0.5 truncate">
                {c.entryCount} {c.entryCount === 1 ? "entry" : "entries"}
                {c.lastTransactionYmd ? ` · ${friendlyDay(c.lastTransactionYmd)}` : ""}
              </div>
            </div>
            <div className="text-[13.5px] font-extrabold flex-none" style={{ color: state.color }}>
              {owed ? formatPaise(Math.abs(c.net)) : "—"}
            </div>
          </button>
        );
      })}
    </section>
  );
}
