"use client";

// Next's client router occasionally drops a soft navigation silently on
// heavier force-dynamic routes: the RSC fetch completes with a valid
// response but the router never commits it — no URL change, no re-render,
// no console error. Benchmarked against 280 navigations under a large
// dataset (see period-picker.tsx's original repro): a router.replace()
// retry recovered 0 of the stuck cases (every stuck push either commits
// within ~150ms or never commits at all — there's no middle zone a retry
// could catch), so it only added a wasted RSC round trip. A single hard
// navigation after a short grace period is the last-resort safety net.
//
// Call this at the moment a navigation is initiated (e.g. a Link's onClick,
// without calling preventDefault so the router's own soft nav still runs
// normally) or right after a router.push(). It only fires the hard nav if
// the URL truly hasn't changed by the time the grace period elapses, so a
// user who's since navigated elsewhere on their own is left alone.
// #211/#214: the grace period was 500 ms, tuned on a fast local connection
// where a soft nav commits in ~150 ms or never. That assumption does not hold
// on a real phone. Measured in the production build at 390px under a 150 ms
// RTT / 1.6 Mbps / 4x CPU throttle, perfectly healthy soft navigations changed
// the URL at:
//
//     Cards 447 ms · People 596 ms · Dashboard 660 ms · Spending 909 ms
//
// — so on a slow connection this net was firing on almost every tab tap,
// converting a client navigation into a full document reload: the router
// cache discarded, the document re-fetched, hydration re-run. It made the
// slowest navigations dramatically slower, which is the opposite of its
// intent. 3 s sits well clear of a legitimate slow navigation while still
// recovering a genuinely stuck one long before a user would retry by hand.
export function armStuckNavFallback(href: string, graceMs = 3000) {
  const before = window.location.pathname + window.location.search;
  window.setTimeout(() => {
    const stillHere = window.location.pathname + window.location.search === before;
    if (!stillHere) return;
    window.location.assign(href);
  }, graceMs);
}
