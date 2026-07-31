"use client";

// The gallery, with search and network filters.
//
// Filtering happens in the browser, not the database. A person has a handful of
// cards, they are already all on the page, and a round trip per keystroke would
// make the search feel slower than reading the four cards in front of you. It
// also keeps the query out of the URL, which matters here: "?q=hdfc platinum"
// would land in browser history and referrer headers.
//
// The controls only appear once there are enough cards for them to help. With
// three cards a filter bar is furniture.

import { useMemo, useState } from "react";
import { EmptyState } from "@/components/shell/empty-state";
import { networkLabel, type CardNetwork } from "@/lib/card-identity";
import { cardMatchesQuery } from "@/lib/card-search";
import type { CreditCardListItem } from "@/server/services/credit-cards";
import { CardActions } from "./card-actions";
import { CardFace, KeyMismatchNotice } from "./card-face";

/** Below this, the whole set is visible at a glance and filters just add noise. */
const FILTER_THRESHOLD = 4;

export function CardGallery({ cards }: { cards: CreditCardListItem[] }) {
  const [query, setQuery] = useState("");
  const [network, setNetwork] = useState<CardNetwork | "">("");

  // Only networks actually present — offering "Diners" to someone who has none
  // is a filter that can only ever return nothing.
  const networks = useMemo(() => {
    const seen = new Set(cards.map((c) => c.network));
    return [...seen];
  }, [cards]);

  const visible = useMemo(
    () => cards.filter((c) => (network === "" || c.network === network) && cardMatchesQuery(c, query)),
    [cards, network, query]
  );

  const showFilters = cards.length >= FILTER_THRESHOLD;

  return (
    <>
      {showFilters && (
        <div className="flex gap-2 flex-wrap items-center">
          <input
            className="field flex-1 min-w-[180px]"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search cards"
            aria-label="Search cards"
          />
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

      {visible.length === 0 ? (
        <div className="card px-4 py-1.5">
          <EmptyState icon="🔎" title="No cards match" detail="Try a different name, bank, or the last four digits." />
        </div>
      ) : (
        <div className="grid gap-3.5 grid-cols-[repeat(auto-fill,minmax(290px,1fr))]">
          {visible.map((card) => (
            <div key={card.id} className="flex flex-col">
              <CardFace card={card} />
              {!card.keyMatches && <KeyMismatchNotice />}
              <div className="mt-2.5">
                <CardActions card={card} />
              </div>
            </div>
          ))}
        </div>
      )}
    </>
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
