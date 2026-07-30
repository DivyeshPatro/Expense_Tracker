"use client";

// A countdown against an absolute deadline.
//
// Shared by the reveal panel's 30-second auto-hide and the checkout helper's
// 60-second window, which are the only two places in Ledgerly where time
// running out is a security property rather than a nicety.
//
// The deadline is fixed at mount and the remaining time is derived from the
// clock on each tick, rather than decrementing a counter. Browsers throttle
// timers in background tabs — a decrementing counter would effectively pause
// while the tab is hidden, so a card would stay revealed for exactly as long
// as you were looking somewhere else, which is the case the timer exists for.

import { useEffect, useRef, useState } from "react";

export function useCountdown(ms: number, onExpire: () => void): number {
  const [remaining, setRemaining] = useState(ms);
  // Held in a ref so a caller passing an inline arrow — which every caller
  // does — doesn't restart the deadline on every render and leave the secret
  // on screen indefinitely.
  const expire = useRef(onExpire);
  expire.current = onExpire;

  useEffect(() => {
    const deadline = Date.now() + ms;
    const id = setInterval(() => {
      const left = deadline - Date.now();
      if (left <= 0) {
        clearInterval(id);
        setRemaining(0);
        expire.current();
        return;
      }
      setRemaining(left);
    }, 250);
    return () => clearInterval(id);
  }, [ms]);

  return remaining;
}
