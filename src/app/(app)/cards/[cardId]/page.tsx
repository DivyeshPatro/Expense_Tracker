// A single card's dedicated screen: the full face, one clear primary action
// (Show details → password → reveal → checkout), a quiet Manage group, and this
// card's own activity feed.
//
// Same secrecy contract as the wallet index: the number, CVV and expiry never
// reach this RSC payload. listCreditCards returns metadata + last4 only, and we
// pick this card from it — a reveal is still an explicit, password-gated action
// handled entirely client-side (card-detail.tsx). force-dynamic keeps the
// metadata out of the static cache; a reveal was never in it to begin with.

import { notFound } from "next/navigation";
import Link from "next/link";
import { ModuleActivity } from "@/components/shell/module-activity";
import { listCreditCards } from "@/server/services/credit-cards";
import { requireUser } from "@/server/session";
import { CardDetail } from "./card-detail";

export const dynamic = "force-dynamic";

export default async function CardDetailPage({ params }: { params: Promise<{ cardId: string }> }) {
  const { cardId } = await params;
  const user = await requireUser();
  const cards = await listCreditCards(user.id);
  const card = cards.find((c) => c.id === cardId);
  if (!card) notFound();

  return (
    <div className="flex flex-col gap-3.5" style={{ animation: "rise .25s ease" }}>
      <Link href="/cards" className="self-start flex items-center gap-1.5 text-[12.5px] font-bold text-mut no-underline">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m15 18-6-6 6-6" />
        </svg>
        Cards
      </Link>

      <CardDetail card={card} />

      <ModuleActivity entityIds={[card.id]} />
    </div>
  );
}
