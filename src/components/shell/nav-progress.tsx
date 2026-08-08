"use client";

// Issue #214 — acknowledge the tap immediately.
//
// Route skeletons (each route's loading.tsx) already exist and work, but they
// cannot render until the RSC payload for the new route begins streaming.
// Measured in the production build at 390px with a 150 ms RTT / 1.6 Mbps /
// 4× CPU throttle, that left the user looking at the OLD screen with no
// acknowledgement for:
//
//     Spending 912 ms · Cards 418 ms · People 381 ms
//
// The tap is a fact the client knows instantly; it should not wait on the
// network to say so. This is a 2px indeterminate bar that appears the moment a
// nav link is pressed and clears when the pathname actually changes.
//
// Deliberately not a spinner: a spinner in the content area competes with the
// skeleton that arrives moments later. A hairline at the top edge is the one
// thing that can coexist with both the old screen and the incoming one.

import { usePathname, useSearchParams } from "next/navigation";
import { createContext, useContext, useEffect, useRef } from "react";

const NavProgressContext = createContext<() => void>(() => {});

/** Call in a nav link's onClick to start the bar. */
export function useStartNavProgress() {
  return useContext(NavProgressContext);
}

const ACTIVE = "data-active";

export function NavProgressProvider({ children }: { children: React.ReactNode }) {
  const barRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathname = usePathname();
  const search = useSearchParams().toString();

  // The bar is always mounted and shown/hidden by a DOM attribute rather than
  // React state, on purpose. Measured at 390px under a 4x CPU throttle, driving
  // it through setState put first feedback at 460 ms on the slowest hop — the
  // click → setState → re-render → paint chain is itself the cost. Touching the
  // attribute directly gets the acknowledgement onto the screen in the same
  // frame as the tap, which is the entire point of the feature.
  const stop = () => {
    barRef.current?.removeAttribute(ACTIVE);
    if (timer.current) clearTimeout(timer.current);
  };

  const start = () => {
    barRef.current?.setAttribute(ACTIVE, "");
    if (timer.current) clearTimeout(timer.current);
    // Never leave it running if a navigation is abandoned (blocked, cancelled,
    // or the user taps the tab they are already on).
    timer.current = setTimeout(stop, 8000);
  };

  // The destination has rendered — whatever it was, we're done.
  useEffect(() => {
    stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, search]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <NavProgressContext.Provider value={start}>
      <div
        ref={barRef}
        data-nav-progress
        role="progressbar"
        aria-label="Loading page"
        className="fixed top-0 inset-x-0 h-[2px] z-[70] overflow-hidden print:hidden opacity-0 data-[active]:opacity-100"
        style={{ background: "var(--accSoft)" }}
      >
        <span className="block h-full w-2/5 rounded-full" style={{ background: "var(--acc)", animation: "nav-progress 1.1s ease-in-out infinite" }} />
      </div>
      {children}
    </NavProgressContext.Provider>
  );
}
