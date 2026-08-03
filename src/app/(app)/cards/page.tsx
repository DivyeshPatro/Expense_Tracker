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
import { ModuleActivity } from "@/components/shell/module-activity";
import { AddCardButton } from "./card-actions";
import { CardGallery } from "./card-gallery";
import { listCreditCards } from "@/server/services/credit-cards";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function CardsPage() {
  const user = await requireUser();
  const cards = await listCreditCards(user.id);

  if (cards.length === 0) {
    return (
      <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
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
      <div className="flex justify-end">
        <AddCardButton />
      </div>
      <CardGallery cards={cards} />
      <ModuleActivity entities={["CreditCard"]} />
    </div>
  );
}
