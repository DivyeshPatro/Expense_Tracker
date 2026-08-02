"use client";

// Keeps System mode live: when the OS flips light/dark while the app is open,
// update data-theme — but only if the user is on System (an explicit light/dark
// choice must stick). Initial paint is handled by the bootstrap in layout.tsx.

import { useEffect } from "react";

export function ThemeSync() {
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (document.documentElement.dataset.mode === "system") {
        document.documentElement.dataset.theme = mq.matches ? "dark" : "light";
      }
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return null;
}
