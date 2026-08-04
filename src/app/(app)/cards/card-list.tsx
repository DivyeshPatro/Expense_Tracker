"use client";

// The wallet: a compact, scannable list of cards. One row per card, the whole
// row a tap target into the dedicated detail screen (/cards/[id]). Search,
// network filters and the archived drawer live here; per-card actions (reveal,
// edit, delete, default) moved to the detail screen where there's room for them
// to be unambiguous.
//
// Filtering happens in the browser, not the database — a person has a handful of
// cards, they're already on the page, and a round trip per keystroke would feel
// slower than reading the four rows in front of you. It also keeps the query out
// of the URL, which matters here: "?q=hdfc" would land in history and referrers.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { EmptyState } from "@/components/shell/empty-state";
import { setCreditCardFavoriteAction } from "@/app/actions";
import { useUI } from "@/components/shell/ui-context";
import { networkLabel, type CardNetwork } from "@/lib/card-identity";
import { cardGradient } from "@/lib/card-visual";
import { cardMatchesQuery } from "@/lib/card-search";
import type { CreditCardListItem } from "@/server/services/credit-cards";

/** Below this, the whole set is visible at a glance and filters just add noise. */
const FILTER_THRESHOLD = 4;

type SortKey = "recommended" | "name" | "bank" | "network";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "recommended", label: "Recommended" },
  { key: "name", label: "Name (A–Z)" },
  { key: "bank", label: "Bank (A–Z)" },
  { key: "network", label: "Network" },
];

// "recommended" keeps the server's order (favourite → default → oldest); the
// others re-sort but stay stable within ties by that same server order.
function sortCards(cards: CreditCardListItem[], key: SortKey): CreditCardListItem[] {
  if (key === "recommended") return cards;
  const by = (c: CreditCardListItem) => (key === "name" ? c.nickname : key === "bank" ? c.bank : networkLabel(c.network));
  return [...cards].sort((a, b) => by(a).localeCompare(by(b)));
}

export function CardList({ cards }: { cards: CreditCardListItem[] }) {
  const [query, setQuery] = useState("");
  const [network, setNetwork] = useState<CardNetwork | "">("");
  const [sort, setSort] = useState<SortKey>("recommended");
  const [showArchived, setShowArchived] = useState(false);

  // Only networks actually present — offering "Diners" to someone who has none
  // is a filter that can only ever return nothing.
  const networks = useMemo(() => [...new Set(cards.map((c) => c.network))], [cards]);

  const matched = useMemo(
    () => cards.filter((c) => (network === "" || c.network === network) && cardMatchesQuery(c, query)),
    [cards, network, query]
  );
  const active = useMemo(() => sortCards(matched.filter((c) => !c.isArchived), sort), [matched, sort]);
  const archived = useMemo(() => sortCards(matched.filter((c) => c.isArchived), sort), [matched, sort]);

  const showFilters = cards.length >= FILTER_THRESHOLD;

  return (
    <>
      {showFilters && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2 flex-wrap items-center">
            <input
              className="field flex-1 min-w-[180px]"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search cards"
              aria-label="Search cards"
            />
            <select className="field w-auto" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort cards">
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          {networks.length > 1 && (
            <div className="flex gap-1.5 flex-wrap">
              <FilterChip active={network === ""} onClick={() => setNetwork("")}>
                All
              </FilterChip>
              {networks.map((n) => (
                <FilterChip key={n} active={network === n} onClick={() => setNetwork(n)}>
                  {networkLabel(n)}
                </FilterChip>
              ))}
            </div>
          )}
        </div>
      )}

      {active.length === 0 && archived.length === 0 ? (
        <div className="card px-4 py-1.5">
          <EmptyState icon="🔎" title="No cards match" detail="Try a different name, bank, or the last four digits." />
        </div>
      ) : (
        <ul className="flex flex-col gap-2 list-none p-0 m-0">
          {active.map((card) => (
            <CardRow key={card.id} card={card} />
          ))}
        </ul>
      )}

      {archived.length > 0 && (
        <div className="flex flex-col gap-2">
          <button
            onClick={() => setShowArchived((s) => !s)}
            aria-expanded={showArchived}
            className="self-start flex items-center gap-1.5 text-[12px] font-bold text-mut cursor-pointer bg-transparent border-none px-0"
          >
            <span className="text-[10px]">{showArchived ? "▾" : "▸"}</span>
            Archived ({archived.length})
          </button>
          {showArchived && (
            <ul className="flex flex-col gap-2 list-none p-0 m-0">
              {archived.map((card) => (
                <CardRow key={card.id} card={card} archived />
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

function CardRow({ card, archived }: { card: CreditCardListItem; archived?: boolean }) {
  return (
    <li>
      <Link
        href={`/cards/${card.id}`}
        className={`relative flex items-center gap-3 rounded-[14px] border border-line bg-card p-2.5 no-underline text-ink active:scale-[.99] transition-transform ${
          archived ? "opacity-65" : ""
        }`}
      >
        <CardThumb card={card} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[13.5px] font-extrabold text-ink truncate">{card.nickname}</span>
            {card.isDefault && (
              <span className="text-[9px] font-bold uppercase tracking-wide text-acc bg-accsoft rounded px-1.5 py-0.5 flex-none">Default</span>
            )}
            {card.isExpired && (
              <span className="text-[9px] font-bold uppercase tracking-wide text-red rounded px-1.5 py-0.5 flex-none" style={{ background: "var(--redSoft)" }}>
                Expired
              </span>
            )}
          </div>
          <div className="text-[11.5px] text-mut2 truncate mt-0.5">
            {card.bank} · <span className="font-mono tabular-nums">•••• {card.last4}</span> · {networkLabel(card.network)}
          </div>
        </div>
        {!archived && <RowFavorite card={card} />}
        <svg className="flex-none text-mut2" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m9 18 6-6-6-6" />
        </svg>
      </Link>
    </li>
  );
}

/** A small gradient chip that carries the card's visual identity in a row — the
 *  full face lives on the detail screen. */
function CardThumb({ card }: { card: CreditCardListItem }) {
  return (
    <span
      className="relative flex-none w-[58px] h-[38px] rounded-[8px] overflow-hidden grid content-between p-1.5"
      style={{ background: cardGradient(card.color, card.network), boxShadow: "var(--sh)" }}
      aria-hidden
    >
      <span className="w-[15px] h-[11px] rounded-[2px] bg-white/70 border border-white/40" />
      <span className="text-[7.5px] font-extrabold tracking-wide text-white/95 justify-self-end leading-none">{networkLabel(card.network)}</span>
    </span>
  );
}

/** Quick pin/unpin without leaving the wallet. Nested inside the row's Link, so
 *  it swallows the click that would otherwise navigate to the detail screen. */
function RowFavorite({ card }: { card: CreditCardListItem }) {
  const router = useRouter();
  const { showToast } = useUI();
  const [busy, setBusy] = useState(false);

  async function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    const next = !card.isFavorite;
    const res = await setCreditCardFavoriteAction(card.id, next);
    setBusy(false);
    if (res.ok) {
      showToast(next ? "Pinned to favorites" : "Removed from favorites");
      router.refresh();
    } else {
      showToast(res.error ?? "Something went wrong");
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      aria-pressed={card.isFavorite}
      aria-label={card.isFavorite ? "Remove from favorites" : "Add to favorites"}
      title={card.isFavorite ? "Remove from favorites" : "Add to favorites"}
      className="flex-none w-8 h-8 grid place-items-center rounded-full text-[15px] leading-none cursor-pointer border-none bg-transparent hover:bg-accsoft disabled:opacity-60 transition-colors"
      style={{ color: card.isFavorite ? "#f5b301" : "var(--mut2)" }}
    >
      {card.isFavorite ? "★" : "☆"}
    </button>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className="px-2.5 py-1.5 rounded-full text-[11.5px] font-bold cursor-pointer whitespace-nowrap"
      style={{
        border: `1px solid ${active ? "var(--acc)" : "var(--line2)"}`,
        background: active ? "var(--acc)" : "transparent",
        color: active ? "#fff" : "var(--mut)",
      }}
    >
      {children}
    </button>
  );
}
