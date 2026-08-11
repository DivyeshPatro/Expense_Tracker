// Credit Cards.
//
// One job: never take the physical card out of your wallet to pay online. Not a
// spend tracker, not a vault for arbitrary secrets — cards, and what you need
// to type into a checkout form.
//
// Nothing secret reaches this page. listCreditCards returns metadata and last4
// only; the number, CVV and expiry stay encrypted until an explicit reveal that
// asks for the account password. That matters here specifically because
// next.config.ts sets staleTimes.dynamic to 30s, so this RSC payload lives in
// the client router cache after you navigate away.

import { EmptyState } from "@/components/shell/empty-state";
import { ModuleTabs, CARDS_TABS } from "@/components/shell/module-tabs";
import { AddCardButton } from "./card-actions";
import { CardList } from "./card-list";
import { listCreditCards } from "@/server/services/credit-cards";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export const metadata = { title: "Cards" };

export default async function CardsPage() {
  const user = await requireUser();
  const cards = await listCreditCards(user.id);

  if (cards.length === 0) {
    return (
      <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
        <ModuleTabs tabs={CARDS_TABS} />
        <div className="card px-4 py-1.5">
          <EmptyState
            icon="💳"
            title="Save your cards, ready when you need them"
            detail="Add a card once and pay online without digging out your wallet. Everything's encrypted and only shown after you re-enter your password."
            action={<AddCardButton label="Add your first card" />}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      <ModuleTabs tabs={CARDS_TABS} />
      {/* #189: the wallet is the content — the cards themselves carry the
          visual weight, as in Apple/Google Wallet. It still needs a headline
          though: before this the largest text on the screen was 15px, so
          nothing read as the title. */}
      <div className="flex items-end justify-between gap-2">
        <div>
          <h1 className="text-[21px] font-extrabold tracking-[-.02em] m-0">Your wallet</h1>
          <p className="text-[12.5px] text-mut mt-1 mb-0">
            {cards.filter((c) => !c.isArchived).length} card{cards.filter((c) => !c.isArchived).length === 1 ? "" : "s"} ready to pay with
          </p>
        </div>
        <AddCardButton />
      </div>
      <CardList cards={cards} />
    </div>
  );
}
